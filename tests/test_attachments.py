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
    note_moves,
    update_links_after_move,
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

    assert move_note(str(vault), "meeting.md", "work/meeting.md") == (True, "")
    assert (vault / "work/meeting.attachments/photo.png").is_file()
    assert not (vault / "meeting.attachments").exists()
    assert (vault / "work/meeting.md").read_text() == text


def test_moving_a_note_with_no_attachments_works(vault):
    write_note(vault, "meeting.md", "text")

    assert move_note(str(vault), "meeting.md", "work/meeting.md") == (True, "")


def test_renaming_a_note_updates_its_own_links(vault):
    write_note(vault, "old name.md", "\n".join([
        "![[old name.attachments/a.png|100]]",
        "![alt](old%20name.attachments/b.png)",
        "![alt](old name.attachments/c.png)",
        "![[other.attachments/d.png]]",
        "[link](old name.attachments/e.pdf)",
    ]))
    for name in ("a.png", "b.png", "c.png"):
        save_uploaded_image(str(vault), "old name.md", name, b"a")

    assert move_with_embeds(vault, "old name.md", "new name.md") == ["new name.md"]

    assert (vault / "new name.md").read_text().split("\n") == [
        "![[new name.attachments/a.png|100]]",
        "![alt](new%20name.attachments/b.png)",
        "![alt](new name.attachments/c.png)",
        "![[other.attachments/d.png]]",
        "[link](old name.attachments/e.pdf)",
    ]
    assert (vault / "new name.attachments/a.png").is_file()


def test_rename_with_nothing_to_rewrite_changes_no_notes(vault):
    write_note(vault, "a.md", "no embeds")
    save_uploaded_image(str(vault), "a.md", "photo.png", b"a")

    assert move_with_embeds(vault, "a.md", "b.md") == []


def test_move_is_refused_when_the_destination_folder_exists(vault):
    write_note(vault, "a.md", "text")
    save_uploaded_image(str(vault), "a.md", "photo.png", b"a")
    (vault / "b.attachments").mkdir()

    ok, error = move_note(str(vault), "a.md", "b.md")

    assert not ok and "attachment folder" in error
    assert (vault / "a.md").is_file()
    assert (vault / "a.attachments/photo.png").is_file()


def test_failed_folder_move_puts_the_note_back(vault, monkeypatch):
    write_note(vault, "a.md", "text")
    save_uploaded_image(str(vault), "a.md", "photo.png", b"a")

    def fail(*args):
        raise OSError("disk full")

    monkeypatch.setattr(utils.shutil, "move", fail)
    ok, error = move_note(str(vault), "a.md", "work/a.md")

    assert not ok and "disk full" in error
    assert (vault / "a.md").is_file()
    assert not (vault / "work/a.md").exists()


def move_with_embeds(vault: Path, old_path: str, new_path: str) -> list:
    assert move_note(str(vault), old_path, new_path)[0]
    return sorted(update_links_after_move(str(vault), note_moves(str(vault), old_path, new_path)))


def test_renaming_a_note_updates_embeds_in_other_notes(vault):
    write_note(vault, "work/old name.md", "text")
    save_uploaded_image(str(vault), "work/old name.md", "a.png", b"a")
    write_note(vault, "work/same.md", "![[old name.attachments/a.png|100]]")
    write_note(vault, "root.md", "![alt](work/old%20name.attachments/a.png)")
    write_note(vault, "other/deep/below.md", "![[../../work/old name.attachments/a.png]]")
    write_note(vault, "unrelated.md", "![[old name.attachments/a.png]]")

    updated = move_with_embeds(vault, "work/old name.md", "work/new name.md")

    assert updated == ["other/deep/below.md", "root.md", "work/same.md"]
    assert (vault / "work/same.md").read_text() == "![[new name.attachments/a.png|100]]"
    assert (vault / "root.md").read_text() == "![alt](work/new%20name.attachments/a.png)"
    assert (vault / "other/deep/below.md").read_text() == "![[../../work/new name.attachments/a.png]]"
    assert (vault / "unrelated.md").read_text() == "![[old name.attachments/a.png]]"


def test_moving_a_note_updates_embeds_in_other_notes(vault):
    write_note(vault, "a.md", "![[a.attachments/p.png]]")
    save_uploaded_image(str(vault), "a.md", "p.png", b"a")
    write_note(vault, "b.md", "![[a.attachments/p.png]]")
    write_note(vault, "work/c.md", "![[../a.attachments/p.png]]")

    assert move_with_embeds(vault, "a.md", "work/a.md") == ["b.md", "work/c.md"]

    assert (vault / "b.md").read_text() == "![[work/a.attachments/p.png]]"
    assert (vault / "work/c.md").read_text() == "![[a.attachments/p.png]]"
    assert (vault / "work/a.md").read_text() == "![[a.attachments/p.png]]"


def test_moved_note_with_no_attachments_changes_nothing(vault):
    write_note(vault, "a.md", "text")
    write_note(vault, "b.md", "![[a.attachments/p.png]]")

    assert move_with_embeds(vault, "a.md", "c.md") == []
    assert (vault / "b.md").read_text() == "![[a.attachments/p.png]]"


def test_unreadable_note_does_not_stop_the_others(vault):
    write_note(vault, "a.md", "text")
    save_uploaded_image(str(vault), "a.md", "p.png", b"a")
    (vault / "bad.md").write_bytes(b"\xff\xfe ![[a.attachments/p.png]]")
    write_note(vault, "good.md", "![[a.attachments/p.png]]")

    assert move_with_embeds(vault, "a.md", "b.md") == ["good.md"]
    assert (vault / "good.md").read_text() == "![[b.attachments/p.png]]"


def test_notes_in_the_trash_are_left_alone(vault):
    write_note(vault, "a.md", "text")
    save_uploaded_image(str(vault), "a.md", "p.png", b"a")
    write_note(vault, ".trash/1/b.md", "![[a.attachments/p.png]]")

    assert move_with_embeds(vault, "a.md", "c.md") == []
    assert (vault / ".trash/1/b.md").read_text() == "![[a.attachments/p.png]]"


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


@pytest.mark.parametrize("embed", ["![[photo.png#x]]", "![[photo.png?v=1|shown]]", "![y](photo.png#x)"])
def test_export_finds_an_embed_with_a_suffix(vault, embed):
    (vault / "photo.png").write_bytes(b"png")

    assert "data:image/png;base64," in process_media_for_export(embed, vault, vault)


@pytest.mark.parametrize("embed", ["![[a.pdf#page=2]]", "![y](a.pdf#page=2)"])
def test_export_knows_a_pdf_with_a_suffix(vault, embed):
    (vault / "a.pdf").write_bytes(b"pdf")

    assert "PDF document" in process_media_for_export(embed, vault, vault)


def test_export_prefers_a_file_named_with_a_hash(vault):
    (vault / "a#b.png").write_bytes(b"png")
    (vault / "a").write_bytes(b"other")

    assert "data:image/png;base64," in process_media_for_export("![[a#b.png]]", vault, vault)
