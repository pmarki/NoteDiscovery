"""
Small previews of images for the file cards and lists.

A thumbnail fits inside THUMBNAIL_SIZE and is stored as WebP in the system temp
directory, outside the vault, so it is never synced or backed up and can always be
rebuilt. Its name is a hash of the image's path, modification time and size, so an
edited image gets a new one. The app never clears them.
"""

import hashlib
import os
import tempfile
from pathlib import Path

from PIL import Image, ImageOps

# Enough for a card about 200 px wide on a 2x screen
THUMBNAIL_SIZE = (480, 480)
THUMBNAIL_QUALITY = 80
THUMBNAIL_DIR = Path(tempfile.gettempdir()) / "keepit-thumbnails"
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp'}


class ThumbnailError(Exception):
    """The image can't be read: corrupt, or larger than Pillow's pixel limit."""


def thumbnail_for(image_path: Path) -> Path:
    """The file to send as a preview of an image.

    Images already inside THUMBNAIL_SIZE are sent as they are. Others are scaled
    down once and then read from the cache.
    """
    stat = image_path.stat()
    key = f"{image_path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}"
    cached = THUMBNAIL_DIR / f"{hashlib.sha256(key.encode()).hexdigest()}.webp"
    if cached.is_file():
        return cached

    try:
        with Image.open(image_path) as image:
            # Pillow only warns until twice its limit, and decoding that much takes a lot of memory
            if image.width * image.height > Image.MAX_IMAGE_PIXELS:
                raise Image.DecompressionBombError(f"{image.width}x{image.height} is too large to preview")
            if image.width <= THUMBNAIL_SIZE[0] and image.height <= THUMBNAIL_SIZE[1]:
                return image_path
            # Phone photos are often stored sideways with an EXIF note to turn them.
            # A GIF gives its first frame.
            image.seek(0)
            preview = ImageOps.exif_transpose(image)
            preview.thumbnail(THUMBNAIL_SIZE)
            if preview.mode not in ('RGB', 'RGBA'):
                preview = preview.convert('RGBA' if 'transparency' in preview.info or preview.mode in ('LA', 'PA') else 'RGB')
            THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)
            # Written aside and renamed, so a request arriving meanwhile never reads half a file
            fd, temp_name = tempfile.mkstemp(dir=THUMBNAIL_DIR, suffix='.tmp')
            try:
                with os.fdopen(fd, 'wb') as out:
                    preview.save(out, 'WEBP', quality=THUMBNAIL_QUALITY)
                os.replace(temp_name, cached)
            except BaseException:
                Path(temp_name).unlink(missing_ok=True)
                raise
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise ThumbnailError(str(error)) from error
    return cached
