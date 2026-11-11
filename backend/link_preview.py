"""
Previews of web pages, for the cards the editor shows for a URL on its own line.

The server fetches the page, because a browser can't read another site, and keeps
what it found in `.links/` in the vault, so a card needs no network once it exists:

    .links/<key>.json        title, description, site name, when it was fetched
    .links/<key>.webp        the page's preview image, scaled down
    .links/<key>.icon.png    its icon

<key> is a hash of the URL, so a link used in many notes is fetched once. The folder
starts with a dot, so the tree, search and the index never see it.

With an ArchiveBox server configured, each entry also tracks the page's offline
copy there (see backend/archivebox.py): queued when the card is first made, then
checked now and then while a card asks for it, until it's archived or failed.

The URLs come from notes, so fetching must not become a way into the server's own
network: every address a host resolves to is checked, the connection goes to the
checked address, and each redirect is checked again (see `fetch`).
"""

import hashlib
import http.client
import io
import ipaddress
import json
import os
import re
import socket
import ssl
import tempfile
import threading
import time
import zlib
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, urljoin, urlsplit

from PIL import Image, ImageOps

from .archivebox import ArchiveBoxError, snapshot_state

LINKS_DIR = ".links"
USER_AGENT = "Mozilla/5.0 (compatible; NoteDiscovery link preview)"
MAX_URL_LENGTH = 2048
MAX_PAGE_BYTES = 1024 * 1024  # Metadata is in the head; this is plenty
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_REDIRECTS = 5
TIMEOUT_SECONDS = 8
IMAGE_SIZE = (800, 800)
ICON_SIZE = (64, 64)
# A page that failed is tried again after this, rather than on every view
ERROR_RETRY_SECONDS = 24 * 3600
# How often a card that's still being archived asks ArchiveBox again
ARCHIVE_CHECK_SECONDS = 15
# ArchiveBox unreachable: queued again on a view after this
ARCHIVE_RETRY_SECONDS = 600
# Queued but never seen in ArchiveBox: given up after this
ARCHIVE_GIVE_UP_SECONDS = 3600
# At most this many pages are fetched at once, whatever the number of cards on screen
_fetch_slots = threading.BoundedSemaphore(4)
_key_locks: dict = {}
_key_locks_guard = threading.Lock()

# Sites whose pages say little to a fetcher, but which answer oEmbed
OEMBED_PROVIDERS = [
    (re.compile(r"^https?://((www|m|music)\.)?youtube\.com/(watch|shorts/|live/)|^https?://youtu\.be/"),
     "https://www.youtube.com/oembed?format=json&url="),
    (re.compile(r"^https?://(www\.)?vimeo\.com/\d"), "https://vimeo.com/api/oembed.json?url="),
]


class PreviewError(Exception):
    """The page couldn't be fetched or read. The message is safe to show."""


class BlockedAddress(PreviewError):
    """The host is, or redirected to, an address the server may not reach."""


def normalize_url(url: str) -> str:
    """The URL to fetch and key the cache on, or PreviewError if it isn't a web address."""
    url = (url or "").strip()
    if len(url) > MAX_URL_LENGTH:
        raise PreviewError("URL is too long")
    parts = urlsplit(url)
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise PreviewError("Only http and https links have previews")
    # The fragment only moves within the page, so it's the same preview
    return parts._replace(scheme=parts.scheme.lower(), fragment="").geturl()


def cache_key(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]


def public_address(address: str) -> bool:
    """True for an address on the internet, not on this machine or its networks."""
    ip = ipaddress.ip_address(address.split("%", 1)[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

class _PinnedHTTPConnection(http.client.HTTPConnection):
    """Connects to an address already checked, so DNS can't answer differently the second time."""

    def __init__(self, host, port, address, timeout):
        super().__init__(host, port, timeout=timeout)
        self._address = address

    def connect(self):
        self.sock = socket.create_connection((self._address, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, address, timeout):
        super().__init__(host, port, timeout=timeout, context=ssl.create_default_context())
        self._address = address

    def connect(self):
        sock = socket.create_connection((self._address, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _resolve(host: str, port: int, allowed) -> str:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        raise PreviewError("Host not found")
    addresses = [info[4][0] for info in infos]
    # All of them, since the connection could otherwise be steered to one that isn't
    if not addresses or not all(allowed(address) for address in addresses):
        raise BlockedAddress("Links to this server's own network have no preview")
    return addresses[0]


def _read_body(response, limit: int) -> bytes:
    """The body, decompressed, cut at `limit` bytes."""
    encoding = (response.getheader("Content-Encoding") or "").lower()
    if encoding in ("gzip", "deflate"):
        decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS)
    elif encoding in ("", "identity"):
        decompressor = None
    else:
        raise PreviewError(f"Unsupported encoding {encoding}")
    out = bytearray()
    while len(out) < limit:
        chunk = response.read(64 * 1024)
        if not chunk:
            break
        out += decompressor.decompress(chunk, limit - len(out)) if decompressor else chunk
    return bytes(out[:limit])


def fetch(url: str, *, limit: int, accept: str, allowed=public_address):
    """GET `url`, following redirects.

    Returns (final URL, media type, the whole Content-Type header, body).

    `allowed(address)` decides which resolved addresses may be reached; by default
    only public ones. Each redirect is resolved and checked again.
    """
    deadline = time.monotonic() + TIMEOUT_SECONDS
    for _ in range(MAX_REDIRECTS + 1):
        if time.monotonic() > deadline:
            raise PreviewError("The site took too long")
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise PreviewError("Redirected to something that isn't a web page")
        https = parts.scheme == "https"
        port = parts.port or (443 if https else 80)
        address = _resolve(parts.hostname, port, allowed)
        timeout = max(1.0, deadline - time.monotonic())
        connection_class = _PinnedHTTPSConnection if https else _PinnedHTTPConnection
        connection = connection_class(parts.hostname, port, address, timeout)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        try:
            connection.request("GET", quote(path, safe="/?&=%:@!$'()*+,;~-._"), headers={
                "User-Agent": USER_AGENT,
                "Accept": accept,
                "Accept-Encoding": "gzip, deflate",
                "Accept-Language": "en;q=0.9, *;q=0.5",
            })
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    raise PreviewError("Redirect without a target")
                url = urljoin(url, location)
                continue
            if response.status >= 400:
                raise PreviewError(f"The site answered {response.status}")
            content_type = (response.getheader("Content-Type") or "").split(";")[0].strip().lower()
            return url, content_type, response.getheader("Content-Type") or "", _read_body(response, limit)
        except (OSError, http.client.HTTPException, zlib.error) as error:
            raise PreviewError(f"Couldn't reach the site ({type(error).__name__})") from error
        finally:
            connection.close()
    raise PreviewError("Too many redirects")


# ---------------------------------------------------------------------------
# Reading the page
# ---------------------------------------------------------------------------

class _HeadParser(HTMLParser):
    """Collects the <meta>, <link> and <title> a preview is made of."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
        self.links = []
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        attrs = {name.lower(): (value or "") for name, value in attrs}
        if tag == "meta":
            name = (attrs.get("property") or attrs.get("name") or "").strip().lower()
            if name and "content" in attrs:
                self.meta.setdefault(name, attrs["content"].strip())
        elif tag == "link":
            self.links.append(attrs)
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def _decode(body: bytes, content_type_header: str) -> str:
    match = re.search(r"charset=([\w-]+)", content_type_header, re.I) \
        or re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", body[:4096], re.I)
    charset = match.group(1) if match else "utf-8"
    if isinstance(charset, bytes):
        charset = charset.decode("ascii", "ignore")
    try:
        return body.decode(charset, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def _clean(text, limit):
    text = re.sub(r"\s+", " ", text or "").strip()
    return text[: limit - 1].rstrip() + "…" if len(text) > limit else text


def parse_page(html: str, page_url: str) -> dict:
    """Title, description, site name, image, icon and oEmbed address found in a page."""
    parser = _HeadParser()
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        pass  # Whatever was read before the broken part still counts
    meta = parser.meta

    def first(*names):
        return next((meta[name] for name in names if meta.get(name)), "")

    def absolute(href):
        return urljoin(page_url, href.strip()) if href and href.strip() else ""

    icon = ""
    oembed = ""
    for link in parser.links:
        rels = link.get("rel", "").lower().split()
        if not icon and ("icon" in rels or "apple-touch-icon" in rels) and not link.get("href", "").lower().endswith(".svg"):
            icon = absolute(link.get("href"))
        if not oembed and "alternate" in rels and link.get("type", "").lower() == "application/json+oembed":
            oembed = absolute(link.get("href"))
    return {
        "title": _clean(first("og:title", "twitter:title") or parser.title, 300),
        "description": _clean(first("og:description", "twitter:description", "description"), 500),
        "site_name": _clean(first("og:site_name", "application-name"), 100),
        "image": absolute(first("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src")),
        "icon": icon or urljoin(page_url, "/favicon.ico"),
        "oembed": oembed,
    }


def _oembed_endpoint(url: str) -> str:
    for pattern, endpoint in OEMBED_PROVIDERS:
        if pattern.match(url):
            return endpoint + quote(url, safe="")
    return ""


def _read_oembed(endpoint: str, allowed) -> dict:
    _, _, _, body = fetch(endpoint, limit=MAX_PAGE_BYTES, accept="application/json", allowed=allowed)
    data = json.loads(body.decode("utf-8", errors="replace"))
    if not isinstance(data, dict):
        raise PreviewError("Unexpected oEmbed answer")
    return {
        "title": _clean(str(data.get("title") or ""), 300),
        "description": _clean(str(data.get("author_name") or ""), 500),
        "site_name": _clean(str(data.get("provider_name") or ""), 100),
        "image": str(data.get("thumbnail_url") or ""),
    }


def _image_file(body: bytes, size, fmt: str, target: Path) -> None:
    """Re-encodes an image the site sent, so only a plain, small picture is ever stored."""
    try:
        with Image.open(io.BytesIO(body)) as image:
            if image.width * image.height > Image.MAX_IMAGE_PIXELS:
                raise PreviewError("Image is too large")
            image.seek(0)
            picture = ImageOps.exif_transpose(image)
            picture.thumbnail(size)
            if picture.mode not in ("RGB", "RGBA"):
                picture = picture.convert("RGBA")
            out = io.BytesIO()
            picture.save(out, fmt, **({"quality": 80} if fmt == "WEBP" else {}))
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise PreviewError("Image can't be read") from error
    _write_atomic(target, out.getvalue())


def _write_atomic(target: Path, data: bytes) -> None:
    # Written aside and renamed, so a request arriving meanwhile never reads half a file
    fd, temp_name = tempfile.mkstemp(dir=target.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
        os.replace(temp_name, target)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


# ---------------------------------------------------------------------------
# The cache
# ---------------------------------------------------------------------------

class LinkPreviews:
    """Previews kept in `<notes_dir>/.links/`."""

    def __init__(self, notes_dir, allowed=public_address, archive=None):
        self.dir = Path(notes_dir) / LINKS_DIR
        self.allowed = allowed
        self.archive = archive  # An ArchiveBox, or None

    def file(self, name: str):
        """A stored image by its file name, or None. Only names this class writes are served."""
        if not re.fullmatch(r"[0-9a-f]{32}\.(webp|icon\.png)", name):
            return None
        path = self.dir / name
        return path if path.is_file() else None

    def _paths(self, key):
        return self.dir / f"{key}.json", self.dir / f"{key}.webp", self.dir / f"{key}.icon.png"

    def cached(self, url: str):
        """What's stored for `url`, or None."""
        return self.by_key(cache_key(url))

    def by_key(self, key: str):
        """What's stored under a cache key, or None."""
        if not re.fullmatch(r"[0-9a-f]{32}", key or ""):
            return None
        meta_path, _, _ = self._paths(key)
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _locked(self, key):
        with _key_locks_guard:
            return _key_locks.setdefault(key, threading.Lock())

    def _release(self, key, lock):
        with _key_locks_guard:
            if not lock.locked():
                _key_locks.pop(key, None)

    def get(self, url: str, refresh: bool = False) -> dict:
        """The preview of `url`, fetching it when it's new, failed a day ago, or asked to refresh."""
        url = normalize_url(url)
        key = cache_key(url)
        lock = self._locked(key)
        # Cards for the same URL in several notes, opened at once, fetch it once
        with lock:
            entry = self.cached(url)
            stale = entry and entry.get("error") and time.time() - entry.get("fetched_at", 0) > ERROR_RETRY_SECONDS
            if entry is None or stale or refresh:
                with _fetch_slots:
                    entry = self._fetch(url, key, entry)
            if self.archive and not entry.get("blocked"):
                entry = self._follow_archive(key, entry)
        self._release(key, lock)
        return entry

    def archive_again(self, url: str) -> dict:
        """Asks ArchiveBox for a new copy of `url`, after a failed one."""
        url = normalize_url(url)
        key = cache_key(url)
        lock = self._locked(key)
        with lock:
            entry = self.cached(url)
            if entry is None or not self.archive or entry.get("blocked"):
                raise PreviewError("This link has no offline copy")
            entry = self._submit(key, entry, again=True)
        self._release(key, lock)
        return entry

    def _save(self, key, entry):
        meta_path, _, _ = self._paths(key)
        _write_atomic(meta_path, json.dumps(entry, ensure_ascii=False).encode("utf-8"))

    def _submit(self, key, entry, again=False):
        now = int(time.time())
        try:
            self.archive.submit(entry["url"], again=again)
            entry["archive"] = {"status": "pending", "submitted_at": now, "checked_at": now}
        except ArchiveBoxError as error:
            entry["archive"] = {"status": "error", "error": str(error), "checked_at": now}
        self._save(key, entry)
        return entry

    def _follow_archive(self, key, entry):
        """Queues a new card in ArchiveBox, or asks how a queued one is doing."""
        state = entry.get("archive")
        now = time.time()
        if state is None or (state["status"] == "error" and now - state.get("checked_at", 0) > ARCHIVE_RETRY_SECONDS):
            return self._submit(key, entry)
        if state["status"] != "pending" or now - state.get("checked_at", 0) < ARCHIVE_CHECK_SECONDS:
            return entry
        state = dict(state, checked_at=int(now))
        try:
            snapshot = self.archive.snapshot(entry["url"])
        except ArchiveBoxError as error:
            state["error"] = str(error)  # Kept pending: it may just be restarting
            snapshot = None
        if snapshot is not None:
            state.update(snapshot_state(snapshot))
            state.pop("error", None)
        elif now - state.get("submitted_at", 0) > ARCHIVE_GIVE_UP_SECONDS:
            state["status"] = "failed"
        entry["archive"] = state
        self._save(key, entry)
        return entry

    def _fetch(self, url: str, key: str, previous=None) -> dict:
        self.dir.mkdir(parents=True, exist_ok=True)
        _, image_path, icon_path = self._paths(key)
        entry = {"url": url, "title": "", "description": "", "site_name": "", "image": False,
                 "icon": False, "error": None, "fetched_at": int(time.time())}
        # A refreshed preview is still the same page in the archive
        if previous and previous.get("archive"):
            entry["archive"] = previous["archive"]
        try:
            found = self._read(url)
        except PreviewError as error:
            entry["error"] = str(error)
            # Not something ArchiveBox should be sent to either
            entry["blocked"] = isinstance(error, BlockedAddress)
            found = None
        if found:
            entry.update({key_: found[key_] for key_ in ("title", "description", "site_name")})
            entry["image"] = self._store_image(found.get("image"), image_path, IMAGE_SIZE, "WEBP")
            entry["icon"] = self._store_image(found.get("icon"), icon_path, ICON_SIZE, "PNG")
        # An image no longer offered shouldn't linger after a refresh
        for flag, path in (("image", image_path), ("icon", icon_path)):
            if not entry[flag]:
                path.unlink(missing_ok=True)
        self._save(key, entry)
        return entry

    def _read(self, url: str) -> dict:
        endpoint = _oembed_endpoint(url)
        if endpoint:
            try:
                found = _read_oembed(endpoint, self.allowed)
                found["icon"] = urljoin(url, "/favicon.ico")
                if found["title"]:
                    return found
            except (PreviewError, ValueError):
                pass  # The page itself may still say enough
        final_url, content_type, content_type_header, body = fetch(
            url, limit=MAX_PAGE_BYTES, accept="text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", allowed=self.allowed)
        name = urlsplit(final_url).path.rstrip("/").rsplit("/", 1)[-1]
        if content_type.startswith("image/"):
            return {"title": name, "description": "", "site_name": "", "image": final_url, "icon": ""}
        if content_type not in ("text/html", "application/xhtml+xml"):
            return {"title": name, "description": content_type, "site_name": "", "image": "",
                    "icon": urljoin(final_url, "/favicon.ico")}
        found = parse_page(_decode(body, content_type_header), final_url)
        if found["oembed"] and not (found["title"] and found["image"]):
            try:
                extra = _read_oembed(found["oembed"], self.allowed)
                for field in ("title", "site_name", "image"):
                    found[field] = found[field] or extra[field]
            except (PreviewError, ValueError):
                pass
        return found

    def _store_image(self, url: str, target: Path, size, fmt: str) -> bool:
        if not url:
            return False
        try:
            _, content_type, _, body = fetch(url, limit=MAX_IMAGE_BYTES, accept="image/*", allowed=self.allowed)
            if content_type and not (content_type.startswith("image/") or content_type == "application/octet-stream"):
                return False
            _image_file(body, size, fmt, target)
            return True
        except PreviewError:
            return False


def public_entry(entry: dict, with_archive: bool = False) -> dict:
    """The preview as the API sends it, with addresses for the stored images and copies."""
    key = cache_key(entry["url"])
    result = {name: entry.get(name) for name in ("url", "title", "description", "site_name", "error", "fetched_at")}
    result["image"] = f"/api/link-previews/files/{key}.webp?v={entry['fetched_at']}" if entry.get("image") else None
    result["icon"] = f"/api/link-previews/files/{key}.icon.png?v={entry['fetched_at']}" if entry.get("icon") else None
    state = entry.get("archive")
    if with_archive and state:
        result["archive"] = {
            # pending, archived, failed, or unavailable when ArchiveBox couldn't be reached
            "status": "unavailable" if state["status"] == "error" else state["status"],
            "copies": {kind: f"/api/link-previews/archive/{key}/{kind}" for kind in state.get("outputs") or {}},
        }
    return result
