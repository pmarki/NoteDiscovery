"""Image previews: scaled down once, cached outside the vault, refused for anything else."""

import io
import os

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import main, thumbnails


@pytest.fixture
def vault(tmp_path, monkeypatch):
    vault = tmp_path / "vault"
    vault.mkdir()
    monkeypatch.setattr(thumbnails, "THUMBNAIL_DIR", tmp_path / "thumbs")
    return vault


@pytest.fixture
def client(vault, monkeypatch):
    monkeypatch.setitem(main.config["storage"], "notes_dir", str(vault))
    main.limiter.enabled = False
    yield TestClient(main.app)
    main.limiter.enabled = True


def save(vault, name, image, **options):
    path = vault / name
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, **options)
    return path


def opened(response):
    return Image.open(io.BytesIO(response.content))


def test_a_large_image_is_scaled_down_to_webp(vault, client):
    save(vault, "a.attachments/photo.jpg", Image.new("RGB", (2000, 1000), "red"))

    response = client.get("/api/thumbnails/a.attachments/photo.jpg")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/webp"
    assert "immutable" in response.headers["cache-control"]
    assert opened(response).size == (480, 240)


def test_a_small_image_is_sent_as_it_is(vault, client):
    path = save(vault, "small.png", Image.new("RGB", (100, 100), "blue"))

    response = client.get("/api/thumbnails/small.png")

    assert response.content == path.read_bytes()


def test_transparency_survives(vault, client):
    save(vault, "drawing-1.png", Image.new("RGBA", (1000, 1000), (0, 0, 0, 0)))

    preview = opened(client.get("/api/thumbnails/drawing-1.png"))

    assert preview.mode == "RGBA"
    assert preview.getpixel((10, 10))[3] == 0


def test_a_sideways_photo_is_turned_upright(vault, client):
    exif = Image.Exif()
    exif[0x0112] = 6  # Orientation: rotate 90 degrees to display
    save(vault, "phone.jpg", Image.new("RGB", (1200, 600)), exif=exif)

    assert opened(client.get("/api/thumbnails/phone.jpg")).size == (240, 480)


def test_a_gif_gives_its_first_frame(vault, client):
    frames = [Image.new("P", (1000, 500), colour) for colour in (1, 2)]
    save(vault, "anim.gif", frames[0], save_all=True, append_images=frames[1:])

    preview = opened(client.get("/api/thumbnails/anim.gif"))

    assert preview.size == (480, 240)
    assert getattr(preview, "n_frames", 1) == 1


@pytest.mark.parametrize("name", ["doc.pdf", "note.md"])
def test_anything_but_an_image_is_refused(vault, client, name):
    (vault / name).write_bytes(b"not an image")

    assert client.get(f"/api/thumbnails/{name}").status_code == 400


def test_a_missing_image_is_not_found(client):
    assert client.get("/api/thumbnails/nope.jpg").status_code == 404


def test_paths_outside_the_vault_are_refused(vault, client):
    save(vault.parent, "outside.jpg", Image.new("RGB", (900, 900)))

    assert client.get("/api/thumbnails/..%2Foutside.jpg").status_code == 403


def test_the_trash_is_refused(vault, client):
    save(vault, ".trash/x/photo.jpg", Image.new("RGB", (900, 900)))

    assert client.get("/api/thumbnails/.trash/x/photo.jpg").status_code == 403


def test_a_corrupt_image_is_unprocessable(vault, client):
    (vault / "broken.jpg").write_bytes(b"\xff\xd8 not really a jpeg")

    assert client.get("/api/thumbnails/broken.jpg").status_code == 422


def test_an_image_over_the_pixel_limit_is_unprocessable(vault, client, monkeypatch):
    save(vault, "huge.png", Image.new("RGB", (1000, 1000)))
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 500_000)

    assert client.get("/api/thumbnails/huge.png").status_code == 422


def test_a_second_request_comes_from_the_cache(vault, client, monkeypatch):
    save(vault, "photo.jpg", Image.new("RGB", (2000, 1000)))
    first = client.get("/api/thumbnails/photo.jpg").content

    def fail(*args, **kwargs):
        raise AssertionError("opened the image again")

    monkeypatch.setattr(thumbnails.Image, "open", fail)

    assert client.get("/api/thumbnails/photo.jpg").content == first


def test_an_edited_image_gets_a_new_thumbnail(vault, client):
    path = save(vault, "photo.jpg", Image.new("RGB", (2000, 1000), "red"))
    client.get("/api/thumbnails/photo.jpg")
    save(vault, "photo.jpg", Image.new("RGB", (1000, 2000), "red"))
    os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 10**9))

    assert opened(client.get("/api/thumbnails/photo.jpg")).size == (240, 480)


def test_no_temp_files_are_left_behind(vault, client):
    save(vault, "photo.jpg", Image.new("RGB", (2000, 1000)))
    client.get("/api/thumbnails/photo.jpg")

    assert [file.suffix for file in thumbnails.THUMBNAIL_DIR.iterdir()] == [".webp"]
