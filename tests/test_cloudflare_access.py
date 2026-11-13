"""Requests Cloudflare Access vouches for skip the PIN; everything else gets the login page."""

import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from backend import main
from backend.cloudflare_access import AccessVerifier, normalize_team_domain

TEAM = "myteam.cloudflareaccess.com"
AUD = "a" * 64


def make_key(kid):
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key(), as_dict=True)
    return private, {**public, "kid": kid, "alg": "RS256", "use": "sig"}


KEY, JWK = make_key("k1")
OTHER_KEY, OTHER_JWK = make_key("k2")


def token(key=KEY, kid="k1", **claims):
    now = int(time.time())
    body = {"aud": [AUD], "iss": f"https://{TEAM}", "iat": now, "exp": now + 600,
            "email": "me@example.com", **claims}
    return jwt.encode(body, key, algorithm="RS256", headers={"kid": kid})


class Certs:
    def __init__(self, *jwks):
        self.jwks = list(jwks)
        self.calls = 0

    def __call__(self):
        self.calls += 1
        return {"keys": self.jwks}


def verifier(certs=None, emails=(), clock=time.time):
    return AccessVerifier(f"https://{TEAM}/", AUD, emails, fetch=certs or Certs(JWK), clock=clock)


def test_team_domain_accepts_a_url():
    assert normalize_team_domain(" HTTPS://MyTeam.cloudflareaccess.com/cdn-cgi ") == TEAM


def test_a_token_from_access_for_this_app_is_accepted():
    assert verifier().verify(token())["email"] == "me@example.com"


@pytest.mark.parametrize("bad", [
    token(aud=["someone-elses-app"]),
    token(iss="https://other.cloudflareaccess.com"),
    token(exp=int(time.time()) - 120),
    token(key=OTHER_KEY),                       # signed by a key that isn't the team's
    token(key=OTHER_KEY, kid="k2"),             # with a key id the team doesn't have
    jwt.encode({"aud": [AUD], "iss": f"https://{TEAM}", "exp": int(time.time()) + 600},
               "secret", algorithm="HS256", headers={"kid": "k1"}),
    "not.a.token",
    "",
])
def test_anything_else_is_refused(bad):
    assert verifier().verify(bad) is None


def test_listed_emails_and_service_tokens_only():
    check = verifier(emails=["Me@Example.com", "abc123.access"])
    assert check.verify(token())
    assert check.verify(token(email="someone@example.com")) is None
    # Service tokens carry their Client ID as common_name, and no email
    assert check.verify(token(email=None, sub="", common_name="abc123.access"))
    assert check.verify(token(email=None, sub="", common_name="other.access")) is None


def test_only_application_tokens():
    assert verifier().verify(token(type="app"))
    assert verifier().verify(token(type="org")) is None


def test_unknown_key_ids_refetch_at_most_once_a_minute():
    now = [1000.0]
    certs = Certs(JWK)
    check = verifier(certs, clock=lambda: now[0])
    for _ in range(5):
        check.verify(token(key=OTHER_KEY, kid="k2"))
    assert certs.calls == 1

    # Cloudflare rotates in a new key: picked up once the minute is over
    certs.jwks.append(OTHER_JWK)
    assert check.verify(token(key=OTHER_KEY, kid="k2")) is None
    now[0] += 60
    assert check.verify(token(key=OTHER_KEY, kid="k2"))
    assert certs.calls == 2


def test_unreachable_keys_refuse_without_raising():
    def down():
        raise OSError("no network")
    assert verifier(down).verify(token()) is None


# --- the app ----------------------------------------------------------------

@pytest.fixture
def client(monkeypatch):
    auth = dict(main.config['authentication'])
    auth.update(enabled=True, pin_hash=main.hash_pin("482913"))
    monkeypatch.setitem(main.config, 'authentication', auth)
    monkeypatch.setattr(main, 'CLOUDFLARE_ACCESS', verifier())
    return TestClient(main.app)


def test_through_access_no_pin_is_asked(client):
    headers = {"Cf-Access-Jwt-Assertion": token()}
    assert client.get("/api/notes", headers=headers).status_code == 200
    assert client.get("/login", headers=headers, follow_redirects=False).headers["location"] == "/"


def test_without_access_the_pin_is_asked(client):
    assert client.get("/api/notes").status_code == 401
    assert client.get("/", follow_redirects=False).headers["location"] == "/login"
    assert 'data-login-mode="pin"' in client.get("/login").text


def test_a_forged_email_header_is_not_enough(client):
    headers = {"Cf-Access-Authenticated-User-Email": "me@example.com",
               "Cf-Access-Jwt-Assertion": token(key=OTHER_KEY)}
    assert client.get("/api/notes", headers=headers).status_code == 401


def test_logout_through_access_ends_the_access_login_too(client):
    headers = {"Cf-Access-Jwt-Assertion": token()}
    response = client.post("/logout", headers=headers, follow_redirects=False)
    assert response.headers["location"] == "/cdn-cgi/access/logout"
    assert client.post("/logout", follow_redirects=False).headers["location"] == "/login"
