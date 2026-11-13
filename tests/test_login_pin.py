"""PIN login, "Remember this device", and the backoff after wrong tries."""

import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.login_guard import LoginGuard, client_ip, parse_trusted_proxies


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def fake_request(peer, headers=None):
    return SimpleNamespace(client=SimpleNamespace(host=peer), headers=headers or {})


# --- the guard on its own -------------------------------------------------

def test_three_free_tries_then_doubling_waits_up_to_fifteen_minutes():
    clock = Clock()
    guard = LoginGuard(clock)
    waits = []
    for _ in range(10):
        guard.record_failure("a")
        waits.append(guard.wait_seconds("a"))
        clock.now += waits[-1]

    assert waits == [0, 0, 30, 60, 120, 240, 480, 900, 900, 900]


def test_a_wait_runs_down_and_other_clients_are_not_affected():
    clock = Clock()
    guard = LoginGuard(clock)
    for _ in range(3):
        guard.record_failure("a")

    clock.now += 10
    assert guard.wait_seconds("a") == 20
    assert guard.wait_seconds("b") == 0
    clock.now += 20
    assert guard.wait_seconds("a") == 0


def test_success_and_a_quiet_day_start_the_count_again():
    clock = Clock()
    guard = LoginGuard(clock)
    for _ in range(2):
        guard.record_failure("a")
    guard.record_success("a")
    guard.record_failure("a")
    assert guard.wait_seconds("a") == 0

    guard.record_failure("a")
    clock.now += 24 * 3600
    guard.record_failure("a")
    assert guard.wait_seconds("a") == 0


def test_many_clients_together_hit_the_global_cap():
    clock = Clock()
    guard = LoginGuard(clock)
    hits = [guard.record_failure(f"client-{n}") for n in range(20)]

    assert hits.count(True) == 1 and hits[-1]
    assert guard.wait_seconds("someone-new") == 3600
    clock.now += 3600
    assert guard.wait_seconds("someone-new") == 0


def test_the_forwarded_address_counts_only_from_a_trusted_proxy():
    proxies = parse_trusted_proxies(["172.16.0.0/12", "not an address"])
    headers = {"cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 10.0.0.1"}

    assert client_ip(fake_request("172.18.0.5", headers), proxies) == "203.0.113.7"
    assert client_ip(fake_request("172.18.0.5", {"x-forwarded-for": "198.51.100.1, 10.0.0.1"}), proxies) == "198.51.100.1"
    assert client_ip(fake_request("8.8.8.8", headers), proxies) == "8.8.8.8"
    assert client_ip(fake_request("172.18.0.5", headers), []) == "172.18.0.5"


# --- the login route ------------------------------------------------------

@pytest.fixture
def pin_app(monkeypatch):
    auth = dict(main.config['authentication'])
    auth.update(enabled=True, pin_hash=main.hash_pin("482913"),
                password_hash=main.bcrypt.hashpw(b"secret-password", main.bcrypt.gensalt()).decode())
    monkeypatch.setitem(main.config, 'authentication', auth)
    monkeypatch.setattr(main, 'login_guard', LoginGuard())
    return TestClient(main.app)


def login(client, secret, remember=False):
    data = {"password": secret}
    if remember:
        data["remember"] = "1"
    return client.post("/login", data=data, follow_redirects=False)


def logged_in(client):
    return client.get("/api/notes").status_code == 200


def test_invalid_pins_are_ignored():
    assert main.hash_pin("482913")
    assert main.hash_pin(" 1234 ")
    for pin in ("", "123", "1234567", "12ab", "١٢٣٤", None):
        assert main.hash_pin(pin) == ""


def test_the_login_page_asks_for_the_pin(pin_app):
    page = pin_app.get("/login").text
    assert 'data-login-mode="pin"' in page
    assert 'name="remember"' in page


def test_the_pin_logs_in_and_the_password_does_not(pin_app):
    response = login(pin_app, "secret-password")
    assert response.headers["location"] == "/login?error=incorrect_pin"
    assert not logged_in(pin_app)

    response = login(pin_app, "482913")
    assert response.headers["location"] == "/"
    assert logged_in(pin_app)


def test_the_third_wrong_pin_locks_and_even_the_right_one_waits(pin_app):
    assert login(pin_app, "000000").headers["location"] == "/login?error=incorrect_pin"
    assert login(pin_app, "000001").headers["location"] == "/login?error=incorrect_pin"
    assert login(pin_app, "000002").headers["location"] == "/login?error=locked&wait=30"
    assert login(pin_app, "482913").headers["location"].startswith("/login?error=locked&wait=")
    assert not logged_in(pin_app)


def test_without_remember_the_login_ends_after_the_short_session(pin_app, monkeypatch):
    login(pin_app, "482913")
    assert logged_in(pin_app)

    later = time.time() + main.SHORT_SESSION_SECONDS + 1
    monkeypatch.setattr(main.time, "time", lambda: later)
    assert not logged_in(pin_app)
    assert pin_app.get("/login", follow_redirects=False).status_code == 200


def test_a_remembered_login_outlasts_the_short_session(pin_app, monkeypatch):
    login(pin_app, "482913", remember=True)

    later = time.time() + main.SHORT_SESSION_SECONDS + 1
    monkeypatch.setattr(main.time, "time", lambda: later)
    assert logged_in(pin_app)


def test_without_a_pin_the_password_still_works(pin_app):
    main.config['authentication']['pin_hash'] = ''
    assert 'data-login-mode="password"' in pin_app.get("/login").text
    assert login(pin_app, "482913").headers["location"] == "/login?error=incorrect_password"
    assert login(pin_app, "secret-password").headers["location"] == "/"
