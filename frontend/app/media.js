// Media files: finding them, uploading them and the viewer
function mediaFeature() {
    return {
        externalDragActive: false,  // true while OS files (not sidebar items) are being dragged over the editor
        
        // Media viewer state
        currentMedia: '',  // Path to current media file (kept as 'currentMedia' for compatibility)
        currentMediaType: 'image',  // 'image', 'audio', 'video', 'document', 'drawing'
        
        // Whether the bar under the editor lists the attachments or only counts them
        attachmentsExpanded: false,
        // How it lists them: 'cards' or 'list', separate from the folder view's choice
        attachmentsView: 'cards',
        
        setAttachmentsView(mode) {
            if (mode !== 'cards' && mode !== 'list') return;
            this.attachmentsView = mode;
            try {
                localStorage.setItem('attachmentsView', mode);
            } catch (error) {
                console.error('Error saving attachments view:', error);
            }
        },
        
        // Files in the current note's attachment folder, by name. label is the path
        // inside that folder.
        currentAttachments() {
            if (!this.currentNote) return [];
            const folder = this.currentNote.replace(/\.md$/, '.attachments/');
            return this.notes
                .filter(item => item.type !== 'note' && item.path.startsWith(folder))
                .map(item => ({ ...item, label: item.path.slice(folder.length) }))
                .sort((a, b) => a.label.localeCompare(b.label));
        },
        
        // Resolve media wikilink to full path (O(1) lookup)
        // Returns the full path if found, null otherwise
        // An embed target is a path relative to the note holding it. Null if it climbs
        // out of the vault or nothing is there: a file is never matched by name.
        resolveMediaWikilink(target) {
            const parts = this.currentNote.split('/').slice(0, -1);
            for (const part of target.split('/')) {
                if (part === '..') {
                    if (parts.length === 0) return null;
                    parts.pop();
                } else if (part && part !== '.') {
                    parts.push(part);
                }
            }
            const path = parts.join('/');
            return this._mediaPaths.has(path) ? path : null;
        },
        
        // The file an embed target points at, and any #page=2 or ?query after it.
        // A file name can hold # or ?, so the whole target is tried first.
        _embedFile(target) {
            const path = this.resolveMediaWikilink(target);
            if (path) return { path, suffix: '' };
            const suffixAt = target.search(/[#?]/);
            const file = suffixAt > 0 ? this.resolveMediaWikilink(target.slice(0, suffixAt)) : null;
            return file ? { path: file, suffix: target.slice(suffixAt) } : null;
        },
        
        // The embed target for a vault file, as seen from a note
        relativeMediaPath(notePath, mediaPath) {
            const from = notePath.split('/').slice(0, -1);
            const to = mediaPath.split('/');
            let shared = 0;
            while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
            return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/');
        },

        // Resolve a Markdown image path to a vault-relative path (forward slashes).
        // Relative paths use the note file's directory as base (same rules as CommonMark / browsers).
        // A leading "/" (not "//") means vault-root-relative.
        resolveMarkdownMediaPathForNote(noteVaultPath, rawSrc) {
            const pathPart = rawSrc.split('#')[0].split('?')[0];
            if (!pathPart) return '';
            if (pathPart.startsWith('/') && !pathPart.startsWith('//')) {
                return pathPart.replace(/^\/+/, '');
            }
            if (!noteVaultPath) {
                return pathPart;
            }
            const dir = noteVaultPath.includes('/')
                ? noteVaultPath.slice(0, noteVaultPath.lastIndexOf('/'))
                : '';
            const base = `https://vn.invalid/${dir ? `${dir}/` : ''}`;
            try {
                const u = new URL(pathPart, base);
                let p = u.pathname;
                if (p.startsWith('/')) p = p.slice(1);
                return p.split('/').filter(seg => seg !== '').map(seg => {
                    try {
                        return decodeURIComponent(seg);
                    } catch (e) {
                        return seg;
                    }
                }).join('/');
            } catch (e) {
                return pathPart;
            }
        },
        
        // The address of a file on our own media endpoint, or null for anything else.
        // Parsed rather than prefix-matched, so /api/media/../x cannot pass and
        // javascript: resolves to a foreign origin.
        safeMediaApiSrc(src) {
            try {
                const url = new URL(src, window.location.origin);
                if (url.origin === window.location.origin && url.pathname.startsWith('/api/media/')) {
                    return url.pathname + url.search + url.hash;
                }
            } catch (e) {
                // Unparseable, so not one of ours
            }
            return null;
        },

        // Embed for local audio, video or PDF, or null if src is not local media.
        // Nothing sanitizes these
        // later: the values must go in through DOM properties, never through markup.
        buildMediaEmbed(mediaType, src, altText) {
            const safeSrc = this.safeMediaApiSrc(src);
            const kinds = {
                audio: { tag: 'audio', wrapperClass: 'media-audio' },
                video: { tag: 'video', wrapperClass: 'media-video' },
                document: { tag: 'iframe', wrapperClass: 'media-pdf' },
            };
            const kind = kinds[mediaType];
            if (!safeSrc || !kind) return null;

            const element = document.createElement(kind.tag);
            element.setAttribute('src', safeSrc);
            element.setAttribute('title', altText);
            if (mediaType !== 'document') {
                element.setAttribute('controls', '');
                element.setAttribute('preload', 'none');
            }

            const wrapper = document.createElement('div');
            wrapper.className = `media-embed ${kind.wrapperClass}`;
            wrapper.appendChild(element);
            if (mediaType === 'audio') {
                const caption = document.createElement('span');
                caption.className = 'media-caption';
                caption.textContent = altText;
                wrapper.appendChild(caption);
            }
            return wrapper;
        },

        encodeVaultRelativePathForMediaApi(vaultRelativePath) {
            if (!vaultRelativePath) return '';
            return vaultRelativePath.split('/').map(segment => {
                try {
                    return encodeURIComponent(decodeURIComponent(segment));
                } catch (e) {
                    return encodeURIComponent(segment);
                }
            }).join('/');
        },
        
        
        // Handle dragover on editor to show cursor position
        onEditorDragOver(event) {
            // Two sources land here: sidebar items (draggedItem set) and OS files.
            const isFileDrag = event.dataTransfer?.types?.includes('Files');
            if (!this.draggedItem && !isFileDrag) return;
            
            event.preventDefault();
            this.dropTarget = 'editor';
            if (isFileDrag) this.externalDragActive = true;
            
        },
        
        // Handle dragenter on editor
        onEditorDragEnter(event) {
            const isFileDrag = event.dataTransfer?.types?.includes('Files');
            if (!this.draggedItem && !isFileDrag) return;
            event.preventDefault();
            this.dropTarget = 'editor';
            if (isFileDrag) this.externalDragActive = true;
        },
        
        // Handle dragleave on editor
        onEditorDragLeave(event) {
            // Only clear dropTarget if we're actually leaving the editor
            // (not just moving between child elements)
            if (!event.currentTarget.contains(event.relatedTarget)) {
                this.dropTarget = null;
                this.externalDragActive = false;
            }
        },
        
        // Handle drop into editor to create internal link or upload media
        async onEditorDrop(event) {
            if (this.viewMode !== 'edit') return;
            // Already handled by the editor itself
            if (event.defaultPrevented) return;
            event.preventDefault();
            this.dropTarget = null;
            this.externalDragActive = false;
            
            // Check if files are being dropped (media from file system)
            if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
                await this.handleMediaDrop(event);
                return;
            }
            
            // Otherwise, handle note/media link drop from sidebar
            if (!this.draggedItem) return;
            
            const notePath = this.draggedItem.path;
            const isMediaFile = this.draggedItem.type !== 'note';
            
            let link;
            if (isMediaFile) {
                // For media files (images, audio, video, PDF), use wiki-style embed link
                link = `![[${this.relativeMediaPath(this.currentNote, notePath)}]]`;
            } else {
                // For notes, insert note link
                const noteName = notePath.split('/').pop().replace('.md', '');
                const encodedPath = notePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
                link = `[${noteName}](${encodedPath})`;
            }
            
            noteEditor?.insertMarkdown(link, this._editorDropPosition(event));
            
            this.draggedItem = null;
        },
        
        // With no note open, uploads go straight into the folder being viewed
        uploadFolder() {
            if (this.currentMedia) return this._folderFromPath(this.currentMedia);
            return this.selectedHomepageFolder || '';
        },
        
        // Handle media files dropped into editor
        async handleMediaDrop(event) {
            const position = this.currentNote ? this._editorDropPosition(event) : null;
            await this.uploadFiles(Array.from(event.dataTransfer.files), position);
        },
        
        // Open the file picker for the toolbar button and the / menu
        openAttachPicker() {
            if (this.currentNote) this.$refs.attachInput.click();
        },
        
        // Files chosen in the picker go in at the cursor
        async onAttachPicked(event) {
            const files = Array.from(event.target.files);
            event.target.value = '';  // or picking the same file again fires no change
            await this.uploadFiles(files, null);
        },
        
        // Upload buttons: with a note open, files join its attachments without changing its
        // text. In the folder view they go into the folder being viewed.
        openUploadPicker() {
            (this.currentNote ? this.$refs.uploadInput : this.$refs.folderUploadInput)?.click();
        },
        
        async onUploadPicked(event) {
            const files = Array.from(event.target.files)
                .filter(file => MEDIA_UPLOAD_TYPES.includes(file.type.toLowerCase()));
            event.target.value = '';  // or picking the same file again fires no change
            if (files.length === 0) {
                this.toast(this.t('media.no_valid_files', { formats: MEDIA_FORMATS_DISPLAY }), { type: 'warning' });
                return;
            }
            const notePath = this.currentNote;
            for (const file of files) {
                try {
                    await this.uploadMedia(file, notePath);
                } catch (error) {
                    ErrorHandler.handle(`upload file ${file.name}`, error);
                }
            }
            // Show where they went
            if (notePath && this.currentNote === notePath && !this.attachmentsExpanded) {
                this.attachmentsExpanded = true;
                this.saveAttachmentsExpanded();
            }
        },
        
        // Upload media and import Markdown files, embedding each at `position`
        async uploadFiles(files, position) {
            // Filter for allowed media types
            const mediaFiles = files.filter(file => MEDIA_UPLOAD_TYPES.includes(file.type.toLowerCase()));
            // By extension: MIME for .md varies across browsers (text/markdown,
            // text/plain, or empty), so the name is the only reliable signal.
            const markdownFiles = files.filter(file => /\.md$/i.test(file.name || ''));
            
            if (mediaFiles.length === 0 && markdownFiles.length === 0) {
                this.toast(this.t('media.no_valid_files', { formats: MEDIA_FORMATS_DISPLAY }), { type: 'warning' });
                return;
            }
            
            const notePath = this.currentNote;
            
            for (const file of mediaFiles) {
                try {
                    const mediaPath = await this.uploadMedia(file, notePath);
                    // The note may have been switched during the upload
                    if (mediaPath && notePath && this.currentNote === notePath) {
                        await this.insertMediaMarkdown(mediaPath, file.name, position);
                    }
                } catch (error) {
                    ErrorHandler.handle(`upload file ${file.name}`, error);
                }
            }
            // uploadMedia already injects the file into this.notes optimistically.
            
            // Needs an open note: the target folder is derived from it.
            if (markdownFiles.length > 0 && this.currentNote) {
                for (const file of markdownFiles) {
                    try {
                        await this.importMarkdownFile(file, position);
                    } catch (error) {
                        ErrorHandler.handle(`import markdown ${file.name}`, error);
                    }
                }
            }
        },
        
        /**
         * Import a dropped .md file as a new note in the current note's folder, then insert
         * a `[Name](path)` link at position (same shape as sidebar note drops). Filename
         * collisions get a yyyymmddHHmmss suffix. Size cap comes from UPLOAD_MAX_NOTE_MB —
         * file.text() would otherwise OOM the browser on a huge drop.
         */
        async importMarkdownFile(file, position) {
            if (!this.currentNote) return;
            
            const maxBytes = this.uploadMaxNoteMb * 1024 * 1024;
            if (file.size > maxBytes) {
                console.warn(`Rejected markdown drop: ${file.name} is ${(file.size / 1024 / 1024).toFixed(2)}MB, limit is ${this.uploadMaxNoteMb}MB (UPLOAD_MAX_NOTE_MB).`);
                this.toast(this.t('media.upload_failed'), { type: 'warning' });
                return;
            }
            
            const rawStem = (file.name || '').replace(/\.md$/i, '').trim();
            const validation = FilenameValidator.validateFilename(rawStem);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'note'), { type: 'warning' });
                return;
            }
            const stem = validation.sanitized;
            
            const currentFolder = this.currentNote.includes('/')
                ? this.currentNote.substring(0, this.currentNote.lastIndexOf('/'))
                : '';
            
            const joinPath = (folder, filename) => folder ? `${folder}/${filename}` : filename;
            let targetPath = joinPath(currentFolder, `${stem}.md`);
            if (this.notePathTaken(targetPath)) {
                const ts = this._autoTitleTimestamp();
                targetPath = joinPath(currentFolder, `${stem}-${ts}.md`);
            }
            
            const content = await file.text();
            
            this._optimisticAddNote(targetPath, { content });
            if (currentFolder) this.expandedFolders.add(currentFolder);
            this._rebuildTreeAfterMutation();
            
            try {
                const response = await fetch(`/api/notes/${encodeVaultPath(targetPath)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content })
                });
                if (!response.ok) throw new Error('Server returned error');
            } catch (error) {
                this._optimisticRemoveNote(targetPath);
                this._rebuildTreeAfterMutation();
                throw error;
            }
            
            const noteName = targetPath.split('/').pop().replace(/\.md$/i, '');
            const encodedPath = targetPath.split('/').map(seg => encodeURIComponent(seg)).join('/');
            const link = `[${noteName}](${encodedPath})`;
            
            noteEditor?.insertMarkdown(link, position);
        },
        
        // Upload a media file (image, audio, video, PDF)
        // Use options.nextToNotes + options.contentFolder to save a new drawing PNG next to .md files (not in the note's attachment folder).
        async uploadMedia(file, notePath, options = {}) {
            const { nextToNotes, contentFolder } = options;
            const formData = new FormData();
            formData.append('file', file);
            if (nextToNotes) {
                formData.append('next_to_notes', '1');
                formData.append('content_folder', contentFolder != null ? contentFolder : '');
                formData.append('note_path', '');
            } else {
                formData.append('note_path', notePath || '');
                if (!notePath) formData.append('content_folder', this.uploadFolder());
            }
            
            const response = await fetch('/api/upload-media', {
                method: 'POST',
                body: formData
            });
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Upload failed');
            }
            const data = await response.json();
            // Drop the new file into the local note list so the wikilink
            // resolver finds it without a full /api/notes refresh.
            if (data.path) {
                this._optimisticAddNote(data.path, { size: file.size });
                this._rebuildTreeAfterMutation();
            }
            return data.path;
        },
        
        // Insert media markdown at cursor position using wiki-style syntax, with a
        // path relative to the note. The uploaded file is already in this.notes
        // thanks to uploadMedia()'s optimistic add.
        async insertMediaMarkdown(mediaPath, altText, position = null) {
            const filename = mediaPath.split('/').pop();
            const filenameWithoutExt = filename.replace(/\.[^/.]+$/, '');
            const altWithoutExt = altText.replace(/\.[^/.]+$/, '');
            const target = this.relativeMediaPath(this.currentNote, mediaPath);
            const markdown = (altWithoutExt && altWithoutExt !== filenameWithoutExt && !altWithoutExt.startsWith('pasted-image'))
                ? `![[${target}|${altWithoutExt}]]`
                : `![[${target}]]`;
            
            noteEditor?.insertMarkdown(markdown, position);
        },
        
        // Upload an image pasted into the editor and embed it at the cursor
        async pasteImage(blob) {
            if (!this.currentNote || !blob) return;
            
            try {
                // Create a simple filename - backend will add timestamp to prevent collisions
                const ext = blob.type.split('/')[1] || 'png';
                const filename = `pasted-image.${ext}`;
                
                // Create a File from the blob
                const file = new File([blob], filename, { type: blob.type });
                
                const mediaPath = await this.uploadMedia(file, this.currentNote);
                if (mediaPath) {
                    await this.insertMediaMarkdown(mediaPath, filename);
                }
            } catch (error) {
                ErrorHandler.handle('paste media', error);
            }
        },
        
        // Media type detection based on file extension (and drawing-*.png convention)
        getMediaType(filename) {
            if (!filename) return null;
            const base = filename.split('/').pop().toLowerCase();
            if (base.startsWith('drawing-') && base.endsWith('.png')) {
                return 'drawing';
            }
            const ext = filename.split('.').pop().toLowerCase();
            const mediaTypes = {
                image: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
                audio: ['mp3', 'wav', 'ogg', 'm4a'],
                video: ['mp4', 'webm', 'mov', 'avi'],
                document: ['pdf'],
            };
            for (const [type, extensions] of Object.entries(mediaTypes)) {
                if (extensions.includes(ext)) return type;
            }
            return null;
        },
        
        // Get icon for media type
        getMediaIcon(type) {
            const icons = {
                image: '🖼️',
                drawing: '✏️',
                audio: '🎵',
                video: '🎬',
                document: '📄',
            };
            return icons[type] || '';
        },
        
        // Images and drawings show a scaled-down preview in the file cards and lists
        hasPreview(type) {
            return type === 'image' || type === 'drawing';
        },
        
        // ?v= changes with the file, so the browser can keep each preview for good
        thumbnailUrl(file) {
            return `/api/thumbnails/${this.encodeVaultRelativePathForMediaApi(file.path)}?v=${Date.parse(file.modified) || 0}`;
        },
        
        // Open a note or media file (unified handler for sidebar/homepage clicks)
        openItem(path, type = 'note', searchHighlight = '') {
            this.showGraph = false;
            // Check if it's a media file by type or extension
            const mediaType = type !== 'note' ? type : this.getMediaType(path);
            if (mediaType && mediaType !== 'note') {
                this.viewMedia(path, mediaType);
            } else {
                this.loadNote(path, true, searchHighlight);
            }
        },
        
        // Tear down the media viewer. Every path that clears currentMedia goes through
        // here: currentMediaType drives the shared toolbar's undo/redo, so a leftover
        // 'drawing' would wire a note's undo button to drawingUndo().
        closeMediaViewer() {
            if (this.currentMediaType === 'drawing') {
                this._drawingDisconnectResizeObserver();
            }
            this.currentMedia = '';
            this.currentMediaType = 'image';
        },
        
        // View a media file (image, audio, video, PDF) in the main pane
        viewMedia(mediaPath, mediaType = null, updateHistory = true) {
            if (this.currentMediaType === 'drawing') {
                this._drawingDisconnectResizeObserver();
                this._drawingCancelAutosave();
            }
            this._commitPendingEdits();
            // Close mobile sidebar when a media file is selected, same as loadNote
            this.mobileSidebarOpen = false;
            this.showGraph = false; // Ensure graph is closed
            this.currentNote = '';
            this.currentNoteName = '';
            this.noteContent = '';
            this.currentMedia = mediaPath; // Reuse currentMedia for all media
            this.currentMediaType = mediaType || this.getMediaType(mediaPath) || 'image';
            this.shareInfo = null; // Reset share info
            
            // Update browser tab title
            const fileName = mediaPath.split('/').pop();
            document.title = `${fileName} - ${this.appName}`;
            
            // Expand folder tree to show the media file
            this.expandFolderForNote(mediaPath);
            
            // Update browser URL
            if (updateHistory) {
                // Encode each path segment to handle special characters
                const encodedPath = mediaPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
                window.history.pushState(
                    { mediaPath: mediaPath },
                    '',
                    `/${encodedPath}`
                );
            }
            
            // Drawing: Alpine x-init on the canvas runs only on first mount; switching from one drawing
            // to another keeps currentMediaType === 'drawing', so we must reload the PNG here.
            if (this.currentMediaType === 'drawing') {
                this.$nextTick(() => {
                    this.initDrawingViewer();
                });
            }
        },
        
        // Backward compatibility alias
        viewImage(mediaPath, updateHistory = true) {
            this.viewMedia(mediaPath, 'image', updateHistory);
        },
        
        // Delete a media file (image, audio, video, PDF)
        async deleteMedia(mediaPath) {
            const filename = mediaPath.split('/').pop();
            const ok = await this.confirmModalAsk({
                message: this.t('media.confirm_delete', { name: filename }),
            });
            if (!ok) return;
            
            this._optimisticRemoveNote(mediaPath);
            this._rebuildTreeAfterMutation();
            if (this.currentMedia === mediaPath) this.currentMedia = '';
            
            try {
                const response = await fetch(`/api/notes/${encodeURIComponent(mediaPath)}`, {
                    method: 'DELETE'
                });
                if (!response.ok) throw new Error('Failed to delete media file');
                this.loadTrash();
            } catch (error) {
                ErrorHandler.handle('delete media', error);
                await this.loadNotes({ silent: true });
            }
        },
    };
}
