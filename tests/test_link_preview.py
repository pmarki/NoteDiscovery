"""Cards for links: fetching a page's preview, keeping it in .links/, and not reaching inside."""

import gzip
import io
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import link_preview, main
from backend.link_preview import (
    BlockedAddress,
    LinkPreviews,
    PreviewError,
    fetch,
    normalize_url,
    parse_page,
    public_address,
)


def png(size=(1600, 900)):
    out = io.BytesIO()
    Image.new("RGB", size, "teal").save(out, "PNG")
    return out.getvalue()


PAGE = """<!doctype html><html><head><meta charset="utf-8">
<title>Plain title</title>
<meta property="og:title" content="Card &amp; title">
<meta property="og:description" content="  What the
page is about  ">
<meta property="og:site_name" content="Example">
<meta property="og:image" content="/cover.png">
<link rel="icon" href="/icon.png">
</head><body><p>Hi</p></body></html>"""


class Site(BaseHTTPRequestHandler):
    routes = {}

    def do_GET(self):
        route = self.routes.get(self.path)
        if route is None:
            self.send_response(404)
            self.end_headers()
            return
        status, headers, body = route
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture
def site():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    Site.routes = {
        "/page": (200, {"Content-Type": "text/html; charset=utf-8"}, PAGE.encode()),
        "/gzipped": (200, {"Content-Type": "text/html", "Content-Encoding": "gzip"}, gzip.compress(PAGE.encode())),
        "/cover.png": (200, {"Content-Type": "image/png"}, png()),
        "/icon.png": (200, {"Content-Type": "image/png"}, png((128, 128))),
        "/moved": (302, {"Location": "/page"}, b""),
        "/doc.pdf": (200, {"Content-Type": "application/pdf"}, b"%PDF-1.4"),
        "/script.png": (200, {"Content-Type": "image/png"}, b"<script>alert(1)</script>"),
    }
    yield base
    server.shutdown()


# The test site is on 127.0.0.1, which the app itself would refuse
only_test_site = lambda address: address == "127.0.0.1"  # noqa: E731


def test_a_page_gives_its_card_and_keeps_it(site, tmp_path):
    previews = LinkPreviews(tmp_path, allowed=only_test_site)

    entry = previews.get(f"{site}/page")

    assert entry["title"] == "Card & title"
    assert entry["description"] == "What the page is about"
    assert entry["site_name"] == "Example"
    assert entry["error"] is None
    assert entry["image"] and entry["icon"]
    stored = sorted(path.name for path in (tmp_path / ".links").iterdir())
    assert len(stored) == 3
    with Image.open(previews.file(next(name for name in stored if name.endswith(".webp")))) as image:
        assert image.format == "WEBP" and max(image.size) <= 800

    # Read from .links/ from now on, even with the site gone
    Site.routes.clear()
    assert previews.get(f"{site}/page")["title"] == "Card & title"


def test_refresh_fetches_again(site, tmp_path):
    previews = LinkPreviews(tmp_path, allowed=only_test_site)
    previews.get(f"{site}/page")
    Site.routes["/page"] = (200, {"Content-Type": "text/html"}, b"<title>New</title>")

    entry = previews.get(f"{site}/page", refresh=True)

    assert entry["title"] == "New"
    # The old image isn't left behind once the page stops offering it
    assert not entry["image"]
    assert not list((tmp_path / ".links").glob("*.webp"))


def test_compressed_pages_and_redirects_are_followed(site, tmp_path):
    previews = LinkPreviews(tmp_path, allowed=only_test_site)

    assert previews.get(f"{site}/gzipped")["title"] == "Card & title"
    assert previews.get(f"{site}/moved")["title"] == "Card & title"


def test_a_file_that_isnt_a_page_is_named_after_itself(site, tmp_path):
    entry = LinkPreviews(tmp_path, allowed=only_test_site).get(f"{site}/doc.pdf")

    assert entry["title"] == "doc.pdf"
    assert entry["error"] is None


def test_an_image_that_isnt_one_is_not_stored(site, tmp_path):
    Site.routes["/page"] = (200, {"Content-Type": "text/html"},
                            b'<title>T</title><meta property="og:image" content="/script.png">')

    entry = LinkPreviews(tmp_path, allowed=only_test_site).get(f"{site}/page")

    assert entry["title"] == "T" and not entry["image"]


def test_a_missing_page_is_remembered_as_failed(site, tmp_path):
    entry = LinkPreviews(tmp_path, allowed=only_test_site).get(f"{site}/nothing")

    assert entry["error"] == "The site answered 404"
    assert entry["title"] == ""


@pytest.mark.parametrize("address", [
    "127.0.0.1", "10.1.2.3", "192.168.1.10", "172.16.0.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "224.0.0.1",
])
def test_private_addresses_are_refused(address):
    assert not public_address(address)


def test_public_addresses_are_allowed():
    assert public_address("93.184.215.14")
    assert public_address("2606:4700::1111")


def test_the_server_never_fetches_its_own_network(site, tmp_path):
    # The default check, as the app uses it
    entry = LinkPreviews(tmp_path).get(f"{site}/page")

    assert "own network" in entry["error"]
    with pytest.raises(BlockedAddress):
        fetch(f"{site}/page", limit=1000, accept="text/html")


def test_a_redirect_into_the_network_is_refused(site):
    # 127.0.0.2 is loopback too, so only the first hop is allowed
    port = site.rsplit(":", 1)[1]
    Site.routes["/away"] = (302, {"Location": f"http://127.0.0.2:{port}/page"}, b"")

    with pytest.raises(BlockedAddress):
        fetch(f"{site}/away", limit=1000, accept="text/html", allowed=only_test_site)


@pytest.mark.parametrize("url", ["ftp://example.com/x", "javascript:alert(1)", "file:///etc/passwd", "/notes/a.md", "https://"])
def test_only_web_addresses_have_previews(url):
    with pytest.raises(PreviewError):
        normalize_url(url)


def test_the_fragment_is_not_part_of_the_page():
    assert normalize_url("HTTPS://example.com/a#part") == "https://example.com/a"


def test_parsing_falls_back_to_the_title_and_favicon():
    found = parse_page("<html><head><title> Just\n a title </title></head></html>", "https://example.com/a/b")

    assert found["title"] == "Just a title"
    assert found["image"] == ""
    assert found["icon"] == "https://example.com/favicon.ico"


def test_only_stored_names_are_served(tmp_path):
    previews = LinkPreviews(tmp_path)
    (tmp_path / ".links").mkdir()
    (tmp_path / ".links" / ("a" * 32 + ".webp")).write_bytes(b"x")

    assert previews.file("a" * 32 + ".webp") is not None
    assert previews.file("../config.yaml") is None
    assert previews.file("a" * 32 + ".json") is None


def test_the_api_answers_with_image_addresses(site, tmp_path, monkeypatch):
    monkeypatch.setitem(main.config["storage"], "notes_dir", str(tmp_path))
    monkeypatch.setattr(main, "LINK_PREVIEWS_ALLOW_PRIVATE", True)
    client = TestClient(main.app)

    preview = client.get("/api/link-previews", params={"url": f"{site}/page"}).json()

    assert preview["title"] == "Card & title"
    assert preview["image"].startswith("/api/link-previews/files/")
    image = client.get(preview["image"])
    assert image.status_code == 200
    assert image.headers["content-type"] == "image/webp"
    assert client.get("/api/link-previews", params={"url": "ftp://x"}).status_code == 400


def test_the_api_refuses_the_network_by_default(site, tmp_path, monkeypatch):
    monkeypatch.setitem(main.config["storage"], "notes_dir", str(tmp_path))
    client = TestClient(main.app)

    preview = client.get("/api/link-previews", params={"url": f"{site}/page"}).json()

    assert preview["title"] == "" and "own network" in preview["error"]


def test_the_frontend_knows_whether_cards_are_on():
    assert TestClient(main.app).get("/api/config").json()["linkPreviews"] is True

