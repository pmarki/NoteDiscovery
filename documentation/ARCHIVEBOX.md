# Offline copies with ArchiveBox

A web address on a line of its own shows as a [link card](FEATURES.md#internal-links).
With an [ArchiveBox](https://archivebox.io) server connected, NoteDiscovery also
asks it to save every such page, so the note keeps working when the site changes
or disappears.

The card then says how the copy is going (*Saving offline copy…*, *Saved offline*,
*Offline copy failed*) and, once saved, has buttons for:

- **Page**: the page as a single HTML file (SingleFile)
- **PDF**: the page printed to PDF
- **Screenshot**: an image of the page

They open through NoteDiscovery, behind its login, so ArchiveBox itself needn't be
reachable from outside. A saved page opens without its scripts and can't load
anything from the web.

A failed copy has a **Try again** button.

## Setting it up

### With the compose file

1. Set an admin password for ArchiveBox and start both:

   ```bash
   export ARCHIVEBOX_ADMIN_PASSWORD='choose-one'
   docker compose -f docker-compose.archivebox.yml up -d
   ```

2. Open ArchiveBox's admin at <http://127.0.0.1:5797/admin/>, log in as `admin`,
   and create an **API token** (*API Tokens → Add*).
3. Give it to NoteDiscovery and restart it:

   ```bash
   export ARCHIVEBOX_API_KEY='the-token'
   docker compose -f docker-compose.archivebox.yml up -d notediscovery
   ```

### With an ArchiveBox you already run

Set, in `config.yaml` or as environment variables:

| Setting | Environment variable | Example |
|---|---|---|
| `archivebox.url` | `ARCHIVEBOX_URL` | `http://archivebox:5797` (0.9 serves on 5797) |
| `archivebox.api_key` | `ARCHIVEBOX_API_KEY` | an API token from its admin |
| `archivebox.tag` | `ARCHIVEBOX_TAG` | `notediscovery` (the default), so you can find these pages in ArchiveBox |

ArchiveBox needs `PUBLIC_SNAPSHOTS=True`: NoteDiscovery reads the saved files
without logging in.

ArchiveBox 0.9 takes new pages only at the host name in its own `BASE_URL`
(`http://localhost:5797` unless you set it); any other name gets *"control plane
disabled on this host"*. So `archivebox.url` must use that same host name, or set
ArchiveBox's `BASE_URL` to the address NoteDiscovery uses, such as
`http://archivebox:5797` in a compose network. Keep its port off the internet; the compose file only opens it
on `127.0.0.1`.

## What to know

- **Which pages:** every link card, as soon as it first appears. That includes cards
  for addresses already in your notes. Links to the server's own network get no card
  and are never sent to ArchiveBox.
- **Where copies live:** in ArchiveBox's data folder (`./archivebox` with the compose
  file), not in the notes folder. Back it up separately.
- **Size:** the ArchiveBox image is over 1 GB, and each page takes from a few hundred
  KB to tens of MB.
- **Versions:** ArchiveBox's REST API is still in alpha and changes between
  releases. The compose file uses 0.9.77, the version NoteDiscovery was tested
  with; `ARCHIVEBOX_VERSION` picks another, but try it before relying on it.
- **Privacy:** the compose file turns off ArchiveBox's submission to the Wayback
  Machine, so pages stay on your server.
