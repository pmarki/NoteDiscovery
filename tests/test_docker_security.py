"""What keeps the Docker image and its sessions safe to run."""

import os
import re
import stat
import sys
from pathlib import Path

from backend import main

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import check_requirements_lock  # noqa: E402


def test_a_session_key_is_generated_once_and_kept(tmp_path):
    key = main.load_or_create_secret_key(tmp_path / "notes")
    path = tmp_path / "notes" / main.SECRET_KEY_FILE

    assert len(key) == 64 and key not in main.DEFAULT_SECRET_KEYS
    assert path.read_text() == key
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert main.load_or_create_secret_key(tmp_path / "notes") == key
    assert [p.name for p in path.parent.iterdir()] == [main.SECRET_KEY_FILE]


def test_an_empty_key_file_never_gives_an_empty_key(tmp_path):
    (tmp_path / main.SECRET_KEY_FILE).write_text("")

    assert len(main.load_or_create_secret_key(tmp_path)) == 64


def test_the_shipped_config_has_no_usable_secret_key():
    example = (ROOT / "config.example.yaml").read_text(encoding="utf-8")

    assert re.search(r'^\s*secret_key:\s*""', example, re.MULTILINE)


def test_the_requirements_lock_matches_the_requirements():
    assert check_requirements_lock.mismatches() == []


def test_every_locked_package_has_a_hash():
    lock = (ROOT / "requirements.lock").read_text(encoding="utf-8")
    entries = re.split(r"\n(?=[A-Za-z])", lock.split("\n", 1)[1] if lock.startswith("#") else lock)

    assert all("--hash=sha256:" in entry for entry in entries if "==" in entry)


def test_the_image_is_built_from_pinned_parts_only():
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")

    for base in re.findall(r"^FROM\s+(\S+)", dockerfile, re.MULTILINE):
        assert re.search(r"@sha256:[0-9a-f]{64}$", base), base
    assert "npm install" not in dockerfile and "npm ci" in dockerfile
    assert "--require-hashes" in dockerfile
    assert not re.search(r"^COPY config\.yaml", dockerfile, re.MULTILINE)


def test_the_app_does_not_run_as_root():
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    entrypoint = (ROOT / "docker-entrypoint.sh").read_text(encoding="utf-8")

    assert 'ENTRYPOINT ["docker-entrypoint.sh"]' in dockerfile
    assert "exec setpriv --reuid=" in entrypoint
    assert os.access(ROOT / "docker-entrypoint.sh", os.X_OK)
