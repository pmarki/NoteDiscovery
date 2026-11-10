"""Check that requirements.lock pins the versions requirements.txt asks for.

requirements.txt lists the direct dependencies and works on every platform.
requirements.lock pins them and everything they pull in, with hashes, for the
Docker image (Linux, Python 3.11). Regenerate it after changing requirements.txt:

    docker run --rm -i python:3.11-slim sh -c 'cd /tmp && cat > requirements.txt && \
        pip install -q pip-tools && pip-compile -q --generate-hashes --strip-extras \
        --no-header --output-file=requirements.lock requirements.txt && cat requirements.lock' \
        < requirements.txt > requirements.lock
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIN = re.compile(r"^([A-Za-z0-9._-]+)(?:\[[^\]]*\])?==([^\s;\\]+)")


def pins(path):
    found = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = PIN.match(line.strip())
        if match:
            found[re.sub(r"[-_.]+", "-", match.group(1)).lower()] = match.group(2)
    return found


def mismatches(root=ROOT):
    wanted = pins(root / "requirements.txt")
    locked = pins(root / "requirements.lock")
    return [
        f"{name}: requirements.txt has {version}, requirements.lock has {locked.get(name, 'nothing')}"
        for name, version in sorted(wanted.items())
        if locked.get(name) != version
    ]


if __name__ == "__main__":
    problems = mismatches()
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        print("requirements.lock is out of date; see scripts/check_requirements_lock.py", file=sys.stderr)
    sys.exit(1 if problems else 0)
