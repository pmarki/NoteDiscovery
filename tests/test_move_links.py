"""Moving notes, folders and media keeps embeds and wikilinks pointing at the same thing."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import main, note_index
from backend.utils import move_folder, move_note, note_moves, update_links_after_move


@pytest.fixture
def vault(tmp_path):
    return tmp_path


def write(vault: Path, path: str, content="text") -> None:
    full = vault / path
    full.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        full.write_bytes(content)
    else:
        full.write_text(content, encoding="utf-8")


def read(vault: Path, path: str) -> str:
    return (vault / path).read_text(encoding="utf-8")


def rename_note(vault: Path, old: str, new: str) -> list:
    assert move_note(str(vault), old, new)[0]
    return sorted(update_links_after_move(str(vault), note_moves(str(vault), old, new)))


def rename_folder(vault: Path, old: str, new: str) -> list:
    assert move_folder(str(vault), old, new)[0]
    return sorted(update_links_after_move(str(vault), {old: new}))


def move_file(vault: Path, old: str, new: str) -> list:
    (vault / new).parent.mkdir(parents=True, exist_ok=True)
    (vault / old).rename(vault / new)
    return sorted(update_links_after_move(str(vault), {old: new}))


# --- Wikilinks

@pytest.mark.parametrize("link, expected", [
    ("[[old]]", "[[new]]"),
    ("[[OLD]]", "[[new]]"),
    ("[[old|shown]]", "[[new|shown]]"),
    ("[[old#Part two]]", "[[new#Part two]]"),
    ("[[old#Part|shown]]", "[[new#Part|shown]]"),
    ("[[old.md]]", "[[new.md]]"),
    ("[[work/old]]", "[[work/new]]"),
    ("[[work/old.md|x]]", "[[work/new.md|x]]"),
])
def test_renaming_a_note_updates_wikilinks(vault, link, expected):
    write(vault, "work/old.md")
    write(vault, "other.md", f"see {link} here")

    assert rename_note(vault, "work/old.md", "work/new.md") == ["other.md"]
    assert read(vault, "other.md") == f"see {expected} here"


def test_a_bare_wikilink_survives_a_move_unchanged(vault):
    write(vault, "a.md")
    write(vault, "b.md", "[[a]]")

    assert rename_note(vault, "a.md", "work/a.md") == []
    assert read(vault, "b.md") == "[[a]]"


def test_a_path_wikilink_follows_a_move(vault):
    write(vault, "work/a.md")
    write(vault, "b.md", "[[work/a]]")

    assert rename_note(vault, "work/a.md", "done/a.md") == ["b.md"]
    assert read(vault, "b.md") == "[[done/a]]"


def test_a_wikilink_uses_the_path_when_the_new_name_is_taken(vault):
    write(vault, "work/old.md")
    write(vault, "other/new.md")
    write(vault, "other/b.md", "[[work/old]] [[old]]")

    rename_note(vault, "work/old.md", "work/new.md")

    assert read(vault, "other/b.md") == "[[work/new]] [[work/new]]"


def test_a_same_named_note_keeps_its_links(vault):
    write(vault, "work/x.md")
    write(vault, "other/x.md")
    write(vault, "other/b.md", "[[x]] [[other/x]]")

    assert rename_note(vault, "work/x.md", "work/y.md") == []
    assert read(vault, "other/b.md") == "[[x]] [[other/x]]"


def test_a_note_keeps_links_to_itself(vault):
    write(vault, "a.md", "[[a]]")

    assert rename_note(vault, "a.md", "b.md") == ["b.md"]
    assert read(vault, "b.md") == "[[b]]"


def test_a_broken_wikilink_and_a_longer_name_are_left_alone(vault):
    write(vault, "ab.md")
    write(vault, "a.md")
    text = "[[missing]] [[ab]]"
    write(vault, "b.md", text)

    assert rename_note(vault, "a.md", "c.md") == []
    assert read(vault, "b.md") == text


def test_code_is_left_alone(vault):
    write(vault, "a.md")
    write(vault, "a.attachments/p.png", b"x")
    write(vault, "b.md", "\n".join([
        "[[a]] ![[a.attachments/p.png]]",
        "`[[a]]`",
        "```",
        "[[a]] ![[a.attachments/p.png]]",
        "```",
        "~~~md",
        "[[a]]",
        "~~~",
        "[[a]]",
        "```",
        "[[a]] never closed",
    ]))

    rename_note(vault, "a.md", "c.md")

    assert read(vault, "b.md").split("\n") == [
        "[[c]] ![[c.attachments/p.png]]",
        "`[[a]]`",
        "```",
        "[[a]] ![[a.attachments/p.png]]",
        "```",
        "~~~md",
        "[[a]]",
        "~~~",
        "[[c]]",
        "```",
        "[[a]] never closed",
    ]


def test_trash_is_left_alone(vault):
    write(vault, "a.md")
    write(vault, ".trash/1/b.md", "[[a]]")

    assert rename_note(vault, "a.md", "c.md") == []
    assert read(vault, ".trash/1/b.md") == "[[a]]"


# --- Markdown links to notes

@pytest.mark.parametrize("link, expected", [
    ("[t](old.md)", "[t](new.md)"),
    ("[t](old)", "[t](new)"),
    ("[t](./old.md)", "[t](new.md)"),
    ("[t](old.md#part-two)", "[t](new.md#part-two)"),
    ('[t](old.md "A title")', '[t](new.md "A title")'),
    ("[t](/work/old.md)", "[t](/work/new.md)"),
    ("[t](OLD.MD)", "[t](new.md)"),
    ("- [ ] [t](old.md)", "- [ ] [t](new.md)"),
    ("[![p](p.png)](old.md)", "[![p](p.png)](new.md)"),
])
def test_renaming_a_note_updates_markdown_links(vault, link, expected):
    write(vault, "work/old.md")
    write(vault, "work/p.png", b"x")
    write(vault, "work/other.md", f"see {link} here")

    assert rename_note(vault, "work/old.md", "work/new.md") == ["work/other.md"]
    assert read(vault, "work/other.md") == f"see {expected} here"


def test_markdown_links_are_written_from_the_note_holding_them(vault):
    write(vault, "work/a.md")
    write(vault, "b.md", "[t](work/a.md)")
    write(vault, "deep/er/c.md", "[t](../../work/a.md)")
    write(vault, "work/d.md", "[t](a.md)")

    updated = rename_note(vault, "work/a.md", "done/a.md")

    assert updated == ["b.md", "deep/er/c.md", "work/d.md"]
    assert read(vault, "b.md") == "[t](done/a.md)"
    assert read(vault, "deep/er/c.md") == "[t](../../done/a.md)"
    assert read(vault, "work/d.md") == "[t](../done/a.md)"


def test_a_markdown_link_found_by_name_survives_a_move(vault):
    write(vault, "work/a.md")
    write(vault, "b.md", "[t](a.md)")

    assert rename_note(vault, "work/a.md", "done/a.md") == []
    assert read(vault, "b.md") == "[t](a.md)"


def test_a_markdown_link_found_by_name_follows_a_rename(vault):
    write(vault, "work/a.md")
    write(vault, "b.md", "[t](a.md)")

    assert rename_note(vault, "work/a.md", "work/c.md") == ["b.md"]
    assert read(vault, "b.md") == "[t](c.md)"


def test_a_note_that_moves_keeps_its_markdown_links(vault):
    write(vault, "sib/other.md")
    write(vault, "top.md")
    write(vault, "sib/a.md", "[t](other.md) [self](a.md) [root](top.md)")

    assert rename_note(vault, "sib/a.md", "work/deep/b.md") == ["work/deep/b.md"]
    assert read(vault, "work/deep/b.md") == "[t](../../sib/other.md) [self](b.md) [root](top.md)"


def test_markdown_links_stay_valid_with_spaces_in_the_new_name(vault):
    write(vault, "a.md")
    write(vault, "b.md", "[t](a.md)")

    rename_note(vault, "a.md", "my notes/new name.md")

    assert read(vault, "b.md") == "[t](my%20notes/new%20name.md)"


def test_encoded_markdown_links_stay_encoded(vault):
    write(vault, "old name.md")
    write(vault, "b.md", "[t](old%20name.md)")

    rename_note(vault, "old name.md", "new name.md")

    assert read(vault, "b.md") == "[t](new%20name.md)"


def test_other_markdown_links_are_left_alone(vault):
    write(vault, "a.md")
    write(vault, "a.pdf", b"x")
    text = "[w](https://x.test/a.md) [m](mailto:a@x.test) [h](#a) [n](missing.md) [p](a.pdf) `[c](a.md)`"
    write(vault, "b.md", text)

    assert rename_note(vault, "a.md", "c.md") == []
    assert read(vault, "b.md") == text


def test_folder_moves_update_markdown_links(vault):
    write(vault, "work/a.md", "[t](b.md)")
    write(vault, "work/b.md")
    write(vault, "c.md", "[t](work/a.md#part)")

    assert rename_folder(vault, "work", "x/done") == ["c.md"]

    assert read(vault, "c.md") == "[t](x/done/a.md#part)"
    assert read(vault, "x/done/a.md") == "[t](b.md)"


def test_backlinks_find_every_way_of_writing_a_path():
    resolver = note_index.link_resolver({"work/a.md", "b.md"})

    assert resolver.resolve_mdlink("../b.md", "work") == "b.md"
    assert resolver.resolve_mdlink("/work/a.md", "") == "work/a.md"
    assert resolver.resolve_mdlink("a.md", "") == "work/a.md"
    assert resolver.resolve_mdlink("a%2Emd#x", "work") == "work/a.md"
    assert resolver.resolve_mdlink("../../b.md", "") is None


# --- Folders

def test_renaming_a_folder_updates_links_into_it(vault):
    write(vault, "work/a.md")
    write(vault, "work/a.attachments/p.png", b"x")
    write(vault, "work/loose.png", b"x")
    write(vault, "b.md", "![[work/a.attachments/p.png]] ![x](work/loose.png) [[work/a]] [[a]]")
    write(vault, "deep/c.md", "![[../work/loose.png|100]]")

    assert rename_folder(vault, "work", "done") == ["b.md", "deep/c.md"]

    assert read(vault, "b.md") == "![[done/a.attachments/p.png]] ![x](done/loose.png) [[done/a]] [[a]]"
    assert read(vault, "deep/c.md") == "![[../done/loose.png|100]]"


def test_moving_a_folder_deeper_updates_links_out_of_it(vault):
    write(vault, "photo.png", b"x")
    write(vault, "work/a.md", "![[../photo.png]] [[top]]")
    write(vault, "top.md")

    assert rename_folder(vault, "work", "x/y/work") == ["x/y/work/a.md"]

    assert read(vault, "x/y/work/a.md") == "![[../../../photo.png]] [[top]]"


def test_links_inside_a_moved_folder_stay_as_they_are(vault):
    text = "![[a.attachments/p.png]] [[b]] ![[sub/q.png]]"
    write(vault, "work/a.md", text)
    write(vault, "work/a.attachments/p.png", b"x")
    write(vault, "work/sub/q.png", b"x")
    write(vault, "work/b.md")

    assert rename_folder(vault, "work", "x/done") == []
    assert read(vault, "x/done/a.md") == text


def test_a_folder_with_a_longer_name_is_left_alone(vault):
    write(vault, "work/p.png", b"x")
    write(vault, "work2/p.png", b"x")
    text = "![[work2/p.png]]"
    write(vault, "b.md", text)

    assert rename_folder(vault, "work", "done") == []
    assert read(vault, "b.md") == text


# --- Media

def test_moving_media_updates_every_way_of_writing_it(vault):
    write(vault, "my pics/a b (1).png", b"x")
    write(vault, "n.md", "\n".join([
        "![[my pics/a b (1).png|100]]",
        "![[./my pics/a b (1).png]]",
        "![alt](my%20pics/a%20b%20(1).png)",
        "![alt](my pics/a b (1).png)",
        '![alt](my%20pics/a%20b%20(1).png "A title")',
        "![other](my%20pics/a%20b.png)",
    ]))
    write(vault, "my pics/m.md", "![[a b (1).png]]")

    assert move_file(vault, "my pics/a b (1).png", "new/c d.png") == ["my pics/m.md", "n.md"]

    assert read(vault, "n.md").split("\n") == [
        "![[new/c d.png|100]]",
        "![[new/c d.png]]",
        "![alt](new/c%20d.png)",
        "![alt](new/c d.png)",
        '![alt](new/c%20d.png "A title")',
        "![other](my%20pics/a%20b.png)",
    ]
    assert read(vault, "my pics/m.md") == "![[../new/c d.png]]"


@pytest.mark.parametrize("embed, expected", [
    ("![x](a.pdf#page=2)", "![x](new/a.pdf#page=2)"),
    ("![x](a.pdf?v=1)", "![x](new/a.pdf?v=1)"),
    ("![x](a.pdf?v=1#page=2)", "![x](new/a.pdf?v=1#page=2)"),
    ('![x](a.pdf#page=2 "A title")', '![x](new/a.pdf#page=2 "A title")'),
    ("![[a.pdf#page=2]]", "![[new/a.pdf#page=2]]"),
    ("![[a.pdf#page=2|shown]]", "![[new/a.pdf#page=2|shown]]"),
])
def test_moving_media_keeps_what_follows_the_path(vault, embed, expected):
    write(vault, "a.pdf", b"x")
    write(vault, "n.md", embed)

    assert move_file(vault, "a.pdf", "new/a.pdf") == ["n.md"]
    assert read(vault, "n.md") == expected


@pytest.mark.parametrize("link, expected", [
    ("[t](a.pdf)", "[t](new/a.pdf)"),
    ("[t](a.pdf#page=2)", "[t](new/a.pdf#page=2)"),
    ('[t](a.pdf "A title")', '[t](new/a.pdf "A title")'),
    ("[t](./a.pdf)", "[t](new/a.pdf)"),
    ("[t](/a.pdf)", "[t](/new/a.pdf)"),
])
def test_moving_a_file_updates_markdown_links_to_it(vault, link, expected):
    write(vault, "a.pdf", b"x")
    write(vault, "n.md", link)

    assert move_file(vault, "a.pdf", "new/a.pdf") == ["n.md"]
    assert read(vault, "n.md") == expected


def test_file_links_are_written_from_the_note_holding_them(vault):
    write(vault, "work/my file.pdf", b"x")
    write(vault, "work/n.md", "[t](my%20file.pdf)")
    write(vault, "deep/m.md", "[t](../work/my%20file.pdf)")
    write(vault, "deep/from root.md", "[t](work/my%20file.pdf)")

    updated = move_file(vault, "work/my file.pdf", "done/b.pdf")

    assert updated == ["deep/from root.md", "deep/m.md", "work/n.md"]
    assert read(vault, "work/n.md") == "[t](../done/b.pdf)"
    assert read(vault, "deep/m.md") == "[t](../done/b.pdf)"
    assert read(vault, "deep/from root.md") == "[t](done/b.pdf)"


def test_a_file_beside_the_note_wins_over_one_at_the_root(vault):
    write(vault, "a.pdf", b"x")
    write(vault, "sub/a.pdf", b"x")
    write(vault, "sub/n.md", "[t](a.pdf)")

    assert move_file(vault, "a.pdf", "b.pdf") == []
    assert read(vault, "sub/n.md") == "[t](a.pdf)"


def test_folder_and_note_moves_update_file_links(vault):
    write(vault, "work/a.pdf", b"x")
    write(vault, "n.md", "[t](work/a.pdf)")
    write(vault, "work/m.md", "[t](a.pdf)")
    write(vault, "o.attachments/e.pdf", b"x")
    write(vault, "o.md", "[t](o.attachments/e.pdf)")

    assert rename_folder(vault, "work", "done") == ["n.md"]
    assert read(vault, "n.md") == "[t](done/a.pdf)"
    assert read(vault, "done/m.md") == "[t](a.pdf)"

    assert rename_note(vault, "o.md", "p.md") == ["p.md"]
    assert read(vault, "p.md") == "[t](p.attachments/e.pdf)"


def test_a_moved_note_keeps_its_file_links(vault):
    write(vault, "sub/a.pdf", b"x")
    write(vault, "sub/n.md", "[t](a.pdf)")

    assert rename_note(vault, "sub/n.md", "other/deep/n.md") == ["other/deep/n.md"]
    assert read(vault, "other/deep/n.md") == "[t](../../sub/a.pdf)"


def test_a_file_link_cannot_be_pointed_outside_the_vault(vault):
    root = vault / "vault"
    outside = vault / "secret.pdf"
    outside.write_bytes(b"x")
    write(root, "n.md", "[t](../secret.pdf)")

    assert rename_note(root, "n.md", "work/n.md") == []
    assert read(root, "work/n.md") == "[t](../secret.pdf)"


def test_a_hash_in_a_real_file_name_is_part_of_the_name(vault):
    write(vault, "a#1.png", b"x")
    write(vault, "n.md", "![[a#1.png]] ![x](a%231.png)")

    assert move_file(vault, "a#1.png", "new/a#1.png") == ["n.md"]
    assert read(vault, "n.md") == "![[new/a#1.png]] ![x](new/a%231.png)"


def test_embeds_stay_valid_with_spaces_in_the_new_path(vault):
    write(vault, "a.png", b"x")
    write(vault, "n.md", "![x](a.png) ![[a.png]]")

    move_file(vault, "a.png", "my pics/a (1).png")

    assert read(vault, "n.md") == "![x](my%20pics/a%20%281%29.png) ![[my pics/a (1).png]]"


def test_a_file_with_the_same_start_is_left_alone(vault):
    write(vault, "a.png", b"x")
    write(vault, "a.png.bak", b"x")
    text = "![[a.png.bak]]"
    write(vault, "n.md", text)

    assert move_file(vault, "a.png", "b.png") == []
    assert read(vault, "n.md") == text


def test_addresses_and_missing_files_are_left_alone(vault):
    write(vault, "a.md")
    text = "![x](https://example.com/a.png) ![x](data:image/png;base64,AA) ![[gone.png]] ![x](/api/media/a.png)"
    write(vault, "a.md", text)

    assert rename_note(vault, "a.md", "work/a.md") == []
    assert read(vault, "work/a.md") == text


def test_a_moved_note_keeps_its_embeds_of_other_files(vault):
    write(vault, "pics/p.png", b"x")
    write(vault, "a.md", "![[pics/p.png]]")

    assert rename_note(vault, "a.md", "work/deep/a.md") == ["work/deep/a.md"]
    assert read(vault, "work/deep/a.md") == "![[../../pics/p.png]]"


def test_embeds_cannot_be_pointed_outside_the_vault(vault):
    outside = vault.parent / "outside.png"
    outside.write_bytes(b"x")
    root = vault / "vault"
    write(root, "a.md", "![[../outside.png]]")
    try:
        assert rename_note(root, "a.md", "work/a.md") == []
        assert read(root, "work/a.md") == "![[../outside.png]]"
    finally:
        outside.unlink()


def test_an_unreadable_note_does_not_stop_the_others(vault):
    write(vault, "a.md")
    write(vault, "bad.md", b"\xff\xfe [[a]]")
    write(vault, "good.md", "[[a]]")

    assert rename_note(vault, "a.md", "b.md") == ["good.md"]
    assert read(vault, "good.md") == "[[b]]"


# --- Routes

@pytest.fixture
def client(vault, monkeypatch):
    monkeypatch.setitem(main.config["storage"], "notes_dir", str(vault))
    main.limiter.enabled = False
    yield TestClient(main.app)
    main.limiter.enabled = True


def test_routes_report_the_notes_they_changed(vault, client):
    write(vault, "work/a.md", "[[work/a]]")
    write(vault, "p.png", b"x")
    write(vault, "b.md", "[[work/a]] ![[p.png]]")

    moved = client.post("/api/folders/move", json={"oldPath": "work", "newPath": "x/work"}).json()
    assert sorted(moved["updatedNotes"]) == ["b.md", "x/work/a.md"]

    renamed = client.post("/api/folders/rename", json={"oldPath": "x", "newPath": "y"}).json()
    assert sorted(renamed["updatedNotes"]) == ["b.md", "y/work/a.md"]

    media = client.post("/api/media/move", json={"oldPath": "p.png", "newPath": "q.png"}).json()
    assert media["updatedNotes"] == ["b.md"]

    note = client.post("/api/notes/move", json={"oldPath": "y/work/a.md", "newPath": "y/work/c.md"}).json()
    assert sorted(note["updatedNotes"]) == ["b.md", "y/work/c.md"]
    assert note["content"] == "[[y/work/c]]"
    assert note["hash"] == client.get("/api/notes/y/work/c.md").json()["hash"]
    assert read(vault, "b.md") == "[[y/work/c]] ![[q.png]]"


def test_note_move_without_changes_to_itself_has_no_content(vault, client):
    write(vault, "a.md")

    note = client.post("/api/notes/move", json={"oldPath": "a.md", "newPath": "b.md"}).json()

    assert note["updatedNotes"] == []
    assert "content" not in note
