"""
Trash: everything deleted moves into `.trash/` until it is emptied by hand.

Each deletion is one entry, so a note and its attachments come back together:

    .trash/<id>/entry.json        where it came from
    .trash/<id>/meeting.md
    .trash/<id>/meeting.attachments/

Only folders with a valid id and entry.json count as entries. Anything else in
`.trash/`, such as files another app keeps there, is ignored and never touched.
"""

import json
import logging
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

TRASH_DIR = ".trash"
ENTRY_FILE = "entry.json"
ENTRY_TYPES = ("note", "folder", "media")
_ENTRY_ID = re.compile(r"[0-9a-f]{32}")


def _trash_root(notes_dir: str) -> Path:
    return Path(notes_dir) / TRASH_DIR


def _read_entry(entry_dir: Path) -> Optional[Dict]:
    """The contents of entry.json, or None if this isn't one of our entries."""
    if not _ENTRY_ID.fullmatch(entry_dir.name):
        return None
    try:
        entry = json.loads((entry_dir / ENTRY_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(entry, dict) or entry.get("type") not in ENTRY_TYPES:
        return None
    if not isinstance(entry.get("path"), str) or not isinstance(entry.get("deletedAt"), str):
        return None
    return entry


def _find_entry(notes_dir: str, entry_id: str) -> Optional[Path]:
    """The folder of a valid entry. The id is checked first, so it can't name a path."""
    if not _ENTRY_ID.fullmatch(entry_id):
        return None
    entry_dir = _trash_root(notes_dir) / entry_id
    return entry_dir if _read_entry(entry_dir) else None


def _size_of(entry_dir: Path) -> int:
    total = 0
    for item in entry_dir.rglob("*"):
        try:
            if item.is_file() and not item.is_symlink() and item.name != ENTRY_FILE:
                total += item.stat().st_size
        except OSError:
            continue
    return total


def move_to_trash(notes_dir: str, path: str, entry_type: str, items: List[Path]) -> bool:
    """
    Move items into a new entry. `path` is where the main item lives, relative to the vault.

    entry.json is written first: if the process dies halfway, the entry still
    lists what it holds and can be restored. Any other failure puts things back.
    """
    entry_dir = _trash_root(notes_dir) / uuid.uuid4().hex
    moved = []
    try:
        entry_dir.mkdir(parents=True)
        (entry_dir / ENTRY_FILE).write_text(json.dumps({
            "path": path,
            "type": entry_type,
            "deletedAt": datetime.now(timezone.utc).isoformat(),
        }), encoding="utf-8")
        for item in items:
            shutil.move(str(item), str(entry_dir / item.name))
            moved.append(item)
        return True
    except OSError as e:
        logger.error("Could not move '%s' to the trash: %s", path, e)
        for item in moved:
            shutil.move(str(entry_dir / item.name), str(item))
        shutil.rmtree(entry_dir, ignore_errors=True)
        return False


def list_trash(notes_dir: str) -> List[Dict]:
    """Every entry, most recently deleted first."""
    root = _trash_root(notes_dir)
    if not root.is_dir():
        return []
    items = []
    for entry_dir in root.iterdir():
        entry = _read_entry(entry_dir)
        if not entry:
            continue
        path = Path(entry["path"])
        folder = path.parent.as_posix()
        items.append({
            "id": entry_dir.name,
            "name": path.stem if entry["type"] == "note" else path.name,
            "path": entry["path"],
            "folder": "" if folder == "." else folder,
            "type": entry["type"],
            "deletedAt": entry["deletedAt"],
            "size": _size_of(entry_dir),
        })
    return sorted(items, key=lambda item: item["deletedAt"], reverse=True)


def _free_path(notes_dir: str, path: str, entry_type: str) -> str:
    """`path`, or photo-1.png, photo-2.png... if something is already there."""
    from .utils import folder_name_conflict, get_attachment_dir, note_name_conflict

    original = Path(path)
    stem, suffix = (original.name, "") if entry_type == "folder" else (original.stem, original.suffix)

    def taken(candidate: str) -> bool:
        if (Path(notes_dir) / candidate).exists():
            return True
        if entry_type == "note":
            return bool(note_name_conflict(notes_dir, candidate)) or get_attachment_dir(notes_dir, candidate).exists()
        if entry_type == "folder":
            return bool(folder_name_conflict(notes_dir, candidate))
        return False

    candidate, counter = path, 0
    while taken(candidate):
        counter += 1
        candidate = (original.parent / f"{stem}-{counter}{suffix}").as_posix()
    return candidate


def restore_entry(notes_dir: str, entry_id: str) -> Optional[str]:
    """Put an entry back. Returns where it ended up, or None if it couldn't be restored."""
    from . import note_index
    from .utils import (
        _scan_cache_invalidate,
        get_attachment_dir,
        rewrite_attachment_links,
        save_note,
        validate_path_security,
    )

    entry_dir = _find_entry(notes_dir, entry_id)
    if entry_dir is None:
        return None
    entry = _read_entry(entry_dir)
    path = entry["path"]
    base = Path(notes_dir)
    source = entry_dir / Path(path).name
    # entry.json is a plain file in the vault, so its path gets the usual check
    if not source.exists() or not validate_path_security(notes_dir, base / path):
        return None

    final_path = _free_path(notes_dir, path, entry["type"])
    moves = [(source, base / final_path)]
    is_note = entry["type"] == "note"
    if is_note:
        old_attachments = entry_dir / get_attachment_dir(notes_dir, path).name
        new_attachments = get_attachment_dir(notes_dir, final_path)
        if old_attachments.is_dir():
            moves.append((old_attachments, new_attachments))

    done = []
    try:
        (base / final_path).parent.mkdir(parents=True, exist_ok=True)
        for origin, destination in moves:
            shutil.move(str(origin), str(destination))
            done.append((origin, destination))
    except OSError as e:
        logger.error("Could not restore '%s': %s", path, e)
        for origin, destination in done:
            shutil.move(str(destination), str(origin))
        return None

    shutil.rmtree(entry_dir, ignore_errors=True)
    if is_note and len(moves) > 1 and old_attachments.name != new_attachments.name:
        text = (base / final_path).read_text(encoding="utf-8")
        rewritten = rewrite_attachment_links(text, old_attachments.name, new_attachments.name)
        if rewritten != text:
            save_note(notes_dir, final_path, rewritten)

    note_index.on_restored()
    _scan_cache_invalidate()
    return final_path


def delete_entry(notes_dir: str, entry_id: str) -> bool:
    """Permanently delete one entry."""
    entry_dir = _find_entry(notes_dir, entry_id)
    if entry_dir is None:
        return False
    shutil.rmtree(entry_dir)
    return True


def empty_trash(notes_dir: str) -> int:
    """Permanently delete every entry. Returns how many were removed."""
    entries = list_trash(notes_dir)
    for entry in entries:
        shutil.rmtree(_trash_root(notes_dir) / entry["id"])
    return len(entries)
