"""The page is split over several files, and each has to be loaded, cached and hashed."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.main import INCLUDE_RE, VERSIONED_ASSETS

FRONTEND = Path(__file__).parent.parent / "frontend"
SCRIPTS = sorted(f"app/{file.name}" for file in (FRONTEND / "app").glob("*.js"))


def test_there_are_scripts_to_check():
    assert "app/shared.js" in SCRIPTS


@pytest.mark.parametrize("script", SCRIPTS)
def test_a_script_is_loaded_and_precached(script):
    url = f"/static/{script}?v=__APP_VERSION__"

    assert f'<script src="{url}"></script>' in (FRONTEND / "index.html").read_text(encoding="utf-8")
    assert f"'{url}'" in (FRONTEND / "sw.js").read_text(encoding="utf-8")


@pytest.mark.parametrize("script", SCRIPTS)
def test_a_script_changes_the_asset_token(script):
    assert script in VERSIONED_ASSETS


def test_the_entry_point_loads_last():
    html = (FRONTEND / "index.html").read_text(encoding="utf-8")

    assert all(html.index(f"/static/{script}?") < html.index("/static/app.js?") for script in SCRIPTS)


def test_the_stylesheet_is_loaded_cached_and_hashed():
    url = "/static/app.css?v=__APP_VERSION__"

    assert f'<link rel="stylesheet" href="{url}">' in (FRONTEND / "index.html").read_text(encoding="utf-8")
    assert f"'{url}'" in (FRONTEND / "sw.js").read_text(encoding="utf-8")
    assert "app.css" in VERSIONED_ASSETS


def test_every_partial_is_included():
    pages = [FRONTEND / "index.html", *(FRONTEND / "partials").rglob("*.html")]
    included = {path for page in pages for path, _ in INCLUDE_RE.findall(page.read_text(encoding="utf-8"))}
    partials = {str(file.relative_to(FRONTEND)) for file in (FRONTEND / "partials").rglob("*.html")}

    assert included == partials


def test_the_page_is_served_whole():
    page = TestClient(main.app).get("/").text

    assert "<!-- include:" not in page
    for file in (FRONTEND / "partials").rglob("*.html"):
        first_line = file.read_text(encoding="utf-8").splitlines()[0].strip()
        assert first_line in page, file


def test_a_marker_inside_a_line_keeps_the_line(tmp_path, monkeypatch):
    (tmp_path / "partials").mkdir()
    (tmp_path / "partials/a.html").write_text("<b>x</b>\n", encoding="utf-8")
    (tmp_path / "index.html").write_text("<p><!-- include: partials/a.html --></p>\n", encoding="utf-8")
    monkeypatch.setattr(main, "static_path", tmp_path)
    monkeypatch.setattr(main, "_index_cache", (None, ""))

    assert main.assembled_index() == "<p><b>x</b></p>\n"


def test_an_edited_partial_is_served_without_a_restart(tmp_path, monkeypatch):
    (tmp_path / "partials").mkdir()
    part = tmp_path / "partials/a.html"
    part.write_text("one\n", encoding="utf-8")
    (tmp_path / "index.html").write_text("<!-- include: partials/a.html -->\n", encoding="utf-8")
    monkeypatch.setattr(main, "static_path", tmp_path)
    monkeypatch.setattr(main, "_index_cache", (None, ""))
    assert main.assembled_index() == "one\n"

    part.write_text("two, longer\n", encoding="utf-8")

    assert main.assembled_index() == "two, longer\n"


def _vault_page(tmp_path, monkeypatch, index, partials):
    (tmp_path / "partials").mkdir()
    for name, text in partials.items():
        (tmp_path / "partials" / name).write_text(text, encoding="utf-8")
    (tmp_path / "index.html").write_text(index, encoding="utf-8")
    monkeypatch.setattr(main, "static_path", tmp_path)
    monkeypatch.setattr(main, "_index_cache", (None, ""))


def test_a_partial_can_include_another_more_than_once(tmp_path, monkeypatch):
    _vault_page(tmp_path, monkeypatch, "<!-- include: partials/outer.html -->\n", {
        "outer.html": "<a>\n<!-- include: partials/inner.html -->\n<!-- include: partials/inner.html -->\n</a>\n",
        "inner.html": "<b>x</b>\n",
    })

    assert main.assembled_index() == "<a>\n<b>x</b>\n<b>x</b>\n</a>\n"


def test_partials_that_include_each_other_are_refused(tmp_path, monkeypatch):
    _vault_page(tmp_path, monkeypatch, "<!-- include: partials/a.html -->\n", {
        "a.html": "<!-- include: partials/b.html -->\n",
        "b.html": "<!-- include: partials/a.html -->\n",
    })

    with pytest.raises(RuntimeError):
        main.assembled_index()
