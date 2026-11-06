"""Per-note attachment folders, file naming and path-only media lookup."""

from pathlib import Path

import pytest

from backend import utils
from backend.export import process_media_for_export, resolve_media_path
from backend.utils import (
    get_attachment_dir,
    move_note,
    rewrite_attachment_links,
    save_uploaded_image,
)


@pytest.fixture
def vault(tmp_path):
    return tmp_path


def write_note(vault: Path, path: str, content: str = "") -> None:
    full = vault / path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")


def test_attachment_folder_sits_next_to_the_note(vault):
    assert get_attachment_dir(str(vault), "meeting.md") == vault / "meeting.attachments"
    assert get_attachment_dir(str(vault), "work/a.b.md") == vault / "work" / "a.b.attachments"


def test_upload_keeps_the_name_and_counts_on_a_clash(vault):
    paths = [save_uploaded_image(str(vault), "work/meeting.md", "photo.png", bytes([n])) for n in range(3)]

    assert paths == [
        "work/meeting.attachments/photo.png",
        "work/meeting.attachments/photo-1.png",
        "work/meeting.attachments/photo-2.png",
    ]
    assert [(vault / p).read_bytes() for p in paths] == [b"\x00", b"\x01", b"\x02"]


def test_names_differing_only_by_case_clash(vault):
    save_uploaded_image(str(vault), "note.md", "photo.png", b"a")

    assert save_uploaded_image(str(vault), "note.md", "PHOTO.png", b"b") == "note.attachments/PHOTO-1.png"


def test_notes_do_not_share_a_name_space(vault):
    assert save_uploaded_image(str(vault), "a.md", "photo.png", b"a") == "a.attachments/photo.png"
    assert save_uploaded_image(str(vault), "b.md", "photo.png", b"b") == "b.attachments/photo.png"


def test_upload_name_cannot_break_an_embed(vault):
    path = save_uploaded_image(str(vault), "note.md", "a]]b[1]#2.png", b"a")

    assert not set("[]#") & set(path)


def test_upload_name_cannot_leave_the_folder(vault):
    path = save_uploaded_image(str(vault), "note.md", "../../evil.png", b"a")

    assert path.startswith("note.attachments/")
    assert (vault / path).is_file()


def test_upload_with_no_note_goes_into_the_folder(vault):
    assert save_uploaded_image(str(vault), "", "photo.png", b"a", sibling_folder="work") == "work/photo.png"
    assert save_uploaded_image(str(vault), "", "photo.png", b"a", sibling_folder="") == "photo.png"


def test_upload_folder_cannot_leave_the_vault(vault):
    assert save_uploaded_image(str(vault), "", "photo.png", b"a", sibling_folder="../out") is None


def test_drawing_keeps_its_timestamp(vault):
    path = save_uploaded_image(str(vault), "", "x.png", b"a", sibling_folder="", drawing=True)

    assert path.startswith("drawing-") and path[len("drawing-"):-4].isdigit()


def test_moving_a_note_moves_its_folder_without_changing_links(vault):
    text = "![[meeting.attachments/photo.png]]"
    write_note(vault, "meeting.md", text)
    save_uploaded_image(str(vault), "meeting.md", "photo.png", b"a")

    assert move_note(str(vault), "meeting.md", "work/meeting.md") == (True, "", None)
    assert (vault / "work/meeting.attachments/photo.png").is_file()
    assert not (vault / "meeting.attachments").exists()
    assert (vault / "work/meeting.md").read_text() == text


def test_moving_a_note_with_no_attachments_works(vault):
    write_note(vault, "meeting.md", "text")

    assert move_note(str(vault), "meeting.md", "work/meeting.md") == (True, "", None)


def test_renaming_a_note_updates_its_own_links(vault):
    write_note(vault, "old name.md", "\n".join([
        "![[old name.attachments/a.png|100]]",
        "![alt](old%20name.attachments/b.png)",
        "![alt](old name.attachments/c.png)",
        "![[other.attachments/d.png]]",
        "[link](old name.attachments/e.pdf)",
    ]))
    save_uploaded_image(str(vault), "old name.md", "a.png", b"a")

    ok, error, content = move_note(str(vault), "old name.md", "new name.md")

    assert (ok, error) == (True, "")
    assert content == (vault / "new name.md").read_text()
    assert content.split("\n") == [
        "![[new name.attachments/a.png|100]]",
        "![alt](new%20name.attachments/b.png)",
        "![alt](new name.attachments/c.png)",
        "![[other.attachments/d.png]]",
        "[link](old name.attachments/e.pdf)",
    ]
    assert (vault / "new name.attachments/a.png").is_file()


def test_rename_with_nothing_to_rewrite_reports_no_content(vault):
    write_note(vault, "a.md", "no embeds")
    save_uploaded_image(str(vault), "a.md", "photo.png", b"a")

    assert move_note(str(vault), "a.md", "b.md") == (True, "", None)


def test_move_is_refused_when_the_destination_folder_exists(vault):
    write_note(vault, "a.md", "text")
    save_uploaded_image(str(vault), "a.md", "photo.png", b"a")
    (vault / "b.attachments").mkdir()

    ok, error, _ = move_note(str(vault), "a.md", "b.md")

    assert not ok and "attachment folder" in error
    assert (vault / "a.md").is_file()
    assert (vault / "a.attachments/photo.png").is_file()


def test_failed_folder_move_puts_the_note_back(vault, monkeypatch):
    write_note(vault, "a.md", "text")
    save_uploaded_image(str(vault), "a.md", "photo.png", b"a")

    def fail(*args):
        raise OSError("disk full")

    monkeypatch.setattr(utils.shutil, "move", fail)
    ok, error, _ = move_note(str(vault), "a.md", "work/a.md")

    assert not ok and "disk full" in error
    assert (vault / "a.md").is_file()
    assert not (vault / "work/a.md").exists()


def test_rewrite_leaves_a_longer_folder_name_alone():
    text = "![[xa.attachments/p.png]] ![](xa.attachments/p.png)"

    assert rewrite_attachment_links(text, "a.attachments", "b.attachments") == text


def test_media_is_found_by_path_only(vault):
    write_note(vault, "work/_other/photo.png", "x")
    write_note(vault, "work/a.attachments/photo.png", "x")
    write_note(vault, "b.attachments/photo.png", "x")
    folder = vault / "work"

    assert resolve_media_path("a.attachments/photo.png", folder, vault) == folder / "a.attachments/photo.png"
    assert resolve_media_path("../b.attachments/photo.png", folder, vault) == vault / "b.attachments/photo.png"
    assert resolve_media_path("photo.png", folder, vault) is None


@pytest.mark.parametrize("target", ["../../outside.png", "/etc/passwd"])
def test_media_outside_the_vault_is_refused(tmp_path, target):
    vault = tmp_path / "a" / "vault"
    vault.mkdir(parents=True)
    (tmp_path / "a" / "outside.png").write_text("x")

    assert resolve_media_path(target, vault / "folder", vault) is None


def test_export_leaves_a_bare_name_unresolved(vault):
    png = bytes.fromhex("89504e470d0a1a0a")
    (vault / "a.attachments").mkdir()
    (vault / "a.attachments/photo.png").write_bytes(png)

    found = process_media_for_export("![[a.attachments/photo.png]]", vault, vault)
    missing = process_media_for_export("![[photo.png]]", vault, vault)

    assert "data:image/png;base64" in found
    assert "data:image" not in missing
