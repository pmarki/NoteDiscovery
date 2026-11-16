// Text, links and files shared from another app (share_target in the manifest). The
// service worker keeps the share in SHARE_CACHE; this asks where it goes and puts it there.
const SHARE_CACHE = 'keepit-share';

function shareTargetFeature() {
    return {
        shareTarget: {
            open: false,
            title: '',
            text: '',
            url: '',
            files: [],
            previews: [],        // object URLs of image files, parallel to files
            query: '',
            dest: null,          // { kind: 'folder' | 'note', path }
            expanded: {},        // folder path -> true while its contents show
            noteName: '',
            busy: false,
        },

        async checkPendingShare() {
            if (!('caches' in window)) return;
            try {
                const cache = await caches.open(SHARE_CACHE);
                const metaResponse = await cache.match('/share-target/meta');
                if (!metaResponse) return;
                const meta = await metaResponse.json();
                const files = [];
                for (const [index, info] of meta.files.entries()) {
                    const response = await cache.match(`/share-target/file/${index}`);
                    if (response) files.push(new File([await response.blob()], info.name, { type: info.type }));
                }
                if (!meta.title && !meta.text && !meta.url && files.length === 0) {
                    await caches.delete(SHARE_CACHE);
                    return;
                }
                const folder = this.selectedHomepageFolder || '';
                Object.assign(this.shareTarget, {
                    title: meta.title.trim(),
                    text: meta.text.replace(/\r\n?/g, '\n').trim(),  // Forms send line breaks as \r\n
                    url: meta.url.trim(),
                    files,
                    previews: files.map(file => (file.type.startsWith('image/') ? URL.createObjectURL(file) : '')),
                    query: '',
                    dest: { kind: 'folder', path: folder },
                    expanded: this._shareTargetStartExpanded(folder),
                    busy: false,
                });
                this.shareTarget.noteName = this.shareTargetNoteName();
                this.shareTarget.open = true;
            } catch (error) {
                console.warn('Could not read a shared item:', error);
            }
        },

        // Some apps send the link inside the text, others only as url
        _sharedMarkdown() {
            const { title, text, url } = this.shareTarget;
            const parts = [];
            if (text) parts.push(text);
            // On a line of its own a bare address shows as a card with the page's title
            if (url && !text.includes(url)) parts.push(title && !this.linkPreviews ? `[${title}](${url})` : url);
            return parts.join('\n\n');
        },

        _sharedHasText() {
            return !!this._sharedMarkdown();
        },

        // A new note is made for text shared into a folder
        shareTargetMakesNote() {
            return this.shareTarget.dest?.kind === 'folder' && this._sharedHasText();
        },

        // From the title, else the first line of the text, else a timestamp
        shareTargetNoteName() {
            const { title, text, url } = this.shareTarget;
            const firstLine = (text || '').split('\n').find(line => line.trim()) || '';
            const source = title || (firstLine && firstLine !== url ? firstLine : '');
            const name = source
                .replace(new RegExp(FilenameValidator.FORBIDDEN_CHARS.source, 'g'), ' ')
                .replace(/\s+/g, ' ')
                .slice(0, 60)
                .replace(/^[\s.]+|[\s.]+$/g, '');
            return name || this._autoTitleTimestamp();
        },

        // Top-level folders open, deeper ones closed, plus the way to the folder
        // that starts selected so it shows
        _shareTargetStartExpanded(folder) {
            const expanded = { '': true };
            for (const path of this.allFolders) {
                if (!path.includes('/')) expanded[path] = true;
            }
            const parts = folder ? folder.split('/') : [];
            for (let i = 1; i < parts.length; i++) expanded[parts.slice(0, i).join('/')] = true;
            return expanded;
        },

        toggleShareTargetFolder(path) {
            this.shareTarget.expanded[path] = !this.shareTarget.expanded[path];
        },

        // The root, then each folder followed by its notes, as in the tree. While
        // searching, every match shows, closed folders or not.
        shareTargetItems() {
            const query = this.shareTarget.query.trim().toLowerCase();
            const matches = (text) => !query || text.toLowerCase().includes(query);
            const notesIn = new Map();
            for (const note of this.notes) {
                if (note.type !== 'note') continue;
                const folder = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : '';
                if (!notesIn.has(folder)) notesIn.set(folder, []);
                notesIn.get(folder).push(note);
            }
            // Attachment folders belong to their note, as in the sidebar
            const visible = this.allFolders.filter(folder => !folder.split('/').some(part => part.endsWith('.attachments')));
            const folders = ['', ...visible.sort((a, b) => a.localeCompare(b))];
            const parentOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
            const hasSubfolders = new Set(visible.map(parentOf));
            const { expanded } = this.shareTarget;
            // Shown when every folder above it is open
            const open = (folder) => {
                for (let path = folder; path; path = parentOf(path)) {
                    if (!expanded[path]) return false;
                }
                return true;
            };
            const items = [];
            for (const folder of folders) {
                const depth = folder ? folder.split('/').length : 0;
                if (!query && folder && !open(parentOf(folder))) continue;
                if (matches(folder || this.t('share_target.root'))) {
                    items.push({
                        kind: 'folder',
                        path: folder,
                        label: folder ? folder.split('/').pop() : this.t('share_target.root'),
                        secondary: query && folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '',
                        depth,
                        // The root always shows what's in it
                        toggle: !query && !!folder && (hasSubfolders.has(folder) || notesIn.has(folder)),
                        expanded: !!expanded[folder],
                    });
                }
                if (!query && !open(folder)) continue;
                const notes = (notesIn.get(folder) || []).sort((a, b) => a.name.localeCompare(b.name));
                for (const note of notes) {
                    const label = note.name.replace(/\.md$/i, '');
                    if (!matches(note.path)) continue;
                    items.push({ kind: 'note', path: note.path, label, secondary: query ? folder : '', depth: depth + 1 });
                }
            }
            return items;
        },

        isShareTargetSelected(item) {
            const { dest } = this.shareTarget;
            return !!dest && dest.kind === item.kind && dest.path === item.path;
        },

        selectShareTarget(item) {
            this.shareTarget.dest = { kind: item.kind, path: item.path };
        },

        _closeShareTarget() {
            this.shareTarget.previews.forEach(url => url && URL.revokeObjectURL(url));
            Object.assign(this.shareTarget, { open: false, files: [], previews: [], dest: null, busy: false });
        },

        async cancelShare() {
            await caches.delete(SHARE_CACHE).catch(() => {});
            this._closeShareTarget();
        },

        async saveShare() {
            const { dest, files } = this.shareTarget;
            if (!dest || this.shareTarget.busy) return;
            this.shareTarget.busy = true;
            try {
                let done;
                if (this.shareTargetMakesNote()) done = await this._shareIntoNewNote(dest.path);
                else if (dest.kind === 'note') done = await this._shareIntoNote(dest.path);
                else done = await this._shareFilesIntoFolder(dest.path, files);
                if (!done) return;
                await caches.delete(SHARE_CACHE).catch(() => {});
                this._closeShareTarget();
            } finally {
                this.shareTarget.busy = false;
            }
        },

        // Uploads each file, stopping at the first failure. Returns the stored paths.
        async _uploadShared(notePath, folder) {
            const paths = [];
            for (const file of this.shareTarget.files) {
                try {
                    paths.push(await this.uploadMedia(file, notePath, { contentFolder: folder }));
                } catch (error) {
                    ErrorHandler.handle(`upload file ${file.name}`, error);
                    break;
                }
            }
            return paths;
        },

        // The files saved are taken out of the share, so a retry only sends the rest
        _keepUnsaved(savedCount) {
            if (savedCount === 0) return;
            this.shareTarget.files = this.shareTarget.files.slice(savedCount);
            this.shareTarget.previews.slice(0, savedCount).forEach(url => url && URL.revokeObjectURL(url));
            this.shareTarget.previews = this.shareTarget.previews.slice(savedCount);
        },

        async _shareIntoNewNote(folder) {
            const validation = FilenameValidator.validateFilename(this.shareTarget.noteName);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'note'), { type: 'warning' });
                return false;
            }
            const join = (name) => (folder ? `${folder}/${name}.md` : `${name}.md`);
            let notePath = join(validation.sanitized);
            if (this.notePathTaken(notePath)) notePath = join(`${validation.sanitized}-${this._autoTitleTimestamp()}`);

            // Files first: they go into the note's attachment folder, which needs only its path
            const uploaded = await this._uploadShared(notePath, null);
            const embeds = uploaded.map(path => `![[${this.relativeMediaPath(notePath, path)}]]`);
            const content = [this._sharedMarkdown(), ...embeds].join('\n\n') + '\n';
            try {
                const response = await fetch(`/api/notes/${encodeVaultPath(notePath)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content }),
                });
                if (!response.ok) throw new Error('Server returned error');
            } catch (error) {
                ErrorHandler.handle('create note', error);
                return false;
            }
            this._optimisticAddNote(notePath, { content });
            if (folder) this.expandedFolders.add(folder);
            this._rebuildTreeAfterMutation();
            await this.loadNote(notePath);
            const name = notePath.split('/').pop().replace(/\.md$/, '');
            if (uploaded.length < this.shareTarget.files.length) {
                this._keepUnsaved(uploaded.length);
                this.toast(this.t('share_target.some_failed', { count: this.shareTarget.files.length }), { type: 'warning' });
                // The note exists now, so what's left goes into it
                this.shareTarget.dest = { kind: 'note', path: notePath };
                this.shareTarget.title = this.shareTarget.text = this.shareTarget.url = '';
                return false;
            }
            this.toast(this.t('share_target.saved_note', { name }), { type: 'success' });
            return true;
        },

        async _shareIntoNote(notePath) {
            const markdown = this._sharedMarkdown();
            if (markdown) {
                // Anything typed in the open note is saved first, so it's part of what's read here
                if (this.currentNote === notePath) await this._commitPendingEdits();
                try {
                    const loaded = await fetch(`/api/notes/${encodeVaultPath(notePath)}?include_backlinks=false`);
                    if (!loaded.ok) throw new Error('Server returned error');
                    const { content, hash } = await loaded.json();
                    const body = content.replace(/\s+$/, '');
                    const saved = await fetch(`/api/notes/${encodeVaultPath(notePath)}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: `${body ? `${body}\n\n` : ''}${markdown}\n`, base_hash: hash }),
                    });
                    if (!saved.ok) throw new Error('Server returned error');
                } catch (error) {
                    ErrorHandler.handle('save note', error);
                    return false;
                }
                // Saved, so a retry mustn't add it twice
                this.shareTarget.title = this.shareTarget.text = this.shareTarget.url = '';
            }
            const total = this.shareTarget.files.length;
            const uploaded = await this._uploadShared(notePath, null);
            await this.loadNote(notePath);
            if (total && !this.attachmentsExpanded) {
                this.attachmentsExpanded = true;
                this.saveAttachmentsExpanded();
            }
            if (uploaded.length < total) {
                this._keepUnsaved(uploaded.length);
                this.toast(this.t('share_target.some_failed', { count: total - uploaded.length }), { type: 'warning' });
                return false;
            }
            const name = notePath.split('/').pop().replace(/\.md$/, '');
            this.toast(this.t('share_target.saved_into', { name }), { type: 'success' });
            return true;
        },

        async _shareFilesIntoFolder(folder, files) {
            const total = files.length;
            const uploaded = await this._uploadShared(null, folder);
            if (uploaded.length) this.goToHomepageFolder(folder);
            if (uploaded.length < total) {
                this._keepUnsaved(uploaded.length);
                this.toast(this.t('share_target.some_failed', { count: total - uploaded.length }), { type: 'warning' });
                return false;
            }
            this.toast(this.t('share_target.saved_files', { count: total }), { type: 'success' });
            return true;
        },
    };
}
