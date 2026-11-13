"""Logins vouched for by Cloudflare Access.

Behind Access, Cloudflare adds a JWT signed with the team's keys to every request it
lets through (Cf-Access-Jwt-Assertion). A request whose token checks out needs no
PIN or password; anything else, such as a visit on the local network, gets the login
page. The plain Cf-Access-Authenticated-User-Email header is never trusted: anyone who
can reach the port directly could send it.
"""

import json
import logging
import threading
import time
import urllib.request

import jwt

logger = logging.getLogger("uvicorn.error")

TOKEN_HEADER = 'cf-access-jwt-assertion'
KEYS_MAX_AGE = 3600      # Cloudflare rotates its keys every six weeks, with overlap
REFETCH_AFTER = 60       # an unknown key id refetches at most this often
FETCH_TIMEOUT = 5
LEEWAY = 30              # seconds of clock difference allowed on exp/nbf/iat


def normalize_team_domain(value: str) -> str:
    """'https://myteam.cloudflareaccess.com/' -> 'myteam.cloudflareaccess.com'"""
    value = str(value or '').strip().lower()
    for prefix in ('https://', 'http://'):
        value = value.removeprefix(prefix)
    return value.split('/')[0]


class AccessVerifier:
    def __init__(self, team_domain: str, aud: str, allowed_emails=(), fetch=None, clock=time.time):
        self.team_domain = normalize_team_domain(team_domain)
        self.issuer = f"https://{self.team_domain}"
        self.certs_url = f"{self.issuer}/cdn-cgi/access/certs"
        self.aud = aud.strip()
        self.allowed_emails = {e.strip().lower() for e in allowed_emails or () if e.strip()}
        self.fetch = fetch or self._fetch
        self.clock = clock
        self.keys = {}          # kid -> key
        self.fetched_at = None
        self.lock = threading.Lock()

    def _fetch(self) -> dict:
        request = urllib.request.Request(self.certs_url, headers={'User-Agent': 'KeepIt'})
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
            return json.loads(response.read())

    def _key(self, kid: str):
        with self.lock:
            now = self.clock()
            stale = self.fetched_at is None or now - self.fetched_at >= KEYS_MAX_AGE
            missing = kid not in self.keys and (self.fetched_at is None or now - self.fetched_at >= REFETCH_AFTER)
            if stale or missing:
                try:
                    keys = jwt.PyJWKSet.from_dict(self.fetch()).keys
                    self.keys = {key.key_id: key.key for key in keys if key.key_id}
                except Exception as e:
                    # Keep the old keys; the login page still works meanwhile
                    logger.warning("Could not fetch Cloudflare Access keys from %s: %s", self.certs_url, e)
                self.fetched_at = now
            return self.keys.get(kid)

    def verify(self, token: str):
        """The token's claims when Access issued it for this app and lets this user
        in, else None. Blocking: it may fetch the keys."""
        if not token:
            return None
        try:
            kid = jwt.get_unverified_header(token).get('kid')
            key = self._key(kid) if kid else None
            if key is None:
                return None
            claims = jwt.decode(
                token, key, algorithms=['RS256'], audience=self.aud, issuer=self.issuer,
                leeway=LEEWAY, options={'require': ['exp', 'iat', 'aud', 'iss']},
            )
        except jwt.PyJWTError:
            return None
        # 'org' is the global session token, meant for Access itself, not for apps
        if claims.get('type', 'app') != 'app':
            return None
        # A user is listed by email; a service token, which has none, by its Client ID
        who = claims.get('email') or claims.get('common_name') or ''
        if self.allowed_emails and str(who).lower() not in self.allowed_emails:
            return None
        return claims
