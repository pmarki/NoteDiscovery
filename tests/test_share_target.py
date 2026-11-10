"""Android shares reach the app through share_target in the manifest."""

import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend import main
from backend.utils import ALL_MEDIA_EXTENSIONS

FRONTEND = Path(__file__).parent.parent / "frontend"


def manifest():
    return json.loads((FRONTEND / "manifest.json").read_text(encoding="utf-8"))


def test_the_manifest_takes_shares_as_a_form():
    target = manifest()["share_target"]

    assert target["action"] == "/share-target"
    assert target["method"] == "POST"
    assert target["enctype"] == "multipart/form-data"
    assert set(target["params"]) >= {"title", "text", "url", "files"}


def test_shared_files_are_ones_the_app_can_store():
    # A wildcard would offer the app for HEIC photos or Opus voice notes, which upload refuses
    accepted = manifest()["share_target"]["params"]["files"][0]["accept"]
    extensions = {item for item in accepted if item.startswith(".")}

    assert not [item for item in accepted if item.endswith("/*")]
    assert extensions == ALL_MEDIA_EXTENSIONS


def test_android_gets_png_icons_it_can_install_with():
    icons = manifest()["icons"]
    pngs = {(icon["sizes"], icon["purpose"]): icon["src"] for icon in icons if icon["type"] == "image/png"}

    assert {("192x192", "any"), ("512x512", "any"), ("512x512", "maskable")} <= set(pngs)
    for (sizes, _), src in pngs.items():
        data = (FRONTEND / src.removeprefix("/static/")).read_bytes()
        width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
        assert data[:8] == b"\x89PNG\r\n\x1a\n"
        assert f"{width}x{height}" == sizes


def test_a_share_before_the_service_worker_runs_opens_the_app():
    # The worker normally answers this. Without it, the page still opens, with no login needed first.
    response = TestClient(main.app).post(
        "/share-target", data={"text": "hello"}, follow_redirects=False
    )

    assert response.status_code == 303
    assert response.headers["location"] == "/"


def test_the_worker_keeps_shares_apart_from_the_versioned_cache():
    worker = (FRONTEND / "sw.js").read_text(encoding="utf-8")

    assert "name !== SHARE_CACHE" in worker
    assert "url.pathname === '/share-target'" in worker
