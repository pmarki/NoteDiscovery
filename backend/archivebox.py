"""
Offline copies of carded links, kept by an ArchiveBox server (https://archivebox.io).

NoteDiscovery hands each new card's address to ArchiveBox and later asks how the
snapshot went. The copies stay in ArchiveBox; the app serves the few that make
sense on their own (the single-file page, the PDF and the screenshot) through its
own login, so ArchiveBox needn't be reachable from outside.

ArchiveBox's REST API is still in alpha and differs between releases, so this
reads its answers loosely: either `plugin` (0.9) or `extractor` (0.8), either
`output_files`/`output_str` or `output`.

The server is the admin's own, typically another container on a private network,
so it's reached directly, without the checks link_preview.fetch applies to
addresses taken from notes.
"""

import json
import re
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT_SECONDS = 10

# What a card offers, and which ArchiveBox outputs supply it, best first. `article`
# is the page as a reader view; `text` is its plain text, for search and MCP.
KINDS = {
    "page": {"plugins": ("singlefile",), "extensions": (".html", ".htm"), "default": "singlefile.html"},
    "pdf": {"plugins": ("pdf",), "extensions": (".pdf",), "default": "output.pdf"},
    "screenshot": {"plugins": ("screenshot",), "extensions": (".png", ".jpg", ".jpeg", ".webp"), "default": "screenshot.png"},
    "article": {"plugins": ("readability", "trafilatura", "defuddle", "mercury"), "extensions": (".html",),
                "default": None},
    # 0.9 shows trafilatura's .txt as a web page, so it comes last
    "text": {"plugins": ("defuddle", "readability", "mercury", "htmltotext", "trafilatura"), "extensions": (".txt",),
             "default": None},
}
DONE = {"succeeded", "failed", "skipped", "sealed", "noresults", "exception"}


class ArchiveBoxError(Exception):
    """ArchiveBox couldn't be reached or refused. The message is safe to show."""


def _safe_path(path):
    """A path inside the snapshot folder, or None."""
    path = str(path or "").strip()
    if path.startswith("./"):
        path = path[2:]
    if not path or path.startswith("/") or "\\" in path or "://" in path:
        return None
    if any(part in ("", ".", "..") for part in path.split("/")):
        return None
    return path


def _output_path(result, plugin, kind):
    """Where a finished output sits inside its snapshot folder."""
    spec = KINDS[kind]
    # 0.9 puts each plugin's files in a folder of its own and lists them
    files = result.get("output_files")
    if isinstance(files, dict) and files:
        in_plugin_dir = str(result.get("pwd") or "").rstrip("/").endswith("/" + plugin)
        for name in sorted(files):
            if name.lower().endswith(spec["extensions"]):
                return _safe_path(f"{plugin}/{name}" if in_plugin_dir else name)
    for field in ("output_str", "output"):
        value = result.get(field)
        if isinstance(value, str) and value.lower().endswith(spec["extensions"]):
            return _safe_path(value)
    return spec["default"]


def snapshot_state(snapshot):
    """Status of a snapshot as a card shows it: pending, archived or failed, and its outputs."""
    results = snapshot.get("archiveresults") or []
    found = {}  # kind -> (rank of its plugin, path)
    unfinished = False
    for result in results:
        plugin = str(result.get("plugin") or result.get("extractor") or "").lower()
        status = str(result.get("status") or "").lower()
        if status not in DONE:
            unfinished = True
        if status != "succeeded":
            continue
        for kind, spec in KINDS.items():
            if plugin not in spec["plugins"]:
                continue
            rank = spec["plugins"].index(plugin)
            if kind in found and found[kind][0] <= rank:
                continue
            path = _output_path(result, plugin, kind)
            if path:
                found[kind] = (rank, path)
    outputs = {kind: path for kind, (_, path) in found.items()}
    sealed = str(snapshot.get("status") or "").lower() == "sealed"
    if (sealed or results) and not unfinished:
        # Text alone is no copy to open
        status = "archived" if set(outputs) - {"text"} else "failed"
    else:
        status = "pending"
    return {
        "status": status,
        "snapshot_id": str(snapshot.get("id") or ""),
        "timestamp": str(snapshot.get("timestamp") or ""),
        "outputs": outputs,
    }


class ArchiveBox:
    def __init__(self, url: str, api_key: str, tag: str = "notediscovery"):
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.tag = tag

    def _open(self, path, *, params=None, body=None, accept="application/json"):
        address = self.url + path
        if params:
            address += "?" + urllib.parse.urlencode(params)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(address, data=data, method="POST" if data else "GET", headers={
            "Accept": accept,
            "X-ArchiveBox-API-Key": self.api_key,
            **({"Content-Type": "application/json"} if data else {}),
        })
        try:
            return urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS)
        except urllib.error.HTTPError as error:
            detail = error.read(2000).decode("utf-8", "replace")
            error.close()
            # 0.9 takes changes only at the host name in its BASE_URL
            if "control plane" in detail:
                raise ArchiveBoxError("ArchiveBox takes new pages only at the address in its BASE_URL; "
                                      "make archivebox.url use that host name") from error
            if error.code in (401, 403):
                raise ArchiveBoxError("ArchiveBox refused the API key") from error
            raise ArchiveBoxError(f"ArchiveBox answered {error.code}") from error
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise ArchiveBoxError("ArchiveBox can't be reached") from error

    def _json(self, path, **kwargs):
        with self._open(path, **kwargs) as response:
            try:
                return json.loads(response.read().decode("utf-8"))
            except ValueError as error:
                raise ArchiveBoxError("ArchiveBox sent something that isn't JSON") from error

    def submit(self, url: str, again: bool = False) -> None:
        """Queue `url` for archiving. `again` archives it anew though a snapshot exists."""
        answer = self._json("/api/v1/cli/add", body={
            "urls": [url], "tag": self.tag, "depth": 0, "update": again,
        })
        if isinstance(answer, dict) and answer.get("success") is False:
            raise ArchiveBoxError("; ".join(map(str, answer.get("errors") or [])) or "ArchiveBox refused the address")

    def snapshot(self, url: str):
        """The newest snapshot of `url` with its results, or None."""
        answer = self._json("/api/v1/core/snapshots", params={"url": url, "with_archiveresults": "true", "limit": 10})
        items = answer.get("items", answer.get("results", [])) if isinstance(answer, dict) else answer
        items = [item for item in items or [] if isinstance(item, dict) and item.get("url") == url]
        if not items:
            return None
        return max(items, key=lambda item: str(item.get("created_at") or item.get("bookmarked_at") or item.get("timestamp") or ""))

    def open_file(self, snapshot_id: str, timestamp: str, path: str):
        """The response for a file of a snapshot, to be read and closed by the caller.

        0.9 serves them at /snapshot/<id>/; its /archive/<timestamp>/ only redirects
        there, to the host name ArchiveBox thinks it has. 0.8 has only the latter.
        """
        if not _safe_path(path):
            raise ArchiveBoxError("Not a snapshot file")
        quoted = "/".join(urllib.parse.quote(part) for part in path.split("/"))
        if re.fullmatch(r"[0-9a-fA-F-]{8,64}", snapshot_id or ""):
            return self._open(f"/snapshot/{snapshot_id}/{quoted}", accept="*/*")
        if re.fullmatch(r"[0-9.]+", timestamp or ""):
            return self._open(f"/archive/{timestamp}/{quoted}", accept="*/*")
        raise ArchiveBoxError("Not a snapshot file")
