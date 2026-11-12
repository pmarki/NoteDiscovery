<p align="center">
  <img src="frontend/logo.svg" alt="Keep It" width="120">
</p>

<h1 align="center">Keep It</h1>

<p align="center"><i>Notes, links and the pages they point to, kept on your own server</i></p>

## What is Keep It?

Keep It is a **lightweight, self-hosted note-taking application** that puts you in complete control of your knowledge base. Write and organize notes, turn web addresses into link cards, and keep an offline copy of every linked page with [ArchiveBox](documentation/ARCHIVEBOX.md), all running on your own server.

Keep It is based on [NoteDiscovery](https://github.com/gamosoft/NoteDiscovery) by Gamosoft.

## 🎯 Who is it for?

- **Privacy-conscious users** who want complete control over their data
- **Developers** who prefer markdown and local file storage
- **Knowledge workers** building a personal wiki or second brain
- **Teams** looking for a self-hosted alternative to commercial apps
- **Anyone** who values simplicity, speed, and ownership

## ✨ Why Keep It?

### vs. Commercial Apps (Notion, Evernote, Obsidian Sync)

| Feature | Keep It | Commercial Apps |
|---------|---------------|-----------------|
| **Cost** | 100% Free | $xxx/month/year |
| **Privacy** | Your server, your data | Their servers, their terms |
| **Speed** | Lightning fast | Depends on internet |
| **Offline** | Always works | Limited or requires sync |
| **Customization** | Full control | Limited options |
| **No Lock-in** | Plain markdown files | Proprietary formats |

### Key Benefits

- 🔒 **Total Privacy** - Your notes never leave your server
- 📴 **No CDN Required** - The app and its shared links serve every browser library locally, so they work on air-gapped networks — see [documentation/THIRD_PARTY.md](documentation/THIRD_PARTY.md)
- 🔐 **Optional Authentication** - Simple password protection for self-hosted deployments
- 💰 **Zero Cost** - No subscriptions, no hidden fees
- 🚀 **Fast & Lightweight** - Instant search and navigation
- 🎨 **Beautiful Themes** - Multiple themes, easy to customize
- 🔌 **Extensible** - Plugin system for custom features
- 📱 **Responsive** - Works on desktop, tablet, and mobile
- 📂 **Simple Storage** - Plain markdown files in folders
- 🧮 **Math Support** - LaTeX/MathJax for beautiful equations
- 📄 **HTML Export & Print** - Export notes as standalone HTML or print
- 🕸️ **Graph View** - Interactive visualization of connected notes
- ✏️ **Drawing editor** - In-app sketches as `drawing-*.png` next to your notes — see [documentation/DRAWING.md](documentation/DRAWING.md)
- ⭐ **Favorites** - Star your most-used notes for instant access
- 📑 **Outline Panel** - Navigate headings with click-to-jump TOC
- 🤖 **AI Assistant Ready** - MCP integration for Claude, Cursor & more

## 🤖 AI-Powered Note Management

<p align="center">
  <img src="https://img.shields.io/badge/MCP-Compatible-blueviolet?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTEyIDJhMTAgMTAgMCAxIDAgMTAgMTBIMTJWMnoiLz48cGF0aCBkPSJNMjEuMTggOC44MmMtLjI4LS40LS43Mi0uODItMS4xOC0uODJoLTNjLS40NiAwLS45LjQyLTEuMTguODItLjI4LjQtLjMyLjk4LS4xMiAxLjQybDEuNSAzYy4yLjQ0LjY2LjcgMS4xMi43aDEuMzZjLjQ2IDAgLjkyLS4yNiAxLjEyLS43bDEuNS0zYy4yLS40NC4xNi0xLjAyLS4xMi0xLjQyeiIvPjwvc3ZnPg==" alt="MCP Compatible">
  <img src="https://img.shields.io/badge/Works%20with-Claude-orange?style=for-the-badge" alt="Works with Claude">
  <img src="https://img.shields.io/badge/Works%20with-Cursor-blue?style=for-the-badge" alt="Works with Cursor">
</p>

Keep It includes a built-in **Model Context Protocol (MCP)** server, letting AI assistants directly interact with your notes:

| What AI Can Do | Example |
|----------------|---------|
| 🔍 **Search & Discover** | *"Find all my notes about Docker deployment"* |
| 📝 **Create & Edit** | *"Create a meeting notes template for tomorrow"* |
| 📁 **Organize** | *"Move all project notes to the archive folder"* |
| 🏷️ **Tag & Categorize** | *"List all notes tagged with #urgent"* |
| 📊 **Explore Connections** | *"Show me the knowledge graph of my notes"* |
| ✍️ **Append Ideas** | *"Add this thought to my daily journal"* |

**One-line setup** for Cursor, Claude Desktop, and other MCP-compatible tools:

```json
{
  "mcpServers": {
    "keepit": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "KEEPIT_URL=http://host.docker.internal:8000", "keepit:latest", "python", "-m", "mcp_server"]
    }
  }
}
```

> 🌐 **Prefer a URL?** Set `MCP_ENABLED=true` and point your client at `http://your-server:8000/mcp` (Streamable HTTP).
>
> 💡 **See [MCP.md](documentation/MCP.md)** for complete setup instructions and all available tools.
>
> 🧪 **Want a fully local setup with a bundled LLM?** [OLLAMA-STACK.md](OLLAMA-STACK.md) spins up Keep It + Ollama + Open WebUI with one command.

## 🚀 Quick Start

### With Docker Compose

```bash
git clone https://github.com/pmarki/NoteDiscovery.git
cd NoteDiscovery
mkdir -p data
docker compose up -d
```

Open **http://localhost:8000**. The compose file builds the image as `keepit:latest`; your notes are saved in `./data/`, and themes, plugins, locales and default configuration values are included in the image.

| File | Use Case |
|------|----------|
| `docker-compose.yml` | Builds from local source |
| `docker-compose.archivebox.yml` | With ArchiveBox for offline copies of linked pages — see [ARCHIVEBOX.md](documentation/ARCHIVEBOX.md) |
| `docker-compose.ollama-stack.yml` | Bundled local AI stack (Keep It + Ollama + Open WebUI) — see [OLLAMA-STACK.md](OLLAMA-STACK.md) |

See [Advanced Docker Setup](#advanced-docker-setup) for volume details.


### Running Locally (Without Docker)

For development or if you prefer running directly:

```bash
# Clone the repository
git clone https://github.com/pmarki/NoteDiscovery.git
cd NoteDiscovery

# Install dependencies
pip install -r requirements.txt

# Run the application
python run.py

# Access at http://localhost:8000
```

**Requirements:**
- Python 3.11 or higher
- pip (Python package manager)

#### Using Virtual Environments (Recommended for Arch/Fedora/Ubuntu 23.04+)

Modern Linux distributions enforce [PEP 668](https://peps.python.org/pep-0668/), which prevents system-wide pip installs. Use a virtual environment instead:

```bash
# Clone the repository
git clone https://github.com/pmarki/NoteDiscovery.git
cd NoteDiscovery

# Create a virtual environment
python -m venv venv

# Activate it (choose your shell):
source venv/bin/activate        # Bash/Zsh (most Linux distros)
source venv/bin/activate.fish   # Fish (CachyOS, etc.)
source venv/bin/activate.csh    # Csh/Tcsh
.\venv\Scripts\activate         # Windows PowerShell

# Install dependencies and run
pip install -r requirements.txt
python run.py
```

> ⚠️ **Warning**
>
> *You'll need to activate the virtual environment (source venv/bin/activate) each time you open a new terminal before running the app*

### Advanced Docker Setup

The image includes bundled config, themes, plugins, and locales. To customize, you must:
1. **Map the volume** in your docker-compose or docker run command
2. **Provide content** - the file/folder must exist with valid content (empty = app might break!)

| Volume | Purpose | Bundled? |
|--------|---------|----------|
| `data/` | Your notes | ❌ You must create |
| `config.yaml` | App settings (start from `config.example.yaml`) | ✅ Defaults |
| `themes/` | Custom themes | ✅ Yes |
| `plugins/` | Custom plugins | ✅ Yes |
| `locales/` | Translations | ✅ Yes |

## 📚 Documentation

Want to learn more?

- 🎨 **[THEMES.md](documentation/THEMES.md)** - Theme customization and creating custom themes
- ✨ **[FEATURES.md](documentation/FEATURES.md)** - Complete feature list and keyboard shortcuts
- ✏️ **[DRAWING.md](documentation/DRAWING.md)** - Built-in drawing editor (`drawing-*.png`), save behavior, and API notes
- 🏷️ **[TAGS.md](documentation/TAGS.md)** - Organize notes with tags and combined filtering
- 📋 **[TEMPLATES.md](documentation/TEMPLATES.md)** - Create notes from reusable templates with dynamic placeholders
- 🧮 **[MATHJAX.md](documentation/MATHJAX.md)** - LaTeX/Math notation examples and syntax reference
- 📊 **[MERMAID.md](documentation/MERMAID.md)** - Diagram creation with Mermaid (flowcharts, sequence diagrams, and more)
- 🔌 **[PLUGINS.md](documentation/PLUGINS.md)** - Plugin system and available plugins
- 🧩 **[plugins/contrib/](plugins/contrib/README.md)** - Optional community plugins and how to install them
- 🌐 **[API.md](documentation/API.md)** - REST API documentation and examples
- 🤖 **[MCP.md](documentation/MCP.md)** - AI assistant integration (Claude, Cursor, and more)
- 🔐 **[AUTHENTICATION.md](documentation/AUTHENTICATION.md)** - Enable password protection for your instance
- 🔧 **[ENVIRONMENT_VARIABLES.md](documentation/ENVIRONMENT_VARIABLES.md)** - Configure settings via environment variables
- 📦 **[THIRD_PARTY.md](documentation/THIRD_PARTY.md)** - Locally hosted browser libraries, licences, and how to update them

## 🌍 Multiple Languages

Keep It supports multiple interface languages via JSON locale files in `locales/`. Open **Settings** (gear icon) → **Language** to choose one; the list reflects whatever locales are installed (bundled files, mounts, or your own additions).

**To add your own language:** See the [Contributing Guidelines](CONTRIBUTING.md#-contributing-translations) for instructions on creating translation files.

**Docker users:** Mount your custom locales folder to add or override translations:

```yaml
volumes:
  - ./locales:/app/locales  # Custom translations
```

💡 **Pro Tip:** If you clone this repository, you can mount the `documentation/` folder to view these docs inside the app:

```yaml
# In your docker-compose.yml
volumes:
  - ./data:/app/data              # Your personal notes
  - ./documentation:/app/data/docs:ro  # Mount docs subfolder inside the data folder (read-only)
```

Then access them at `http://localhost:8000` - the docs will appear as a `docs/` folder in the file browser!

## 🤝 Contributing

**Before submitting a pull request**, especially for major changes, please:
- Read our **[Contributing Guidelines](CONTRIBUTING.md)**
- Open an issue first to discuss major features or significant changes
- Ensure your code follows the project's style and philosophy


## 🔒 Security Considerations

Keep It is designed for **self-hosted, private use**. Please keep these security considerations in mind:

### Network Security
- ⚠️ **Do NOT expose directly to the internet** without additional security measures
- Run behind a reverse proxy (nginx, Caddy) with HTTPS for production use
- Keep it on your local network or use a VPN for remote access
- By default, the app listens on `0.0.0.0:8000` (all network interfaces)

### Authentication
- **Password protection is DISABLED by default** (default password: `admin`)
- ⚠️ **ENABLE AUTHENTICATION AND CHANGE THE DEFAULT PASSWORD** if exposing to a network!
- See **[AUTHENTICATION.md](documentation/AUTHENTICATION.md)** for complete setup instructions
- To disable auth, set `authentication.enabled: false` in `config.yaml`
- Perfect for single-user or small team deployments
- For multi-user setups, consider a reverse proxy with OAuth/SSO

### Data Privacy
- Your notes are stored as **plain text markdown files** in the `data/` folder
- No data is sent to external services
- Regular backups are recommended

### Best Practices
- Run on `localhost` or a private network only
- Use Docker for isolation and easier security management
- Keep your system and dependencies updated
- Review and audit any plugins you install
- Set appropriate file permissions on the `data/` directory

**TL;DR**: Perfect for personal use on your local machine or home network. Enable built-in password protection if needed, or use a reverse proxy with authentication if exposing to wider networks.

## 📄 License

MIT License - Free to use, modify, and distribute. See [LICENSE](LICENSE).

Keep It is a fork of [NoteDiscovery](https://github.com/gamosoft/NoteDiscovery), Copyright (c) 2025 Gamosoft, used under the MIT License. Keep It is not affiliated with or endorsed by Gamosoft.

---

Made with ❤️ for the self-hosting community
