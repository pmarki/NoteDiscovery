// Opening, saving, moving and deleting notes, and the trash
function notesFeature() {
    return {
        isSaving: false,
        lastSaved: false,
        noteBaseHash: null,        // Fingerprint of the current note as last read or written on disk
        _saveQueued: false,        // A save was requested while another was in flight
        _saveConflictOpen: false,  // The "changed elsewhere" prompt is showing; saves wait
        saveTimeout: null,

        // Scroll sync state
        
        // Unified drag state for notes, folders, and media
        draggedItem: null,  // { path: string, type: 'note' | 'folder' | 'image' | 'audio' | 'video' | 'document' }
        dropTarget: null,   // 'editor' | 'folder' | null

        // Per-note editor scroll position, keyed by note path. Captured when leaving a note in
        // loadNote() and restored when returning to the same note in the same session. Stays
        // in memory only — cleared on page reload, intentionally (matches typical editor UX).
        noteScrollPositions: {},
        trashItems: [], // what GET /api/trash lists, most recently deleted first
        _scrollRestorePending: false, // A note is loading, so scrolling says nothing about where it was left
        
        // Get current note's last modified time as relative string
        get lastEditedText() {
            if (!this.currentNote) return '';
            const note = this.notes.find(n => n.path === this.currentNote);
            if (!note || !note.modified) return '';
            
            const modified = new Date(note.modified);
            const now = new Date();
            const diffMs = now - modified;
            const diffSecs = Math.floor(diffMs / 1000);
            const diffMins = Math.floor(diffSecs / 60);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);
            
            if (diffSecs < 60) return this.t('editor.just_now');
            if (diffMins < 60) return this.t('editor.minutes_ago', { count: diffMins });
            if (diffHours < 24) return this.t('editor.hours_ago', { count: diffHours });
            if (diffDays < 7) return this.t('editor.days_ago', { count: diffDays });
            
            // For older dates, show the date in selected locale
            return modified.toLocaleDateString(this.currentLocale, { month: 'short', day: 'numeric' });
        },
        
        // Unified drag and drop handlers for notes, folders, and media
        onItemDragStart(itemPath, itemType, event) {
            // Set unified drag state
            this.draggedItem = { path: itemPath, type: itemType };
            
            // Make drag image semi-transparent
            if (event.target) {
                event.target.style.opacity = '0.5';
            }
            
            event.dataTransfer.effectAllowed = 'all';
        },
        
        onItemDragEnd() {
            this.draggedItem = null;
            this.dropTarget = null;
            this.dragOverFolder = null;
            // Reset opacity of all draggable items
            document.querySelectorAll('.note-item, .folder-header').forEach(el => el.style.opacity = '1');
            // Reset drag-over class
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        },
        
        // Check if it's an external link or API path (media files, etc.)
        // Safe external protocols: http, https, mailto, tel, ssh, ftp, sftp, and app deep links
        _isExternalHref(href) {
            const externalProtocols = ['http://', 'https://', '//', 'mailto:', 'tel:', 'ssh:', 'ftp:', 'sftp:', 'slack:', 'discord:', 'teams:', 'vscode:', 'zoom:', 'whatsapp:', 'telegram:', 'signal:', 'spotify:', 'steam:', 'magnet:', '/api/'];
            return externalProtocols.some(p => href.startsWith(p));
        },
        
        // Open the note an internal href points to, offering to create it if missing
        _openInternalHref(href) {
            // Parse href into note path and anchor (e.g., "note.md#section" -> notePath="note.md", anchor="section")
            const decodedHref = decodeURIComponent(href);
            const hashIndex = decodedHref.indexOf('#');
            const rawPath = hashIndex !== -1 ? decodedHref.substring(0, hashIndex) : decodedHref;
            const anchor = hashIndex !== -1 ? decodedHref.substring(hashIndex + 1) : null;

            // Root-relative hrefs like /folder/note are vault paths with a slash bolted
            // on, and vault paths carry none. Protocol-relative //host already returned
            // above as external, so nothing here can be a host.
            const notePath = rawPath.replace(/^\/+/, '');
            
            // If it's just an anchor link (#heading), scroll within current note
            if (!notePath && anchor) {
                this.scrollToAnchor(anchor);
                return;
            }
            
            // Skip if no path
            if (!notePath) return;
            
            // Find the note by path (try exact match first, then with .md extension)
            let targetNote = this.notes.find(n => 
                n.path === notePath || 
                n.path === notePath + '.md'
            );
            
            if (!targetNote && this.currentNote) {
                // Resolve href relative to the current note's folder (standard
                // markdown behavior). Fixes `[X](sibling.md)` inside a subfolder
                // note — the vault-root exact match above misses it. Issue #262.
                const resolved = this.resolveMarkdownMediaPathForNote(this.currentNote, notePath);
                if (resolved && resolved !== notePath) {
                    const resolvedLower = resolved.toLowerCase();
                    targetNote = this.notes.find(n =>
                        n.path === resolved ||
                        n.path === resolved + '.md' ||
                        n.path.toLowerCase() === resolvedLower ||
                        n.path.toLowerCase() === resolvedLower + '.md'
                    );
                }
            }
            
            if (!targetNote) {
                // Try to find by name (in case link uses just the note name without path).
                // n.name stores the stem (no .md), so also compare against notePath
                // with any .md suffix stripped — otherwise `[X](FILE.md)` never
                // matches the "FILE" name. Issue #262.
                const notePathStem = notePath.replace(/\.md$/i, '');
                const notePathStemLower = notePathStem.toLowerCase();
                targetNote = this.notes.find(n => 
                    n.name === notePath || 
                    n.name === notePathStem ||
                    n.name.toLowerCase() === notePath.toLowerCase() ||
                    n.name.toLowerCase() === notePathStemLower
                );
            }
            
            if (!targetNote) {
                // Last resort: case-insensitive path matching
                targetNote = this.notes.find(n => 
                    n.path.toLowerCase() === notePath.toLowerCase() ||
                    n.path.toLowerCase() === (notePath + '.md').toLowerCase()
                );
            }
            
            if (targetNote && targetNote.type !== 'note') {
                this.viewMedia(targetNote.path, targetNote.type);
            } else if (targetNote) {
                // Load the note, then scroll to anchor if present
                this.loadNote(targetNote.path).then(() => {
                    if (anchor) {
                        // Small delay to ensure content is rendered
                        setTimeout(() => this.scrollToAnchor(anchor), 100);
                    }
                });
            } else {
                this.confirmModalAsk({
                    message: this.t('notes.create_from_link', { path: notePath }),
                    danger: false,
                    title: this.t('sidebar.new_note'),
                    confirmLabel: this.t('common.create'),
                }).then((ok) => {
                    if (ok) this.createNote(null, notePath);
                });
            }
        },
        
        // Scroll to an anchor (heading) by slug - reuses outline data
        scrollToAnchor(anchor) {
            // Normalize the anchor (GitHub-style slug)
            const targetSlug = anchor
                .toLowerCase()
                .replace(/[^\w\s-]/g, '')
                .replace(/\s+/g, '-')
                .replace(/-+/g, '-');
            
            // Find matching heading in outline
            const heading = this.outline.find(h => h.slug === targetSlug);
            
            if (heading) {
                this.scrollToHeading(heading);
            } else {
                // Fallback: try to find heading by exact text match
                const headingByText = this.outline.find(h => 
                    h.text.toLowerCase().replace(/\s+/g, '-') === anchor.toLowerCase()
                );
                if (headingByText) {
                    this.scrollToHeading(headingByText);
                }
            }
        },
        
        
        cancelDrag() {
            // Cancel any active drag operation (triggered by ESC key)
            this.draggedItem = null;
            this.dropTarget = null;
            this.dragOverFolder = null;
            // Reset styles - only query elements with drag-over class (more efficient)
            document.querySelectorAll('.folder-item').forEach(el => el.style.opacity = '1');
            document.querySelectorAll('.note-item').forEach(el => el.style.opacity = '1');
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        },
        
        async onFolderDrop(targetFolderPath) {
            // Ignore if we're dropping into the editor
            if (this.dropTarget === 'editor') {
                return;
            }
            
            // Capture dragged item info immediately (ondragend may clear it)
            if (!this.draggedItem) return;
            const { path: draggedPath, type: draggedType } = this.draggedItem;
            
            // Determine item category for endpoint selection
            const isFolder = draggedType === 'folder';
            const isNote = draggedType === 'note';
            const isMedia = !isFolder && !isNote; // image, audio, video, document
            
            // Handle folder drop
            if (isFolder) {
                // Prevent dropping folder into itself or its subfolders
                if (targetFolderPath === draggedPath || 
                    targetFolderPath.startsWith(draggedPath + '/')) {
                    this.toast(this.t('folders.cannot_move_into_self'), { type: 'warning' });
                    return;
                }
                
                const folderName = draggedPath.split('/').pop();
                const newPath = targetFolderPath ? `${targetFolderPath}/${folderName}` : folderName;
                
                if (newPath === draggedPath) return;
                
                const oldPrefix = draggedPath + '/';
                const newPrefix = newPath + '/';
                const wasExpanded = this.expandedFolders.has(draggedPath);
                
                // As for a note below: the move can rewrite the open note's links
                await this._commitPendingEdits();
                
                this._optimisticRenameFolderTree(draggedPath, newPath);
                this._rebuildTreeAfterMutation();
                
                const favoritesInFolder = this.favorites.filter(f => f.startsWith(oldPrefix));
                if (favoritesInFolder.length > 0) {
                    const newFavorites = this.favorites.map(f =>
                        f.startsWith(oldPrefix) ? newPrefix + f.substring(oldPrefix.length) : f
                    );
                    this.favorites = newFavorites;
                    this.favoritesSet = new Set(newFavorites);
                    this.saveFavorites();
                }
                if (wasExpanded) {
                    this.expandedFolders.delete(draggedPath);
                    this.expandedFolders.add(newPath);
                    this.saveExpandedFolders();
                }
                if (this.currentNote && this.currentNote.startsWith(oldPrefix)) {
                    this.currentNote = newPrefix + this.currentNote.substring(oldPrefix.length);
                }
                
                try {
                    const response = await fetch('/api/folders/move', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ oldPath: draggedPath, newPath })
                    });
                    if (!response.ok) {
                        const errorData = await response.json().catch(() => ({}));
                        throw new Error(errorData.detail || this.t('move.failed_folder'));
                    }
                    await this._reloadIfUpdated(await response.json());
                    await this.loadSharedNotePaths();
                } catch (error) {
                    console.error('Failed to move folder:', error);
                    this.toast(error.message || this.t('move.failed_folder'), { type: 'error' });
                    await this.loadNotes({ silent: true });
                }
                return;
            }
            
            // Handle note or media drop into folder
            const item = this.notes.find(n => n.path === draggedPath);
            if (!item) return;
            
            const filename = draggedPath.split('/').pop();
            const newPath = targetFolderPath ? `${targetFolderPath}/${filename}` : filename;
            
            if (newPath === draggedPath) return;
            
            const wasFavorited = isNote && this.favoritesSet.has(draggedPath);
            const wasCurrentNote = this.currentNote === draggedPath;
            const wasCurrentMedia = this.currentMedia === draggedPath;
            
            // The move can rewrite the open note's links, so its edits go first.
            // After the rename below they would save to the new path, and the
            // move would refuse to overwrite that file.
            await this._commitPendingEdits();
            
            this._optimisticRenameNote(draggedPath, newPath);
            this._rebuildTreeAfterMutation();
            
            if (wasFavorited) {
                this.favorites = this.favorites.map(f => f === draggedPath ? newPath : f);
                this.favoritesSet = new Set(this.favorites);
                this.saveFavorites();
            }
            if (wasCurrentNote) this.currentNote = newPath;
            if (wasCurrentMedia) this.currentMedia = newPath;
            
            try {
                const endpoint = isMedia ? '/api/media/move' : '/api/notes/move';
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ oldPath: draggedPath, newPath })
                });
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const errorKey = isMedia ? 'move.failed_media' : 'move.failed_note';
                    throw new Error(errorData.detail || this.t(errorKey));
                }
                await this._reloadIfUpdated(await response.json());
                if (wasCurrentNote) noteEditor?.refreshRendered(['embed', 'image']);
                if (isNote) await this.loadSharedNotePaths();
            } catch (error) {
                console.error(`Failed to move ${isMedia ? 'media' : 'note'}:`, error);
                this.toast(error.message || this.t(isMedia ? 'move.failed_media' : 'move.failed_note'), { type: 'error' });
                await this.loadNotes({ silent: true });
            }
        },
        
        
        // A move fixes links in other notes, which may include the open one
        async _reloadIfUpdated({ updatedNotes }) {
            if (updatedNotes?.includes(this.currentNote)) await this.loadNote(this.currentNote, false);
        },
        
        // Load a specific note
        async loadNote(notePath, updateHistory = true, searchQuery = '') {
            try {
                await this._commitPendingEdits();
                
                // Close mobile sidebar when a note is selected
                this.mobileSidebarOpen = false;

                const response = await fetch(`/api/notes/${encodeVaultPath(notePath)}`);
                
                // Check if note exists
                if (!response.ok) {
                    if (response.status === 404) {
                        // Note not found - silently redirect to home
                        window.history.replaceState({ homepageFolder: this.selectedHomepageFolder || '' }, '', '/');
                        this.currentNote = '';
                        this.noteContent = '';
                        this.noteBaseHash = null;
                        this.closeMediaViewer();
                        document.title = this.appName;
                        return;
                    }
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const data = await response.json();

                this.currentNote = notePath;
                this._scrollRestorePending = true;
                this.noteContent = data.content;
                this._showInEditor(data.content, { resetHistory: true });
                this.noteBaseHash = data.hash || null;
                // Note: scroll restoration happens later in the post-$nextTick block below
                // (where the existing scrollToTop call used to live), via _restoreNoteScroll().
                // Doing it there means a single, unified restore path instead of two racing
                // ones. See the post-$nextTick block for the full timing rationale.
                this.currentNoteName = notePath.split('/').pop().replace('.md', '');
                this.closeMediaViewer(); // Clear image viewer when loading a note
                this.shareInfo = null; // Reset share info for new note
                
                // Update browser tab title
                document.title = `${this.currentNoteName} - ${this.appName}`;
                this.lastSaved = false;
                
                // Extract outline for TOC panel
                this.extractOutline(data.content);

                // Store backlinks from API response
                this.backlinks = data.backlinks || [];

                // Update browser URL and history
                if (updateHistory) {
                    // Encode the path properly (spaces become %20, etc.)
                    const pathWithoutExtension = notePath.replace('.md', '');
                    // Encode each path segment to handle special characters
                    const encodedPath = pathWithoutExtension.split('/').map(segment => encodeURIComponent(segment)).join('/');
                    let url = `/${encodedPath}`;
                    // Add search query parameter if present
                    if (searchQuery) {
                        url += `?search=${encodeURIComponent(searchQuery)}`;
                    }
                    window.history.pushState(
                        { 
                            notePath: notePath, 
                            searchQuery: searchQuery,
                            homepageFolder: this.selectedHomepageFolder || '' // Save current folder state
                        },
                        '',
                        url
                    );
                }
                
                // Parse frontmatter metadata
                this.parseMetadata();
                
                // Store search query for highlighting
                if (searchQuery) {
                    this.currentSearchHighlight = searchQuery;
                } else {
                    // Clear highlights if no search query
                    this.currentSearchHighlight = '';
                }
                
                // Expand folder tree to show the loaded note
                this.expandFolderForNote(notePath);
                
                // Use $nextTick twice to ensure Alpine.js has time to:
                // 1. First tick: expand folders and update DOM
                // 2. Second tick: highlight the note and setup everything else
                this.$nextTick(() => {
                    this.$nextTick(() => {
                        this.refreshDOMCache();
                        // On a later frame, once the note has laid out
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                this._restoreNoteScroll();
                                this._scrollRestorePending = false;
                            });
                        });

                        // Apply or clear search highlighting
                        if (searchQuery) {
                            this.highlightSearchTerm(searchQuery);
                        } else {
                            this.clearSearchHighlights();
                        }
                        
                        // Scroll note into view in sidebar if needed
                        this.scrollNoteIntoView(notePath);
                    });
                });
                
            } catch (error) {
                ErrorHandler.handle('load note', error);
            }
        },
        
        // Load item (note or media) from URL path
        loadItemFromURL() {
            // Get path from URL (e.g., /folder/note or /folder/image.png)
            let path = window.location.pathname;
            
            // Strip .md extension if present (for MKdocs/Zensical integration)
            if (path.toLowerCase().endsWith('.md')) {
                path = path.slice(0, -3);
                // Update URL bar to show clean path without .md
                window.history.replaceState(null, '', path);
            }
            
            // Skip if root path or static assets
            if (path === '/' || path.startsWith('/static/') || path.startsWith('/api/')) {
                return;
            }
            
            // Remove leading slash and decode URL encoding (e.g., %20 -> space)
            const decodedPath = decodeURIComponent(path.substring(1));
            
            // Check if this is a media file (image, audio, video, PDF)
            const matchedItem = this.notes.find(n => n.path === decodedPath);
            
            if (matchedItem && matchedItem.type !== 'note') {
                // It's a media file, view it
                this.viewMedia(decodedPath, matchedItem.type, false); // false = don't update history
            } else {
                // It's a note, add .md extension and load it
                const notePath = decodedPath + '.md';
                
                // Parse query string for search parameter
                const urlParams = new URLSearchParams(window.location.search);
                const searchParam = urlParams.get('search');
                
                // Try to load the note directly - the backend will handle 404 if it doesn't exist
                // This is more robust than checking the frontend notes list
                this.loadNote(notePath, false, searchParam || '');
                
                // If there's a search parameter, populate the search box and trigger search
                if (searchParam) {
                    this.searchQuery = searchParam;
                    // Trigger search to populate results list
                    this.searchNotes();
                }
            }
        },
        
        // Auto-save with debounce
        autoSave() {
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
            }
            
            this.lastSaved = false;
            
            // Parse metadata in real-time
            this.parseMetadata();
            
            // Update outline (TOC) in real-time
            this.extractOutline(this.noteContent);
            
            this.saveTimeout = setTimeout(() => {
                this.saveTimeout = null;
                this.saveNote();
            }, this.autosaveDelayMs);
        },
        
        // Save current note
        async saveNote({ keepalive = false } = {}) {
            if (!this.currentNote) return;
            // Pick up the last keystrokes. This save covers their autosave, so cancel it.
            noteEditor?.flush();
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }
            // The "changed elsewhere" prompt is open: nothing is written until the user chooses.
            if (this._saveConflictOpen) return;
            // One save at a time. A second request sent before the first returns would
            // carry a stale base_hash and trip the conflict check against our own write.
            if (this.isSaving) {
                this._saveQueued = true;
                return;
            }

            this.isSaving = true;
            const notePath = this.currentNote;

            try {
                // base_hash lets the server refuse (409) a write over a file that
                // changed on disk since we read it.
                const body = JSON.stringify({ content: this.noteContent, base_hash: this.noteBaseHash });
                const response = await fetch(`/api/notes/${encodeVaultPath(notePath)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                    // Outlives the page, but browsers refuse keepalive bodies over 64 KiB.
                    keepalive: keepalive && new Blob([body]).size < 60000
                });

                if (response.status === 409) {
                    const detail = await response.json();
                    if (notePath !== this.currentNote) {
                        // The user already moved to another note: its base hash is not ours to touch.
                        const name = notePath.split('/').pop().replace('.md', '');
                        this.toast(this.t('notes.save_conflict_unsaved', { name }), { type: 'warning' });
                        return;
                    }
                    // Nothing is in flight while the user decides.
                    this.isSaving = false;
                    if (await this._askSaveConflict(notePath)) {
                        // Overwrite: take the disk version as the base, re-send ours.
                        this.noteBaseHash = detail.hash || null;
                        this._saveQueued = true;
                    } else {
                        // Reload: drop the pending autosave and show the version on disk.
                        if (this.saveTimeout) {
                            clearTimeout(this.saveTimeout);
                            this.saveTimeout = null;
                        }
                        this._saveQueued = false;
                        await this.loadNote(notePath, false);
                    }
                    return;
                }

                if (response.ok) {
                    const result = await response.json();
                    if (notePath === this.currentNote) {
                        this.noteBaseHash = result.hash || null;
                    }
                    this.lastSaved = true;
                    
                    // Update only the modified timestamp for the current note (no full reload needed)
                    const note = this.notes.find(n => n.path === this.currentNote);
                    if (note) {
                        note.modified = new Date().toISOString();
                        note.size = new Blob([this.noteContent]).size;
                        
                        // Parse tags from content
                        note.tags = this.parseTagsFromContent(this.noteContent);
                    }
                    
                    // Reload tags to update sidebar counts (debounced to prevent spam)
                    this.loadTagsDebounced();
                    
                    // Rebuild folder tree if tag filters are active
                    if (this.selectedTags.length > 0) {
                        this.buildFolderTree();
                    }
                    
                    // Hide "saved" indicator
                    setTimeout(() => {
                        this.lastSaved = false;
                    }, CONFIG.SAVE_INDICATOR_DURATION);
                } else {
                    ErrorHandler.handle('save note', new Error('Server returned error'));
                }
            } catch (error) {
                ErrorHandler.handle('save note', error);
            } finally {
                this.isSaving = false;
                if (this._saveQueued) {
                    this._saveQueued = false;
                    this.saveNote();
                }
            }
        },

        // Ask what to do when the server refused a save because the file changed on disk.
        // Resolves true to overwrite. Escape, a click outside or "Reload" keep the disk version.
        async _askSaveConflict(notePath) {
            this._saveConflictOpen = true;
            try {
                const name = notePath.split('/').pop().replace('.md', '');
                return await this.confirmModalAsk({
                    title: this.t('notes.save_conflict_title'),
                    message: this.t('notes.save_conflict_message', { name }),
                    danger: true,
                    confirmLabel: this.t('notes.save_conflict_overwrite'),
                    cancelLabel: this.t('notes.save_conflict_reload')
                });
            } finally {
                this._saveConflictOpen = false;
            }
        },

        // Rename current note
        async renameNote() {
            if (!this.currentNote) return;
            
            const oldPath = this.currentNote;
            const newName = this.currentNoteName.trim();
            
            if (!newName) {
                this.toast(this.t('notes.empty_name'), { type: 'warning' });
                return;
            }
            
            // Validate the new name (single segment, no path separators)
            const validation = FilenameValidator.validateFilename(newName);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'note'), { type: 'warning' });
                // Reset the name in the UI
                this.currentNoteName = oldPath.split('/').pop().replace('.md', '');
                return;
            }
            
            const validatedName = validation.sanitized;
            const folder = oldPath.split('/').slice(0, -1).join('/');
            const newPath = folder ? `${folder}/${validatedName}.md` : `${validatedName}.md`;
            
            if (oldPath === newPath) return;
            
            // Check if a note with the new name already exists
            const existingNote = this.notePathTaken(newPath) ? { path: newPath } : null;
            if (existingNote) {
                this.toast(this.t('notes.already_exists', { name: validatedName }), { type: 'warning' });
                // Reset the name in the UI
                this.currentNoteName = oldPath.split('/').pop().replace('.md', '');
                return;
            }
            
            // The server rewrites the note's links to its attachment folder, so the
            // file must hold the latest text before the move: writing the editor
            // buffer afterwards would bring the old links back.
            noteEditor?.flush();
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }
            const resetName = () => {
                this.currentNoteName = oldPath.split('/').pop().replace('.md', '');
            };
            try {
                const saveResponse = await fetch(`/api/notes/${encodeVaultPath(oldPath)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: this.noteContent, base_hash: this.noteBaseHash })
                });
                if (saveResponse.status === 409) {
                    // Changed elsewhere: the regular save asks what to do.
                    resetName();
                    this.saveNote();
                    return;
                }
                if (!saveResponse.ok) throw new Error('Server returned error');
                this.noteBaseHash = (await saveResponse.json()).hash || null;
            } catch (error) {
                resetName();
                ErrorHandler.handle('rename note', error);
                return;
            }
            
            // Optimistic rename: rewrite local path now + favorites + current
            // note pointer. The file itself moves through /api/notes/move so a
            // share token follows it. POST-then-DELETE revoked the link, because
            // delete means the note is gone.
            this._optimisticRenameNote(oldPath, newPath);
            this._rebuildTreeAfterMutation();
            
            const wasFavorite = this.favoritesSet.has(oldPath);
            const setFavorite = (from, to) => {
                this.favorites = this.favorites.map(f => f === from ? to : f);
                this.favoritesSet = new Set(this.favorites);
                this.saveFavorites();
            };
            if (wasFavorite) setFavorite(oldPath, newPath);
            this.currentNote = newPath;

            // A pending autosave targets currentNote, which is already the new
            // path. Let it fire and it would create the destination before the
            // move, and the move would refuse to overwrite that file.
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }
            
            try {
                const response = await fetch('/api/notes/move', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ oldPath, newPath })
                });
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    throw new Error(errorData.detail || 'Server returned error');
                }
                const moved = await response.json();
                if (moved.content != null && newPath === this.currentNote) {
                    // Undo would bring the old links back, so the history goes too
                    this.noteContent = moved.content;
                    this.noteBaseHash = moved.hash || null;
                    this._showInEditor(moved.content, { resetHistory: true });
                }
                await this.loadSharedNotePaths();
            } catch (error) {
                ErrorHandler.handle('rename note', error);
                if (wasFavorite) setFavorite(newPath, oldPath);
                if (this.currentNote === newPath) {
                    this.currentNote = oldPath;
                    resetName();
                }
                await this.loadNotes({ silent: true });
                await this.loadSharedNotePaths();
            }
        },
        
        // Delete current note
        async deleteCurrentNote() {
            if (!this.currentNote) return;
            
            // Just call deleteNote with current note details
            await this.deleteNote(this.currentNote, this.currentNoteName);
        },
        
        // Delete any note from sidebar
        async deleteNote(notePath, noteName) {
            const ok = await this.confirmModalAsk({
                message: this.t('notes.confirm_delete', { name: noteName }),
            });
            if (!ok) return;
            
            // Optimistic: remove locally + clear current note + drop favorite
            // before the network round-trip. Sidebar refreshes in <1ms on any
            // vault size. On error we resync silently from disk.
            this._optimisticRemoveNote(notePath);
            this._rebuildTreeAfterMutation();
            
            if (this.favoritesSet.has(notePath)) {
                this.favorites = this.favorites.filter(f => f !== notePath);
                this.favoritesSet = new Set(this.favorites);
                this.saveFavorites();
            }
            
            if (this.currentNote === notePath) {
                this.currentNote = '';
                this.noteContent = '';
                this.currentNoteName = '';
                document.title = this.appName;
                window.history.replaceState({}, '', '/');
            }
            
            try {
                const response = await fetch(`/api/notes/${encodeVaultPath(notePath)}`, { method: 'DELETE' });
                if (!response.ok) throw new Error('Server returned error');
                this.loadTagsDebounced();
                this.loadTrash();
            } catch (error) {
                ErrorHandler.handle('delete note', error);
                await this.loadNotes({ silent: true });
            }
        },
        
        async loadTrash() {
            try {
                const response = await fetch('/api/trash');
                if (!response.ok) throw new Error('Server returned error');
                this.trashItems = (await response.json()).items;
            } catch (error) {
                ErrorHandler.handle('load trash', error);
            }
        },
        
        async restoreTrashItem(item) {
            try {
                const response = await fetch(`/api/trash/${item.id}/restore`, { method: 'POST' });
                if (!response.ok) throw new Error('Server returned error');
                const { path } = await response.json();
                await Promise.all([this.loadNotes({ silent: true }), this.loadTrash()]);
                this.loadTagsDebounced();
                const name = path.split('/').pop().replace(/\.md$/, '');
                const message = path === item.path ? 'trash.restored' : 'trash.restored_as';
                this.toast(this.t(message, { name }), { type: 'success' });
            } catch (error) {
                ErrorHandler.handle('restore from trash', error);
            }
        },
        
        async deleteTrashItem(item) {
            const ok = await this.confirmModalAsk({
                message: this.t('trash.confirm_delete', { name: item.name }),
            });
            if (!ok) return;
            
            try {
                const response = await fetch(`/api/trash/${item.id}`, { method: 'DELETE' });
                if (!response.ok) throw new Error('Server returned error');
            } catch (error) {
                ErrorHandler.handle('delete from trash', error);
            }
            await this.loadTrash();
        },
        
        async emptyTrash() {
            const ok = await this.confirmModalAsk({ message: this.t('trash.confirm_empty') });
            if (!ok) return;
            
            try {
                const response = await fetch('/api/trash', { method: 'DELETE' });
                if (!response.ok) throw new Error('Server returned error');
            } catch (error) {
                ErrorHandler.handle('empty trash', error);
            }
            await this.loadTrash();
        },
        
        // Back to where this note was left. Stored as a fraction, since the height changes.
        _restoreNoteScroll() {
            const editor = this._domCache.editor;
            if (!this.currentNote || !editor) return;
            const scrollable = editor.scrollHeight - editor.clientHeight;
            editor.scrollTop = (this.noteScrollPositions[this.currentNote] ?? 0) * scrollable;
        },

        _rememberNoteScroll(editor) {
            if (this._scrollRestorePending || !this.currentNote) return;
            const scrollable = editor.scrollHeight - editor.clientHeight;
            if (scrollable > 0) this.noteScrollPositions[this.currentNote] = editor.scrollTop / scrollable;
        },

        // Scroll to top of the note
        scrollToTop() {
            if (!this._domCache.editor) this.refreshDOMCache();
            if (this._domCache.editor) this._domCache.editor.scrollTop = 0;
        },
    };
}
