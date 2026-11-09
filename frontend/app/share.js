// Share links, export and print
function shareFeature() {
    return {
        // Optional public origin for share links; empty keeps window.location.origin.
        sharePublicOrigin: '',
        linkCopied: false,
        
        // Share state
        showShareModal: false,
        shareInfo: null,
        shareLoading: false,
        showShareQR: false,
        shareLinkCopied: false,
        shareUseRandomLink: true,   // Off hands the link name to the user
        shareSlug: '',              // Just the last URL segment, without /share/
        shareSlugState: '',         // '' while unknown, 'ok', or a rejection reason code
        _shareSlugCheckTid: null,
        _shareResetTid: null,
        _sharedNotePaths: new Set(),  // O(1) lookup for shared note indicators
        _sharedNotePathsList: [], // sorted paths, mirrors Set for reactive sidebar panel

        // Export current note as HTML via backend API
        async exportToHTML() {
            if (!this.currentNote || !this.noteContent) {
                this.toast(this.t('notes.no_content'), { type: 'info' });
                return;
            }
            
            try {
                // Build API URL with current theme
                const currentTheme = this.currentTheme || 'light';
                const encodedPath = this.currentNote.split('/').map(s => encodeURIComponent(s)).join('/');
                const url = `/api/export/${encodedPath}?theme=${encodeURIComponent(currentTheme)}`;
                
                // Fetch the exported HTML from backend
                const response = await fetch(url);
                if (!response.ok) {
                    const error = await response.json().catch(() => ({ detail: 'Export failed' }));
                    throw new Error(error.detail || 'Export failed');
                }
                
                // Get filename from Content-Disposition header or use note name
                let filename = (this.currentNoteName || 'note') + '.html';
                const contentDisposition = response.headers.get('Content-Disposition');
                if (contentDisposition) {
                    const match = contentDisposition.match(/filename="([^"]+)"/);
                    if (match) {
                        filename = match[1];
                    }
                }
                
                // Download as blob
                const blob = await response.blob();
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                
                // Cleanup
                URL.revokeObjectURL(blobUrl);
                document.body.removeChild(a);
                
            } catch (error) {
                console.error('HTML export failed:', error);
                this.toast(this.t('export.failed', { error: error.message }), { type: 'error' });
            }
        },
        
        // Open print preview in new window
        printPreview() {
            if (!this.currentNote || !this.noteContent) {
                this.toast(this.t('notes.no_content'), { type: 'info' });
                return;
            }
            
            // Build API URL with current theme and download=false for inline display
            const currentTheme = this.currentTheme || 'light';
            const encodedPath = this.currentNote.split('/').map(s => encodeURIComponent(s)).join('/');
            const url = `/api/export/${encodedPath}?theme=${encodeURIComponent(currentTheme)}&download=false`;
            
            // Open in new window/tab
            window.open(url, '_blank');
        },
        
        // Copy current note link to clipboard
        async copyNoteLink() {
            if (!this.currentNote) return;
            
            // Build the full URL
            const pathWithoutExtension = this.currentNote.replace('.md', '');
            const encodedPath = pathWithoutExtension.split('/').map(segment => encodeURIComponent(segment)).join('/');
            const url = `${window.location.origin}/${encodedPath}`;
            
            try {
                await navigator.clipboard.writeText(url);
            } catch (error) {
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = url;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
            }
            
            // Show brief "Copied!" feedback
            this.linkCopied = true;
            setTimeout(() => {
                this.linkCopied = false;
            }, 1500);
        },
        
        // ============================================================================
        // Share Functions
        // ============================================================================
        
        // Load list of shared note paths (for visual indicators and Shared sidebar panel)
        async loadSharedNotePaths() {
            try {
                const response = await fetch('/api/shared-notes');
                if (response.ok) {
                    const data = await response.json();
                    this._sharedNotePaths = new Set(data.paths || []);
                    this._syncSharedNotePathsList();
                }
            } catch (error) {
                console.error('Failed to load shared note paths:', error);
                this._sharedNotePaths = new Set();
                this._sharedNotePathsList = [];
            }
        },

        _syncSharedNotePathsList() {
            this._sharedNotePathsList = [...this._sharedNotePaths].sort((a, b) =>
                a.localeCompare(b, undefined, { sensitivity: 'base' })
            );
        },

        /** Display rows for Shared notes panel: name + folder line (search-style) */
        getSharedPanelItems() {
            return this._sharedNotePathsList.map((path) => {
                const noMd = path.replace(/\.md$/i, '');
                const last = Math.max(noMd.lastIndexOf('/'), noMd.lastIndexOf('\\'));
                const name = last < 0 ? noMd : noMd.slice(last + 1);
                const folder = last < 0 ? '' : noMd.slice(0, last).replace(/\\/g, '/');
                return { path, name, folder: folder || 'Root' };
            });
        },
        
        // Check if a note is currently shared (O(1) lookup)
        isNoteShared(notePath) {
            return this._sharedNotePaths.has(notePath);
        },
        
        // Close share modal and reset state after animation
        closeShareModal() {
            this.showShareModal = false;
            clearTimeout(this._shareSlugCheckTid);
            // Delay state reset until modal is fully hidden. Reopening cancels it,
            // otherwise a pending reset lands on the freshly loaded dialog and blanks
            // it while it is on screen.
            clearTimeout(this._shareResetTid);
            this._shareResetTid = setTimeout(() => {
                this.showShareQR = false;
                this.shareInfo = null;
                this.shareLoading = false;
                this.shareUseRandomLink = true;
                this.shareSlug = '';
                this.shareSlugState = '';
            }, 200);
        },
        
        // Generate QR code for share URL
        generateQRCode(url) {
            if (!url || typeof qrcode === 'undefined') return '';
            try {
                const qr = qrcode(0, 'M'); // 0 = auto version, M = medium error correction
                qr.addData(url);
                qr.make();
                return qr.createDataURL(4); // 4 = module size in pixels
            } catch (e) {
                console.error('QR code generation failed:', e);
                return '';
            }
        },
        
        /**
         * Correct the scheme and host of a server-generated share URL.
         *
         * The backend builds share URLs from request.base_url, whose scheme comes from
         * the connection it actually received. Behind a TLS-terminating reverse proxy
         * that connection is plain http, so the link comes back as http:// even though
         * the note is reachable only over https. The browser is authoritative for the
         * scheme and host it is currently on, so adopt those two and keep the server's
         * path, which may carry a deployment prefix the frontend cannot infer.
         *
         * When sharePublicOrigin is configured (LAN browse, public share host), prefer
         * that origin instead so the dialog / QR / clipboard show the outbound URL.
         */
        _localizeShareUrl(info) {
            if (!info || typeof info.url !== 'string' || !info.url) return info;
            try {
                const src = new URL(info.url, window.location.href);
                const origin = this.sharePublicOrigin || window.location.origin;
                // Take the origin wholesale rather than assigning protocol/host
                // separately: the URL host setter leaves an existing port in place when
                // the new value carries none, which would yield https://host:8000/...
                info.url = new URL(
                    src.pathname + src.search + src.hash,
                    origin
                ).toString();
            } catch (e) {
                // Keep the server's value rather than risk producing a broken link.
                console.warn('Could not normalize share URL:', e);
            }
            return info;
        },

        /**
         * Drop YAML frontmatter so a suggested link name comes from the prose.
         */
        _bodyWithoutFrontmatter(content) {
            const text = typeof content === 'string' ? content : '';
            const lines = text.split('\n');
            if (lines[0]?.trim() !== '---') return text;
            for (let i = 1; i < lines.length; i++) {
                if (lines[i].trim() === '---') return lines.slice(i + 1).join('\n');
            }
            return text;
        },

        /**
         * Spell text with the ASCII letters a share slug can hold: café -> cafe,
         * straße -> strasse. Case is kept for callers that care about it, and
         * characters with no Latin reading are left in place for them to deal with.
         */
        _toSlugAlphabet(text) {
            return (text || '')
                .replace(SLUG_TRANSLITERATION_RE, (ch) => {
                    const mapped = SLUG_TRANSLITERATIONS[ch.toLowerCase()];
                    if (!mapped) return ch;
                    return ch === ch.toLowerCase() ? mapped : mapped[0].toUpperCase() + mapped.slice(1);
                })
                .normalize('NFKD')
                .replace(/[\u0300-\u036f]/g, '');
        },

        /** Reduce text to the token alphabet the backend accepts. */
        _slugify(text) {
            return this._toSlugAlphabet(text)
                .replace(/[^A-Za-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, CONFIG.SHARE_SLUG_MAX_LENGTH)
                .replace(/-+$/g, '')
                .toLowerCase();
        },

        /**
         * Propose a link name from the note's opening words, falling back to its
         * filename when those are all markup or a script the URL alphabet can't hold.
         */
        _suggestShareSlug() {
            const body = this._bodyWithoutFrontmatter(this.noteContent);
            const openingWords = (text) => text
                .replace(/^#{1,6}\s+/gm, '')
                .replace(/[*_`~>\[\]()!|]/g, ' ')
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, CONFIG.SHARE_SLUG_WORDS)
                .join(' ');
            // The heading on its own reads best. Reaching into the rest of the body is
            // for notes that open straight into prose, or whose title is a word or two.
            const firstLine = body.split('\n').find(line => line.trim()) || '';
            for (const candidate of [openingWords(firstLine), openingWords(body)]) {
                const slug = this._slugify(candidate);
                if (slug.length >= CONFIG.SHARE_SLUG_MIN_LENGTH) return slug;
            }
            const filename = (this.currentNote || '').split('/').pop().replace(/\.md$/, '');
            return this._slugify(filename);
        },

        /**
         * Keep field and state identical, dropping characters a URL can't carry.
         * Accented letters are spelled out rather than deleted, so typing a name
         * produces what the suggested one would have.
         */
        onShareSlugInput(event) {
            const el = event?.target;
            const cleaned = this._toSlugAlphabet(el ? el.value : this.shareSlug)
                .replace(/\s+/g, '-')
                .replace(/[^A-Za-z0-9_-]/g, '')
                .slice(0, CONFIG.SHARE_SLUG_MAX_LENGTH);
            this.shareSlug = cleaned;
            // Alpine repaints only when the bound value changes, and a rejected
            // keystroke leaves it unchanged, so put the field back by hand.
            if (el && el.value !== cleaned) el.value = cleaned;
            this._scheduleShareSlugCheck();
        },

        onShareRandomLinkToggle() {
            if (this.shareUseRandomLink) {
                this.shareSlugState = '';
                return;
            }
            if (!this.shareSlug) this.shareSlug = this._suggestShareSlug();
            this._scheduleShareSlugCheck();
        },

        _scheduleShareSlugCheck() {
            clearTimeout(this._shareSlugCheckTid);
            const slug = this.shareSlug;
            if (!slug) {
                this.shareSlugState = '';
                return;
            }
            if (slug.length < CONFIG.SHARE_SLUG_MIN_LENGTH) {
                this.shareSlugState = 'too_short';
                return;
            }
            this.shareSlugState = '';
            this._shareSlugCheckTid = setTimeout(
                () => this._checkShareSlug(slug),
                CONFIG.SHARE_SLUG_CHECK_DEBOUNCE
            );
        },

        /**
         * Ask whether a name is free. Advisory only - saving re-checks server-side,
         * so a failed check leaves the field neutral instead of blocking the button.
         */
        async _checkShareSlug(slug) {
            try {
                const params = new URLSearchParams({ slug });
                if (this.currentNote) {
                    params.set('note_path', this.currentNote.replace(/\.md$/, ''));
                }
                const response = await fetch(`/api/share-slug?${params.toString()}`);
                if (!response.ok) return;
                const data = await response.json();
                if (slug !== this.shareSlug) return;   // A later keystroke owns the field
                this.shareSlugState = data.available ? 'ok' : (data.reason || 'taken');
            } catch (error) {
                console.warn('Could not check share link name:', error);
            }
        },

        /** Full URL for what is currently typed, built the way the server builds it. */
        shareSlugPreviewUrl() {
            if (!this.shareSlug) return '';
            const origin = this.sharePublicOrigin || window.location.origin;
            return `${origin}/share/${this.shareSlug}`;
        },

        _shareSlugMessageFor(state) {
            if (!state) return '';
            if (state === 'ok') return this.t('share.slug_available');
            if (state === 'taken') return this.t('share.slug_taken');
            if (state === 'too_short') {
                return this.t('share.slug_too_short', { min: CONFIG.SHARE_SLUG_MIN_LENGTH });
            }
            if (state === 'too_long') {
                return this.t('share.slug_too_long', { max: CONFIG.SHARE_SLUG_MAX_LENGTH });
            }
            return this.t('share.slug_invalid_chars');
        },

        shareSlugMessage() {
            return this._shareSlugMessageFor(this.shareSlugState);
        },

        shareSlugOk() {
            return this.shareSlugState === 'ok';
        },

        /** A generated link is always fine; a typed one has to pass validation. */
        canSubmitShareLink() {
            if (this.shareUseRandomLink && !this.shareInfo?.shared) return true;
            return this.shareSlug.length >= CONFIG.SHARE_SLUG_MIN_LENGTH
                && !['taken', 'too_short', 'too_long', 'invalid_chars'].includes(this.shareSlugState);
        },

        /** True when the field holds a name the note is not actually shared under. */
        shareSlugChanged() {
            return !!this.shareInfo?.shared && this.shareSlug !== (this.shareInfo.token || '');
        },

        _shareSlugReason(detail) {
            return detail && typeof detail === 'object' && typeof detail.reason === 'string'
                ? detail.reason
                : '';
        },

        _shareErrorText(detail) {
            const reason = this._shareSlugReason(detail);
            if (reason) return this._shareSlugMessageFor(reason);
            return typeof detail === 'string' && detail ? detail : 'Unknown error';
        },

        // Open share modal and fetch current share status
        async openShareModal() {
            if (!this.currentNote) return;
            
            clearTimeout(this._shareResetTid);
            // Reset state BEFORE showing modal to prevent flicker
            this.showShareQR = false;
            this.shareInfo = null;
            this.shareLoading = true;
            this.showShareModal = true;
            this.shareUseRandomLink = true;
            this.shareSlug = '';
            this.shareSlugState = '';
            
            try {
                const notePath = this.currentNote.replace('.md', '');
                const encodedPath = notePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
                const response = await fetch(`/api/share/${encodedPath}`);
                
                if (response.ok) {
                    this.shareInfo = this._localizeShareUrl(await response.json());
                } else {
                    this.shareInfo = { shared: false };
                }
            } catch (error) {
                console.error('Failed to get share status:', error);
                this.shareInfo = { shared: false };
            } finally {
                // An existing link's own name is what the field starts from, so editing
                // it is a rename rather than a fresh choice.
                this.shareSlug = this.shareInfo?.shared ? (this.shareInfo.token || '') : '';
                this.shareLoading = false;
            }
        },
        
        // Create a share link for the current note (with current theme)
        async createShareLink() {
            if (!this.currentNote) return;
            
            this.shareLoading = true;
            
            try {
                const notePath = this.currentNote.replace('.md', '');
                const encodedPath = notePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
                const body = { theme: this.currentTheme || 'light' };
                if (!this.shareUseRandomLink && this.shareSlug) body.slug = this.shareSlug;
                const response = await fetch(`/api/share/${encodedPath}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                
                if (response.ok) {
                    this.shareInfo = this._localizeShareUrl(await response.json());
                    this.shareInfo.shared = true;
                    this.shareSlug = this.shareInfo.token || '';
                    this.shareSlugState = '';
                    // Update the shared paths set
                    this._sharedNotePaths.add(this.currentNote);
                    this._syncSharedNotePathsList();
                } else {
                    const error = await response.json();
                    // A rejected name belongs on the field, not only in a toast that
                    // disappears while the dialog is still open.
                    const reason = this._shareSlugReason(error.detail);
                    if (reason) this.shareSlugState = reason;
                    this.toast(this.t('share.error_creating', { error: this._shareErrorText(error.detail) }), { type: 'error' });
                }
            } catch (error) {
                console.error('Failed to create share link:', error);
                this.toast(this.t('share.error_creating', { error: error.message }), { type: 'error' });
            } finally {
                this.shareLoading = false;
            }
        },
        
        /**
         * Move the note to a new link name.
         *
         * A note has one share token, so this is a swap: the previous URL stops
         * resolving the moment the new one starts.
         */
        async updateShareLinkSlug() {
            if (!this.currentNote || !this.shareSlugChanged() || !this.canSubmitShareLink()) return;
            
            const ok = await this.confirmModalAsk({
                message: this.t('share.confirm_slug_change'),
                danger: true,
                confirmLabel: this.t('share.update_link'),
            });
            if (!ok) return;
            
            this.shareLoading = true;
            
            try {
                const notePath = this.currentNote.replace('.md', '');
                const encodedPath = notePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
                const response = await fetch(`/api/share/${encodedPath}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        theme: this.shareInfo?.theme || this.currentTheme || 'light',
                        slug: this.shareSlug
                    })
                });
                
                if (response.ok) {
                    this.shareInfo = this._localizeShareUrl(await response.json());
                    this.shareInfo.shared = true;
                    this.shareSlug = this.shareInfo.token || '';
                    this.shareSlugState = '';
                    this.shareLinkCopied = false;
                } else {
                    const error = await response.json();
                    const reason = this._shareSlugReason(error.detail);
                    if (reason) this.shareSlugState = reason;
                    this.toast(this.t('share.error_updating', { error: this._shareErrorText(error.detail) }), { type: 'error' });
                }
            } catch (error) {
                console.error('Failed to update share link:', error);
                this.toast(this.t('share.error_updating', { error: error.message }), { type: 'error' });
            } finally {
                this.shareLoading = false;
            }
        },
        
        // Copy share link to clipboard
        async copyShareLink() {
            if (!this.shareInfo?.url) return;
            
            try {
                await navigator.clipboard.writeText(this.shareInfo.url);
            } catch (error) {
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = this.shareInfo.url;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
            }
            
            this.shareLinkCopied = true;
            setTimeout(() => {
                this.shareLinkCopied = false;
            }, 2000);
        },
        
        // Revoke share link
        async revokeShareLink() {
            if (!this.currentNote) return;
            
            const ok = await this.confirmModalAsk({
                message: this.t('share.confirm_revoke'),
                danger: false,
                confirmLabel: this.t('common.yes'),
            });
            if (!ok) return;
            
            this.shareLoading = true;
            
            try {
                const notePath = this.currentNote.replace('.md', '');
                const encodedPath = notePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
                const response = await fetch(`/api/share/${encodedPath}`, {
                    method: 'DELETE'
                });
                
                if (response.ok) {
                    // Update the shared paths set
                    this._sharedNotePaths.delete(this.currentNote);
                    this._syncSharedNotePathsList();
                    // Nothing is left to do here, and dropping back to the "create a
                    // link" step offers to undo what was just confirmed.
                    this.closeShareModal();
                } else {
                    const error = await response.json();
                    this.toast(this.t('share.error_revoking', { error: error.detail || 'Unknown error' }), { type: 'error' });
                }
            } catch (error) {
                console.error('Failed to revoke share link:', error);
                this.toast(this.t('share.error_revoking', { error: error.message }), { type: 'error' });
            } finally {
                this.shareLoading = false;
            }
        },
    };
}
