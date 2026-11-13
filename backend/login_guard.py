"""Backoff for wrong passwords and PINs.

Each client (IP + User-Agent) gets a few free tries, then waits longer after every
failure. Changing the User-Agent makes a new client, so failures from everyone also
count toward a global cap that stops login for all until the hour's failures age out.
State is in memory: the app runs a single worker.
"""

import hashlib
import ipaddress
import time
from collections import deque

FREE_TRIES = 3
FIRST_WAIT = 30            # seconds, after the first failure past the free ones
MAX_WAIT = 15 * 60
FORGET_AFTER = 24 * 3600   # a client's count is dropped after this long without failures
GLOBAL_WINDOW = 3600
GLOBAL_MAX_FAILURES = 20


def parse_trusted_proxies(values) -> list:
    """IPs and CIDRs from config; entries that don't parse are skipped."""
    networks = []
    for value in values or []:
        try:
            networks.append(ipaddress.ip_network(str(value).strip(), strict=False))
        except ValueError:
            continue
    return networks


def client_ip(request, trusted_proxies: list) -> str:
    """The peer address, or the address a trusted proxy (cloudflared, nginx) reports."""
    peer = request.client.host if request.client else ''
    try:
        trusted = any(ipaddress.ip_address(peer) in net for net in trusted_proxies)
    except ValueError:
        trusted = False
    if trusted:
        forwarded = (request.headers.get('cf-connecting-ip')
                     or request.headers.get('x-forwarded-for', '').split(',')[0]).strip()
        if forwarded:
            return forwarded
    return peer


def client_key(request, trusted_proxies: list) -> str:
    ip = client_ip(request, trusted_proxies)
    agent = request.headers.get('user-agent', '')
    return hashlib.sha256(f"{ip}|{agent}".encode('utf-8')).hexdigest()


class LoginGuard:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.clients = {}         # key -> (failures, time of last failure)
        self.failures = deque()   # times of recent failures from anyone

    def _prune(self, now):
        while self.failures and now - self.failures[0] >= GLOBAL_WINDOW:
            self.failures.popleft()
        stale = [key for key, (_, last) in self.clients.items() if now - last >= FORGET_AFTER]
        for key in stale:
            del self.clients[key]

    def wait_seconds(self, key: str) -> int:
        """Seconds before this client may try again; 0 when it may try now."""
        now = self.clock()
        self._prune(now)
        wait = 0
        count, last = self.clients.get(key, (0, now))
        if count >= FREE_TRIES:
            wait = max(wait, last + self._lock_for(count) - now)
        if len(self.failures) >= GLOBAL_MAX_FAILURES:
            # Until enough of the hour's failures age out to get back under the cap
            oldest_to_go = self.failures[len(self.failures) - GLOBAL_MAX_FAILURES]
            wait = max(wait, oldest_to_go + GLOBAL_WINDOW - now)
        return max(0, int(-(-wait // 1)))  # rounded up

    @staticmethod
    def _lock_for(count: int) -> int:
        return min(MAX_WAIT, FIRST_WAIT * 2 ** (count - FREE_TRIES))

    def record_failure(self, key: str) -> bool:
        """Count a failure; True when this one hit the global cap."""
        now = self.clock()
        self._prune(now)
        count, _ = self.clients.get(key, (0, now))
        self.clients[key] = (count + 1, now)
        self.failures.append(now)
        return len(self.failures) == GLOBAL_MAX_FAILURES

    def record_success(self, key: str):
        self.clients.pop(key, None)
