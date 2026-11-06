"""Deleting moves things to the trash, and only the trash deletes for good."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import main, trash, utils
from backend.export import resolve_media_path
from backend.share import create_share_token, get_share_info
from backend.trash import delete_entry, empty_trash, list_trash, restore_entry
from backend.utils import delete_folder, delete_note, save_uploaded_image


@pytest.fixture
def vault(tmp_path):
    return tmp_path


def write_note(vault: Path, path: str, content: str = "text") -> None:
    full = vault / path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")


def only_entry(vault: Path) -> dict:
    entries = list_trash(str(vault))
    assert len(entries) == 1
    return entries[0]


def test_note_goes_to_the_trash_with_its_attachments(vault):
    write_note(vault, "work/meeting.md")
    save_uploaded_image(str(vault), "work/meeting.md", "photo.png", b"a")

    assert delete_note(str(vault), "work/meeting.md")

    assert not (vault / "work/meeting.md").exists()
    assert not (vault / "work/meeting.attachments").exists()
    entry = only_entry(vault)
    assert (entry["name"], entry["path"], entry["folder"], entry["type"], entry["size"]) == (
        "meeting", "work/meeting.md", "work", "note", 5,
    )


def test_note_comes_back_with_its_attachments(vault):
    write_note(vault, "work/meeting.md", "![[meeting.attachments/photo.png]]")
    save_uploaded_image(str(vault), "work/meeting.md", "photo.png", b"a")
    delete_note(str(vault), "work/meeting.md")

    assert restore_entry(str(vault), only_entry(vault)["id"]) == "work/meeting.md"

    assert (vault / "work/meeting.md").read_text() == "![[meeting.attachments/photo.png]]"
    assert (vault / "work/meeting.attachments/photo.png").is_file()
    assert list_trash(str(vault)) == []


def test_new_note_with_the_same_name_gets_no_old_files(vault):
    write_note(vault, "a.md")
    save_uploaded_image(str(vault), "a.md", "photo.png", b"a")
    delete_note(str(vault), "a.md")

    assert save_uploaded_image(str(vault), "a.md", "photo.png", b"b") == "a.attachments/photo.png"
    assert (vault / "a.attachments/photo.png").read_bytes() == b"b"


def test_folder_round_trip(vault):
    write_note(vault, "work/sub/note.md")
    save_uploaded_image(str(vault), "work/sub/note.md", "photo.png", b"a")

    assert delete_folder(str(vault), "work/sub")
    entry = only_entry(vault)
    assert (entry["name"], entry["type"]) == ("sub", "folder")
    assert not (vault / "work/sub").exists()

    assert restore_entry(str(vault), entry["id"]) == "work/sub"
    assert (vault / "work/sub/note.attachments/photo.png").is_file()


def test_media_round_trip(vault):
    write_note(vault, "photo.png", "x")

    assert delete_note(str(vault), "photo.png")
    entry = only_entry(vault)
    assert (entry["name"], entry["type"]) == ("photo.png", "media")

    assert restore_entry(str(vault), entry["id"]) == "photo.png"
    assert (vault / "photo.png").is_file()


def test_restore_recreates_a_missing_parent(vault):
    write_note(vault, "a/b/note.md")
    delete_note(str(vault), "a/b/note.md")
    (vault / "a/b").rmdir()
    (vault / "a").rmdir()

    assert restore_entry(str(vault), only_entry(vault)["id"]) == "a/b/note.md"


def test_restore_onto_a_taken_name_counts_and_fixes_links(vault):
    write_note(vault, "a.md", "![[a.attachments/p.png]] ![[other.attachments/q.png]]")
    save_uploaded_image(str(vault), "a.md", "p.png", b"a")
    delete_note(str(vault), "a.md")
    write_note(vault, "a.md", "newer")

    assert restore_entry(str(vault), only_entry(vault)["id"]) == "a-1.md"

    assert (vault / "a.md").read_text() == "newer"
    assert (vault / "a-1.md").read_text() == "![[a-1.attachments/p.png]] ![[other.attachments/q.png]]"
    assert (vault / "a-1.attachments/p.png").is_file()


def test_restore_skips_a_name_whose_attachment_folder_exists(vault):
    write_note(vault, "a.md")
    save_uploaded_image(str(vault), "a.md", "p.png", b"a")
    delete_note(str(vault), "a.md")
    (vault / "a.attachments").mkdir()

    assert restore_entry(str(vault), only_entry(vault)["id"]) == "a-1.md"


def test_restore_counts_for_folders_and_media(vault):
    write_note(vault, "v1.2/note.md")
    write_note(vault, "photo.png", "x")
    delete_folder(str(vault), "v1.2")
    delete_note(str(vault), "photo.png")
    write_note(vault, "v1.2/other.md")
    write_note(vault, "photo.png", "y")

    paths = sorted(restore_entry(str(vault), entry["id"]) for entry in list_trash(str(vault)))

    assert paths == ["photo-1.png", "v1.2-1"]


def test_failed_move_leaves_everything_in_place(vault, monkeypatch):
    write_note(vault, "a.md")
    save_uploaded_image(str(vault), "a.md", "p.png", b"a")
    real_move = trash.shutil.move

    def fail_on_folder(source, destination):
        if source.endswith(".attachments") and ".trash" in destination:
            raise OSError("disk full")
        return real_move(source, destination)

    monkeypatch.setattr(trash.shutil, "move", fail_on_folder)

    assert not delete_note(str(vault), "a.md")
    assert (vault / "a.md").is_file()
    assert (vault / "a.attachments/p.png").is_file()
    assert list_trash(str(vault)) == []


def test_failed_restore_keeps_the_entry(vault, monkeypatch):
    write_note(vault, "a.md")
    save_uploaded_image(str(vault), "a.md", "p.png", b"a")
    delete_note(str(vault), "a.md")
    real_move = trash.shutil.move

    def fail_on_folder(source, destination):
        if source.endswith(".attachments"):
            raise OSError("disk full")
        return real_move(source, destination)

    monkeypatch.setattr(trash.shutil, "move", fail_on_folder)

    assert restore_entry(str(vault), only_entry(vault)["id"]) is None
    assert not (vault / "a.md").exists()
    assert only_entry(vault)["path"] == "a.md"


def test_delete_entry_and_empty_trash_are_permanent(vault):
    for name in "abc":
        write_note(vault, f"{name}.md")
        delete_note(str(vault), f"{name}.md")
    first = list_trash(str(vault))[0]

    assert delete_entry(str(vault), first["id"])
    assert len(list_trash(str(vault))) == 2
    assert empty_trash(str(vault)) == 2
    assert list_trash(str(vault)) == []


def test_other_files_in_the_trash_are_left_alone(vault):
    write_note(vault, ".trash/from-obsidian.md")
    write_note(vault, ".trash/0123456789abcdef0123456789abcdef/entry.json", "not json")
    write_note(vault, "a.md")
    delete_note(str(vault), "a.md")

    assert only_entry(vault)["path"] == "a.md"
    empty_trash(str(vault))

    assert (vault / ".trash/from-obsidian.md").is_file()
    assert (vault / ".trash/0123456789abcdef0123456789abcdef/entry.json").is_file()


@pytest.mark.parametrize("entry_id", ["..", "../..", "abc", "0" * 31, "0" * 33, "A" * 32, "from-obsidian.md"])
def test_bad_ids_do_nothing(vault, entry_id):
    write_note(vault, ".trash/from-obsidian.md")

    assert restore_entry(str(vault), entry_id) is None
    assert not delete_entry(str(vault), entry_id)
    assert (vault / ".trash/from-obsidian.md").is_file()


def test_a_tampered_entry_cannot_restore_outside_the_vault(tmp_path):
    vault = tmp_path / "vault"
    write_note(vault, "a.md")
    delete_note(str(vault), "a.md")
    entry = only_entry(vault)
    entry_file = vault / ".trash" / entry["id"] / "entry.json"
    data = json.loads(entry_file.read_text())
    data["path"] = "../a.md"
    entry_file.write_text(json.dumps(data))

    assert restore_entry(str(vault), entry["id"]) is None
    assert not (tmp_path / "a.md").exists()


def test_paths_in_the_trash_fail_the_security_check(vault):
    assert not utils.validate_path_security(str(vault), vault / ".trash" / "x" / "a.md")
    assert not utils.validate_path_security(str(vault), vault / "work" / ".." / ".trash")
    assert utils.validate_path_security(str(vault), vault / "trash" / "a.md")


def test_export_cannot_reach_the_trash(vault):
    write_note(vault, ".trash/abc/photo.png", "x")

    assert resolve_media_path(".trash/abc/photo.png", vault, vault) is None


@pytest.fixture
def client(vault, monkeypatch):
    monkeypatch.setitem(main.config["storage"], "notes_dir", str(vault))
    main.limiter.enabled = False
    yield TestClient(main.app)
    main.limiter.enabled = True


def test_routes_round_trip(vault, client):
    write_note(vault, "a.md")
    assert client.delete("/api/notes/a.md").status_code == 200

    items = client.get("/api/trash").json()["items"]
    assert [item["path"] for item in items] == ["a.md"]

    response = client.post(f"/api/trash/{items[0]['id']}/restore")
    assert response.json()["path"] == "a.md"
    assert client.post(f"/api/trash/{items[0]['id']}/restore").status_code == 404

    client.delete("/api/notes/a.md")
    item = client.get("/api/trash").json()["items"][0]
    assert client.delete(f"/api/trash/{item['id']}").status_code == 200
    assert client.delete(f"/api/trash/{item['id']}").status_code == 404

    write_note(vault, "b.md")
    client.delete("/api/notes/b.md")
    assert client.delete("/api/trash").json()["deleted"] == 1


@pytest.mark.parametrize("call", [
    lambda c, p: c.get(f"/api/notes/{p}/a.md"),
    lambda c, p: c.post(f"/api/notes/{p}/a.md", json={"content": "x"}),
    lambda c, p: c.delete(f"/api/notes/{p}/a.md"),
    lambda c, p: c.get(f"/api/media/{p}/photo.png"),
    lambda c, p: c.delete(f"/api/folders/{p}"),
    lambda c, p: c.post("/api/notes/move", json={"oldPath": f"{p}/a.md", "newPath": "b.md"}),
    lambda c, p: c.post("/api/notes/move", json={"oldPath": "keep.md", "newPath": f"{p}/keep.md"}),
    lambda c, p: c.post("/api/media/move", json={"oldPath": f"{p}/photo.png", "newPath": "photo.png"}),
    lambda c, p: c.post("/api/folders/move", json={"oldPath": p, "newPath": "out"}),
])
def test_routes_refuse_the_trash(vault, client, call):
    write_note(vault, ".trash/x/a.md", "secret")
    write_note(vault, ".trash/x/photo.png", "x")
    write_note(vault, "keep.md")
    before = sorted(p.as_posix() for p in vault.rglob("*"))

    response = call(client, ".trash/x")

    assert response.status_code >= 400
    assert "secret" not in response.text
    assert sorted(p.as_posix() for p in vault.rglob("*")) == before


def test_search_follows_the_note_in_and_out_of_the_trash(vault, client):
    def found():
        return [result["path"] for result in client.get("/api/search?q=uniquezebra").json()["results"]]

    write_note(vault, "a.md", "uniquezebra")
    client.get("/api/notes")
    assert found() == ["a.md"]

    client.delete("/api/notes/a.md")
    assert found() == []

    entry = client.get("/api/trash").json()["items"][0]
    client.post(f"/api/trash/{entry['id']}/restore")
    assert found() == ["a.md"]


def test_share_links_do_not_come_back(vault, client):
    write_note(vault, "a.md")
    write_note(vault, "work/b.md")
    create_share_token(str(vault), "a.md")
    create_share_token(str(vault), "work/b.md")

    client.delete("/api/notes/a.md")
    client.delete("/api/folders/work")
    for item in client.get("/api/trash").json()["items"]:
        client.post(f"/api/trash/{item['id']}/restore")

    assert (vault / "a.md").is_file() and (vault / "work/b.md").is_file()
    assert not get_share_info(str(vault), "a.md").get("shared")
    assert not get_share_info(str(vault), "work/b.md").get("shared")
