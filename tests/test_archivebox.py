"""Offline copies of carded links in ArchiveBox, against a fake ArchiveBox server."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from backend import link_preview, main
from backend.archivebox import ArchiveBox, ArchiveBoxError, snapshot_state
from backend.link_preview import LinkPreviews, cache_key

KEY = "secret-token"


class FakeArchiveBox(BaseHTTPRequestHandler):
    added = []
    snapshots = {}  # url -> snapshot
    files = {}      # path -> (content type, body)
    down = False

    def _send(self, status, body=b"", content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        if self.headers.get("X-ArchiveBox-API-Key") != KEY:
            self._send(403, b'{"detail": "Unauthorized"}')
            return False
        return True

    def do_POST(self):
        if self.down:
            return self._send(503)
        if not self._authorized():
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path != "/api/v1/cli/add":
            return self._send(404)
        self.added.append(body)
        self._send(200, json.dumps({"success": True, "errors": [], "result": {}}).encode())

    def do_GET(self):
        if self.down:
            return self._send(503)
        parts = urlsplit(self.path)
        if parts.path == "/api/v1/core/snapshots":
            if not self._authorized():
                return
            url = parse_qs(parts.query)["url"][0]
            items = [self.snapshots[url]] if url in self.snapshots else []
            return self._send(200, json.dumps({"count": len(items), "items": items}).encode())
        if parts.path in self.files:
            content_type, body = self.files[parts.path]
            return self._send(200, body, content_type)
        self._send(404)

    def log_message(self, *args):
        pass


@pytest.fixture
def archivebox():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeArchiveBox)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    FakeArchiveBox.added = []
    FakeArchiveBox.snapshots = {}
    FakeArchiveBox.files = {}
    FakeArchiveBox.down = False
    yield ArchiveBox(f"http://127.0.0.1:{server.server_port}", KEY)
    server.shutdown()


@pytest.fixture
def previews(tmp_path, archivebox, monkeypatch):
    # No page fetching here: every page reads as the same small preview
    monkeypatch.setattr(LinkPreviews, "_read", lambda self, url: {
        "title": "Page", "description": "", "site_name": "", "image": "", "icon": ""})
    monkeypatch.setattr(link_preview, "ARCHIVE_CHECK_SECONDS", 0)
    return LinkPreviews(tmp_path, archive=archivebox)


def finished(url, *results, status="sealed"):
    return {"id": "", "url": url, "timestamp": "1762780000.5", "status": status,
            "created_at": "2026-11-10T10:00:00Z", "archiveresults": list(results)}


def test_a_new_card_is_queued_in_archivebox(previews):
    entry = previews.get("https://example.com/a")

    assert entry["archive"]["status"] == "pending"
    assert FakeArchiveBox.added == [{"urls": ["https://example.com/a"], "tag": "notediscovery", "depth": 0, "update": False}]
    # Not queued again on the next view
    previews.get("https://example.com/a")
    assert len(FakeArchiveBox.added) == 1


def test_a_finished_snapshot_gives_the_card_its_copies(previews):
    url = "https://example.com/a"
    previews.get(url)
    FakeArchiveBox.snapshots[url] = finished(
        url,
        {"extractor": "singlefile", "status": "succeeded", "output": "singlefile.html"},
        {"extractor": "pdf", "status": "succeeded", "output": "output.pdf"},
        {"extractor": "screenshot", "status": "failed", "output": "TimeoutError"},
        {"extractor": "wget", "status": "succeeded", "output": "example.com/a.html"},
    )

    state = previews.get(url)["archive"]

    assert state["status"] == "archived"
    assert state["timestamp"] == "1762780000.5"
    assert state["outputs"] == {"page": "singlefile.html", "pdf": "output.pdf"}


def test_a_snapshot_still_running_stays_pending(previews):
    url = "https://example.com/a"
    previews.get(url)
    FakeArchiveBox.snapshots[url] = finished(
        url,
        {"plugin": "singlefile", "status": "succeeded", "output_files": {"singlefile.html": {}}, "pwd": "/data/archive/1/singlefile"},
        {"plugin": "pdf", "status": "started"},
        status="started",
    )

    state = previews.get(url)["archive"]

    assert state["status"] == "pending"
    # 0.9 keeps each plugin's files in a folder of its own
    assert state["outputs"] == {"page": "singlefile/singlefile.html"}


def test_a_snapshot_with_nothing_usable_failed(previews):
    url = "https://example.com/a"
    previews.get(url)
    FakeArchiveBox.snapshots[url] = finished(url, {"extractor": "singlefile", "status": "failed"})

    assert previews.get(url)["archive"]["status"] == "failed"


def test_archivebox_down_is_retried_later(previews, monkeypatch):
    FakeArchiveBox.down = True
    entry = previews.get("https://example.com/a")
    assert entry["archive"]["status"] == "error"

    FakeArchiveBox.down = False
    previews.get("https://example.com/a")
    assert FakeArchiveBox.added == []  # Not on every view

    monkeypatch.setattr(link_preview, "ARCHIVE_RETRY_SECONDS", -1)
    assert previews.get("https://example.com/a")["archive"]["status"] == "pending"
    assert len(FakeArchiveBox.added) == 1


def test_a_refresh_keeps_the_archive(previews):
    url = "https://example.com/a"
    previews.get(url)
    FakeArchiveBox.snapshots[url] = finished(url, {"extractor": "pdf", "status": "succeeded", "output": "output.pdf"})
    previews.get(url)

    entry = previews.get(url, refresh=True)

    assert entry["archive"]["status"] == "archived"
    assert len(FakeArchiveBox.added) == 1


def test_archiving_again_asks_for_an_update(previews):
    url = "https://example.com/a"
    previews.get(url)
    FakeArchiveBox.snapshots[url] = finished(url, {"extractor": "pdf", "status": "failed"})
    previews.get(url)

    entry = previews.archive_again(url)

    assert entry["archive"]["status"] == "pending"
    assert FakeArchiveBox.added[-1]["update"] is True


def test_links_into_the_network_are_not_archived(tmp_path, archivebox):
    entry = LinkPreviews(tmp_path, archive=archivebox).get("http://127.0.0.1:1/admin")

    assert entry["blocked"] and "archive" not in entry
    assert FakeArchiveBox.added == []


def test_a_wrong_api_key_is_reported(archivebox):
    with pytest.raises(ArchiveBoxError, match="API key"):
        ArchiveBox(archivebox.url, "wrong").submit("https://example.com/")


@pytest.mark.parametrize("path", ["../../etc/passwd", "/etc/passwd", "a/../b", "http://evil/x"])
def test_only_paths_inside_the_snapshot_are_opened(archivebox, path):
    with pytest.raises(ArchiveBoxError):
        archivebox.open_file("0199", "1762780000.5", path)


def test_output_paths_leaving_the_snapshot_are_ignored():
    state = snapshot_state(finished("u", {"extractor": "singlefile", "status": "succeeded", "output": "../../x.html"}))

    assert state["outputs"] == {}


@pytest.fixture
def client(previews, archivebox, tmp_path, monkeypatch):
    monkeypatch.setitem(main.config["storage"], "notes_dir", str(tmp_path))
    monkeypatch.setattr(main, "ARCHIVEBOX", archivebox)
    return TestClient(main.app)


def test_the_api_serves_copies_through_the_app(client):
    url = "https://example.com/a"
    client.get("/api/link-previews", params={"url": url})
    FakeArchiveBox.snapshots[url] = finished(
        url,
        {"extractor": "singlefile", "status": "succeeded", "output": "singlefile.html"},
        {"extractor": "screenshot", "status": "succeeded", "output": "screenshot.png"},
    )
    FakeArchiveBox.files = {
        "/archive/1762780000.5/singlefile.html": ("text/html", b"<script>steal()</script><p>Saved</p>"),
        "/archive/1762780000.5/screenshot.png": ("image/png", b"\x89PNG"),
    }

    preview = client.get("/api/link-previews", params={"url": url}).json()

    key = cache_key(url)
    assert preview["archive"] == {"status": "archived", "copies": {
        "page": f"/api/link-previews/archive/{key}/page",
        "screenshot": f"/api/link-previews/archive/{key}/screenshot",
    }}
    page = client.get(preview["archive"]["copies"]["page"])
    assert page.status_code == 200
    assert b"Saved" in page.content
    # The saved page's scripts never run in the app's origin
    assert page.headers["content-security-policy"].startswith("sandbox;")
    assert "allow-scripts" not in page.headers["content-security-policy"]
    image = client.get(preview["archive"]["copies"]["screenshot"])
    assert image.headers["content-type"] == "image/png"
    assert client.get(f"/api/link-previews/archive/{key}/pdf").status_code == 404
    assert client.get(f"/api/link-previews/archive/{key}/other").status_code == 404
    assert client.get("/api/link-previews/archive/..%2F..%2Fconfig/page").status_code == 404


def test_the_api_retries_a_copy(client):
    url = "https://example.com/a"
    client.get("/api/link-previews", params={"url": url})

    answer = client.post("/api/link-previews/archive", params={"url": url})

    assert answer.status_code == 200
    assert answer.json()["archive"]["status"] == "pending"


def test_without_archivebox_cards_say_nothing_about_copies(previews, tmp_path, monkeypatch):
    monkeypatch.setitem(main.config["storage"], "notes_dir", str(tmp_path))
    monkeypatch.setattr(main, "ARCHIVEBOX", None)
    client = TestClient(main.app)

    assert "archive" not in client.get("/api/link-previews", params={"url": "https://example.com/a"}).json()
    assert client.get("/api/config").json()["linkArchive"] is False
    assert client.post("/api/link-previews/archive", params={"url": "https://example.com/a"}).status_code == 404


def test_copies_of_0_9_snapshots_are_read_by_snapshot_id(client):
    url = "https://example.com/b"
    client.get("/api/link-previews", params={"url": url})
    snapshot = finished(url, {"plugin": "pdf", "status": "succeeded", "output_str": "pdf/output.pdf",
                              "output_files": {"output.pdf": {}, "preview.png": {}},
                              "pwd": "/data/archive/users/admin/snapshots/20261110/example.com/06af32aa/pdf"})
    snapshot["id"] = "06af32aa06267239800064a1e08cd108"
    FakeArchiveBox.snapshots[url] = snapshot
    FakeArchiveBox.files = {"/snapshot/06af32aa06267239800064a1e08cd108/pdf/output.pdf": ("application/pdf", b"%PDF-1.7")}

    preview = client.get("/api/link-previews", params={"url": url}).json()
    copy = client.get(preview["archive"]["copies"]["pdf"])

    assert copy.status_code == 200
    assert copy.content == b"%PDF-1.7"
    assert copy.headers["content-type"] == "application/pdf"
