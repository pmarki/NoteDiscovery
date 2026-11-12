# Base images are pinned by digest, so a rebuild gets the same ones until the
# digest is changed on purpose (Dependabot proposes updates, see .github/dependabot.yml).

# Stage 1: Minify frontend assets
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS minifier

WORKDIR /build

# Minification tools (esbuild for JS, html-minifier-terser for HTML), at the exact
# versions and checksums in package-lock.json. Their output is the code browsers run.
COPY scripts/minify/package.json scripts/minify/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
ENV PATH=/build/node_modules/.bin:$PATH

# Copy frontend files
COPY frontend/ ./frontend/

# Minify JavaScript (esbuild is ~100x faster than terser)
RUN esbuild frontend/app.js frontend/app/*.js frontend/app.css --minify --outdir=frontend --outbase=frontend --allow-overwrite && \
    esbuild frontend/sw.js --minify --outfile=frontend/sw.js --allow-overwrite

# Minify HTML files (handles inline CSS and JS too). index.html keeps its include
# markers, and each partial is minified on its own, since the server joins them.
RUN for page in frontend/index.html $(find frontend/partials -name '*.html'); do \
        html-minifier-terser \
        --collapse-whitespace \
        --remove-comments \
        --ignore-custom-comments '^\s*include:' \
        --remove-redundant-attributes \
        --minify-css true \
        --minify-js true \
        -o "$page" "$page" || exit 1; \
    done && \
    html-minifier-terser \
    --collapse-whitespace \
    --remove-comments \
    --minify-css true \
    --minify-js true \
    -o frontend/login.html \
    frontend/login.html

# Stage 2: Download browser libraries so the runtime needs no CDN
FROM python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535 AS vendor

WORKDIR /build

COPY scripts/vendor_assets.py scripts/vendor_lock.json ./scripts/
RUN python scripts/vendor_assets.py --dest /vendor

# Stage 3: Install Python dependencies
FROM python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535 AS builder

WORKDIR /app

# Install Python packages: every one pinned with its hash, so a changed file on PyPI fails the build
COPY requirements.txt requirements.lock ./
COPY scripts/check_requirements_lock.py ./scripts/
RUN python scripts/check_requirements_lock.py
RUN pip install --no-cache-dir --require-hashes --prefix=/install -r requirements.lock
# Clean up unnecessary files to reduce image size (failures here are non-fatal)
RUN find /install -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true && \
    find /install -type f -name "*.pyc" -delete 2>/dev/null || true && \
    find /install -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true && \
    find /install -type d -name "*.dist-info" -exec rm -rf {}/RECORD {} + 2>/dev/null || true

# Stage 4: Final minimal image
FROM python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535

WORKDIR /app

# Copy only installed packages (no pip cache, no build artifacts)
COPY --from=builder /install /usr/local

# Copy minified frontend from minifier stage
COPY --from=minifier /build/frontend ./frontend

# Browser libraries, with their licence texts and notices
COPY --from=vendor /vendor ./frontend/vendor

# Copy application files
COPY backend ./backend
COPY mcp_server ./mcp_server
# Defaults only: mount your own as /app/config.yaml, or use environment variables
COPY config.example.yaml .
COPY VERSION .
COPY run.py .
COPY pyproject.toml .
COPY plugins ./plugins
COPY themes ./themes
COPY locales ./locales

# The app runs as this user (see docker-entrypoint.sh). It can write to the notes
# and the plugin settings, not to its own code.
RUN groupadd --gid 1000 keepit && \
    useradd --uid 1000 --gid 1000 --no-create-home --home-dir /app --shell /usr/sbin/nologin keepit && \
    mkdir -p data && \
    chown -R keepit:keepit data plugins
COPY docker-entrypoint.sh /usr/local/bin/

# Expose port (default, can be overridden)
EXPOSE 8000

# Set default port (can be overridden via environment variable)
ENV PORT=8000

# Health check (uses PORT env var)
HEALTHCHECK --interval=60s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://localhost:{os.getenv(\"PORT\", \"8000\")}/health')"

ENTRYPOINT ["docker-entrypoint.sh"]

# Run the application (shell form to allow environment variable expansion)
# Use exec to replace shell with uvicorn (receives SIGTERM directly for graceful shutdown)
CMD exec uvicorn backend.main:app --host 0.0.0.0 --port $PORT --timeout-graceful-shutdown 2
