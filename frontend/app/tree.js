// The vault as a tree: loading it, looking notes up and drawing the sidebar
function treeFeature() {
    return {
        // True while /api/notes is in flight. Drives the "Loading your vault…"
        // placeholder + the delayed overlay (notesLoadingShowOverlay).
        notesLoading: true,
        notesLoadingShowOverlay: false,
        _notesLoadingOverlayTimer: null,
        
        // Note lookup maps for O(1) wikilink resolution (built on loadNotes)
        _noteLookup: {
            byPath: new Map(),           // path -> true
            byPathLower: new Map(),      // path.toLowerCase() -> true
            byName: new Map(),           // name (without .md) -> true  
            byNameLower: new Map(),      // name.toLowerCase() -> true
            byEndPath: new Map(),        // '/filename' and '/filename.md' -> true
        },
        
        // Media lookup map for O(1) media wikilink resolution (built on loadNotes)
        // Maps media filename (case-insensitive) -> full path
        _mediaPaths: new Set(),
        
        // Folder state
        folderTree: [],
        allFolders: [],
        expandedFolders: new Set(),
        dragOverFolder: null,  // Track which folder is being hovered during drag
        _noteNameCounts: new Map(), // lower note stem -> count, for name-vs-path insertion
        
        getFolderNode(folderPath = '') {
            if (!this.folderTree || typeof this.folderTree !== 'object') {
                return null;
            }
            
            if (!folderPath) {
                return this.folderTree['__root__'] || { name: '', path: '', children: {}, notes: [], noteCount: 0 };
            }
            
            const parts = folderPath.split('/').filter(Boolean);
            let currentLevel = this.folderTree;
            let node = null;
            
            for (const part of parts) {
                if (!currentLevel[part]) {
                    return null;
                }
                node = currentLevel[part];
                currentLevel = node.children || {};
            }
            
            return node;
        },
        
        // ==================== END INTERNATIONALIZATION ====================
        
        // Load all notes. Pass {silent: true} from error-recovery paths so the
        // 800ms loading overlay never appears on background re-syncs.
        async loadNotes({ silent = false } = {}) {
            this.notesLoading = true;
            clearTimeout(this._notesLoadingOverlayTimer);
            if (!silent) {
                this._notesLoadingOverlayTimer = setTimeout(() => {
                    if (this.notesLoading && this.notes.length === 0 && this.allFolders.length === 0) {
                        this.notesLoadingShowOverlay = true;
                    }
                }, 800);
            }
            try {
                const response = await fetch('/api/notes');
                const data = await response.json();
                this.notes = data.notes;
                this.allFolders = data.folders || [];
                this.buildNoteLookupMaps();
                this.buildFolderTree();
                await this.loadTags();
            } catch (error) {
                ErrorHandler.handle('load notes', error);
            } finally {
                clearTimeout(this._notesLoadingOverlayTimer);
                this.notesLoading = false;
                this.notesLoadingShowOverlay = false;
            }
        },
        
        // Build lookup maps for O(1) wikilink resolution
        buildNoteLookupMaps() {
            // Clear existing maps
            this._noteLookup.byPath.clear();
            this._noteLookup.byPathLower.clear();
            this._noteLookup.byName.clear();
            this._noteLookup.byNameLower.clear();
            this._noteLookup.byEndPath.clear();
            this._mediaPaths.clear();
            this._noteNameCounts.clear();
            this.$nextTick(() => noteEditor?.refreshRendered(['wikilink', 'embed', 'image']));
            
            const setFirst = (map, key, value) => {
                if (!map.has(key)) map.set(key, value);
            };
            
            for (const note of this.notes) {
                const path = note.path;
                const pathLower = path.toLowerCase();
                const name = note.name;
                const nameLower = name.toLowerCase();
                
                // Media files are found by their exact path
                if (note.type !== 'note') {
                    this._mediaPaths.add(path);
                    continue;
                }
                
                // Notes only from here
                const nameWithoutMd = name.replace(/\.md$/i, '');
                const nameWithoutMdLower = nameWithoutMd.toLowerCase();
                const urlPath = path.replace(/\.md$/i, '');

                // Count notes per stem so autocomplete can insert a bare name when
                // unique and a folder-relative path when ambiguous.
                this._noteNameCounts.set(nameWithoutMdLower, (this._noteNameCounts.get(nameWithoutMdLower) || 0) + 1);
                
                // Store all variations for fast lookup. The value is the note's URL
                // path, so a wikilink can be resolved to a href and not just tested
                // for existence. Name keys collide when two folders hold the same
                // note name, so first match wins, the same rule the media map above
                // and the name lookup in handleInternalLink already use.
                setFirst(this._noteLookup.byPath, path, urlPath);
                setFirst(this._noteLookup.byPath, urlPath, urlPath);
                setFirst(this._noteLookup.byPathLower, pathLower, urlPath);
                setFirst(this._noteLookup.byPathLower, pathLower.replace(/\.md$/i, ''), urlPath);
                setFirst(this._noteLookup.byName, name, urlPath);
                setFirst(this._noteLookup.byName, nameWithoutMd, urlPath);
                setFirst(this._noteLookup.byNameLower, nameLower, urlPath);
                setFirst(this._noteLookup.byNameLower, nameWithoutMdLower, urlPath);
                
                // End path matching (for /folder/note style links)
                setFirst(this._noteLookup.byEndPath, '/' + nameWithoutMdLower, urlPath);
                setFirst(this._noteLookup.byEndPath, '/' + nameLower, urlPath);
            }
        },
        
        // Resolve a wikilink target to the target note's URL path (O(1) lookup)
        // Returns the path without its .md extension, or null when nothing matches
        resolveWikiLink(linkTarget) {
            const targetLower = linkTarget.toLowerCase();
            
            // Check all lookup maps
            return (
                this._noteLookup.byPath.get(linkTarget) ??
                this._noteLookup.byPath.get(linkTarget + '.md') ??
                this._noteLookup.byPathLower.get(targetLower) ??
                this._noteLookup.byPathLower.get(targetLower + '.md') ??
                this._noteLookup.byName.get(linkTarget) ??
                this._noteLookup.byNameLower.get(targetLower) ??
                this._noteLookup.byEndPath.get('/' + targetLower) ??
                this._noteLookup.byEndPath.get('/' + targetLower + '.md') ??
                null
            );
        },
        
        // Fast O(1) check if a wikilink target exists
        wikiLinkExists(linkTarget) {
            return this.resolveWikiLink(linkTarget) !== null;
        },
        
        // Build folder tree structure
        buildFolderTree() {
            const tree = {};
            
            // A note's attachment folder belongs to the note and isn't listed
            const isAttachmentPath = (path) => path.split('/').some(part => part.endsWith('.attachments'));
            
            // Add ALL folders from backend (including empty ones)
            this.allFolders.forEach(folderPath => {
                if (isAttachmentPath(folderPath)) return;
                const parts = folderPath.split('/');
                let current = tree;
                
                parts.forEach((part, index) => {
                    const fullPath = parts.slice(0, index + 1).join('/');
                    
                    if (!current[part]) {
                        current[part] = {
                            name: part,
                            path: fullPath,
                            children: {},
                            notes: []
                        };
                    }
                    current = current[part].children;
                });
            });
            
            // Add ALL notes to their folders (no filtering - tree only shown when no filters active)
            this.notes.forEach(note => {
                if (isAttachmentPath(note.folder)) return;
                if (!note.folder) {
                    // Root level note
                    if (!tree['__root__']) {
                        tree['__root__'] = {
                            name: '',
                            path: '',
                            children: {},
                            notes: []
                        };
                    }
                    tree['__root__'].notes.push(note);
                } else {
                    // Navigate to the folder and add note
                    const parts = note.folder.split('/');
                    let current = tree;
                    
                    for (let i = 0; i < parts.length; i++) {
                        if (!current[parts[i]]) {
                            current[parts[i]] = {
                                name: parts[i],
                                path: parts.slice(0, i + 1).join('/'),
                                children: {},
                                notes: []
                            };
                        }
                        if (i === parts.length - 1) {
                            current[parts[i]].notes.push(note);
                        } else {
                            current = current[parts[i]].children;
                        }
                    }
                }
            });
            
            // Sort all notes arrays alphabetically (create new sorted arrays for reactivity)
            const sortNotes = (obj) => {
                if (obj.notes && obj.notes.length > 0) {
                    // Create a new sorted array instead of mutating for Alpine reactivity
                    obj.notes = [...obj.notes].sort(this.getSortComparator());
                }
                if (obj.children && Object.keys(obj.children).length > 0) {
                    Object.values(obj.children).forEach(child => sortNotes(child));
                }
            };
            
            // Sort notes in root (create new array for reactivity)
            if (tree['__root__'] && tree['__root__'].notes) {
                tree['__root__'].notes = [...tree['__root__'].notes].sort(this.getSortComparator());
            }
            
            // Sort notes in all folders
            Object.values(tree).forEach(folder => {
                if (folder.path !== undefined) { // Skip __root__ as it was already sorted
                    sortNotes(folder);
                }
            });
            
            // Calculate and cache note counts recursively (for performance)
            const calculateNoteCounts = (folderNode) => {
                const directNotes = folderNode.notes ? folderNode.notes.length : 0;
                
                if (!folderNode.children || Object.keys(folderNode.children).length === 0) {
                    folderNode.noteCount = directNotes;
                    return directNotes;
                }
                
                const childNotesCount = Object.values(folderNode.children).reduce(
                    (total, child) => total + calculateNoteCounts(child),
                    0
                );
                
                folderNode.noteCount = directNotes + childNotesCount;
                return folderNode.noteCount;
            };
            
            // Calculate note counts for all folders
            Object.values(tree).forEach(folder => {
                if (folder.path !== undefined || folder === tree['__root__']) {
                    calculateNoteCounts(folder);
                }
            });
            
            // Invalidate homepage cache when tree is rebuilt
            this._homepageCache = {
                folderPath: null,
                notes: null,
                folders: null,
                breadcrumb: null
            };
            
            // Assign new tree (Alpine will detect the change)
            this.folderTree = tree;
        },
        
        // =====================================================================
        // OPTIMISTIC MUTATION HELPERS
        // Mirror server-side index updates locally so file ops feel instant on
        // big vaults. Mutations apply the change to this.notes/this.allFolders
        // immediately, fire the request, and on error fall back to
        // loadNotes({silent: true}) to resync from disk.
        // =====================================================================
        
        _isoNow() {
            return new Date().toISOString();
        },
        
        _folderFromPath(path) {
            const i = path.lastIndexOf('/');
            return i === -1 ? '' : path.substring(0, i);
        },
        
        _filenameFromPath(path) {
            return path.split('/').pop();
        },

        // Windows and macOS store these as one file. Rename already used this
        // comparison; create and import must too, or `b` overwrites `B`.
        notePathTaken(path) {
            if (!path) return false;
            const lower = path.toLowerCase();
            return this.notes.some(n => n.path.toLowerCase() === lower);
        },

        folderPathTaken(path) {
            if (!path) return false;
            const lower = path.toLowerCase();
            return this.allFolders.some(folder => folder.toLowerCase() === lower);
        },
        
        _inferTypeFromPath(path) {
            const m = /\.([^./]+)$/.exec(path);
            const ext = m ? m[1].toLowerCase() : '';
            if (ext === 'md' || ext === '') return 'note';
            if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'image';
            if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio';
            if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) return 'video';
            if (ext === 'pdf') return 'document';
            return 'note';
        },
        
        // Refresh sidebar tree + wikilink lookup maps after any optimistic update.
        _rebuildTreeAfterMutation() {
            this.buildNoteLookupMaps();
            this.buildFolderTree();
        },
        
        // Add a note/media file to the local list. No-op if already present.
        _optimisticAddNote(path, { content = '', type = null, size = null } = {}) {
            if (this.notes.some(n => n.path === path)) return;
            const inferredType = type || this._inferTypeFromPath(path);
            const filename = this._filenameFromPath(path);
            const name = inferredType === 'note' ? filename.replace(/\.md$/i, '') : filename;
            this.notes.push({
                path,
                name,
                folder: this._folderFromPath(path),
                type: inferredType,
                size: size != null ? size : (content ? new Blob([content]).size : 0),
                modified: this._isoNow(),
                tags: (inferredType === 'note' && content) ? this.parseTagsFromContent(content) : [],
            });
        },
        
        _optimisticRemoveNote(path) {
            this.notes = this.notes.filter(n => n.path !== path);
        },
        
        // Used by single-note rename and move (path changes, identity preserved).
        _optimisticRenameNote(oldPath, newPath) {
            // A note's attachment folder moves with it
            if (oldPath.endsWith('.md')) {
                this._optimisticRenameFolderTree(
                    oldPath.replace(/\.md$/, '.attachments'),
                    newPath.replace(/\.md$/, '.attachments'),
                );
            }
            const note = this.notes.find(n => n.path === oldPath);
            if (!note) return;
            note.path = newPath;
            note.folder = this._folderFromPath(newPath);
            const filename = this._filenameFromPath(newPath);
            note.name = note.type === 'note' ? filename.replace(/\.md$/i, '') : filename;
        },
        
        _optimisticAddFolder(folderPath) {
            if (!folderPath) return;
            if (!this.allFolders.includes(folderPath)) {
                this.allFolders.push(folderPath);
            }
        },
        
        // Cascade: remove the folder, its descendant folders, and every note inside.
        _optimisticRemoveFolderTree(folderPath) {
            const prefix = folderPath + '/';
            this.allFolders = this.allFolders.filter(f => f !== folderPath && !f.startsWith(prefix));
            this.notes = this.notes.filter(n => !n.path.startsWith(prefix));
        },
        
        // Cascade: rename the folder, its descendant folders, and rewrite paths
        // of every note inside.
        _optimisticRenameFolderTree(oldPath, newPath) {
            if (oldPath === newPath) return;
            const oldPrefix = oldPath + '/';
            const newPrefix = newPath + '/';
            this.allFolders = this.allFolders.map(f => {
                if (f === oldPath) return newPath;
                if (f.startsWith(oldPrefix)) return newPrefix + f.substring(oldPrefix.length);
                return f;
            });
            this.notes.forEach(n => {
                if (n.path.startsWith(oldPrefix)) {
                    n.path = newPrefix + n.path.substring(oldPrefix.length);
                    n.folder = this._folderFromPath(n.path);
                }
            });
        },
        
        // =====================================================================
        // DATA-ATTRIBUTE BASED HANDLERS
        // These read path/name/type from data-* attributes, avoiding JS escaping issues
        // =====================================================================
        
        // Escape strings for HTML attributes (simpler than JS escaping)
        escapeHtmlAttr(str) {
            if (!str) return '';
            return str
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        },
        
        // Folder handlers - read from dataset
        // Opens the folder in the main area, as Home does for the vault, and expands
        // it. Clicking the folder already shown collapses it instead.
        handleFolderClick(el) {
            const path = el.dataset.path;
            const shown = !this.currentNote && !this.currentMedia && !this.showGraph
                && this.selectedHomepageFolder === path;
            if (shown || !this.isFolderExpanded(path)) this.toggleFolder(path);
            this.goToHomepageFolder(path);
            this.mobileSidebarOpen = false;
        },
        handleFolderDragOver(el, event) {
            event.preventDefault();
            this.dragOverFolder = el.dataset.path;
            el.classList.add('drag-over');
        },
        handleFolderDragLeave(el) {
            this.dragOverFolder = null;
            el.classList.remove('drag-over');
        },
        handleFolderDrop(el, event) {
            event.stopPropagation();
            el.classList.remove('drag-over');
            this.onFolderDrop(el.dataset.path);
        },
        handleNewItemClick(el, event) {
            event.stopPropagation();
            this.dropdownTargetFolder = el.dataset.path;
            this.toggleNewDropdown(event);
        },
        handleRenameFolderClick(el, event) {
            event.stopPropagation();
            this.renameFolder(el.dataset.path, el.dataset.name);
        },
        handleDeleteFolderClick(el, event) {
            event.stopPropagation();
            this.deleteFolder(el.dataset.path, el.dataset.name);
        },
        
        // Item (note/media) handlers - read from dataset
        handleItemClick(el) {
            this.openItem(el.dataset.path, el.dataset.type);
        },
        handleItemHover(el, isEnter) {
            const path = el.dataset.path;
            if (path !== this.currentNote && path !== this.currentMedia) {
                el.style.backgroundColor = isEnter ? 'var(--bg-hover)' : 'transparent';
            }
        },
        handleDeleteItemClick(el, event) {
            event.stopPropagation();
            if (el.dataset.type !== 'note') {
                this.deleteMedia(el.dataset.path);
            } else {
                this.deleteNote(el.dataset.path, el.dataset.name);
            }
        },
        
        // =====================================================================
        // FOLDER TREE RENDERING
        // =====================================================================
        
        // Render folder recursively (helper for deep nesting)
        // Uses data-* attributes to store path/name, avoiding JS string escaping issues
        renderFolderRecursive(folder, level = 0, isTopLevel = false) {
            if (!folder) return '';
            
            let html = '';
            const isExpanded = this.expandedFolders.has(folder.path);
            const esc = (s) => this.escapeHtmlAttr(s); // Shorthand for HTML escaping
            
            // Render this folder's header
            // Note: Using native event handlers with data-* attributes instead of Alpine directives
            // because x-html doesn't process Alpine directives in dynamically generated content
            html += `
                <div>
                    <div 
                        data-path="${esc(folder.path)}"
                        data-name="${esc(folder.name)}"
                        draggable="true"
                        ondragstart="window.$root.onItemDragStart(this.dataset.path, 'folder', event)"
                        ondragend="window.$root.onItemDragEnd()"
                        ondragover="window.$root.handleFolderDragOver(this, event)"
                        ondragenter="window.$root.handleFolderDragOver(this, event)"
                        ondragleave="window.$root.handleFolderDragLeave(this)"
                        ondrop="window.$root.handleFolderDrop(this, event)"
                        onclick="window.$root.handleFolderClick(this)"
                        class="folder-item hover-accent px-2 py-1 text-sm relative"
                        style="color: var(--text-primary); cursor: pointer;"
                    >
                        <div class="flex items-center gap-1">
                            <button 
                                class="flex-shrink-0 w-4 h-4 flex items-center justify-center"
                                style="color: var(--text-tertiary); cursor: pointer; transition: transform 0.2s; pointer-events: none; margin-left: -5px; ${isExpanded ? 'transform: rotate(90deg);' : ''}"
                            >
                                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                                    <path d="M6 4l4 4-4 4V4z"/>
                                </svg>
                            </button>
                            <span class="flex items-center gap-1 flex-1" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; pointer-events: none;" title="${esc(folder.name)}">
                                <span>${esc(folder.name)}</span>
                                ${folder.notes.length === 0 && (!folder.children || Object.keys(folder.children).length === 0) ? `<span class="text-xs" style="color: var(--text-tertiary); font-weight: 400;">(${this.t('folders.empty')})</span>` : ''}
                            </span>
                        </div>
                        <div class="hover-buttons flex gap-1 transition-opacity absolute right-2 top-1/2 transform -translate-y-1/2" style="opacity: 0; pointer-events: none; background: linear-gradient(to right, transparent, var(--bg-hover) 20%, var(--bg-hover)); padding-left: 20px;" onclick="event.stopPropagation()">
                            <button 
                                data-path="${esc(folder.path)}"
                                onclick="window.$root.handleNewItemClick(this, event)"
                                class="px-1.5 py-0.5 text-xs rounded hover:brightness-110"
                                style="background-color: var(--bg-tertiary); color: var(--text-secondary);"
                                title="${esc(this.t('sidebar.new_note'))}"
                            >+</button>
                            <button 
                                data-path="${esc(folder.path)}"
                                data-name="${esc(folder.name)}"
                                onclick="window.$root.handleRenameFolderClick(this, event)"
                                class="px-1.5 py-0.5 text-xs rounded hover:brightness-110"
                                style="background-color: var(--bg-tertiary); color: var(--text-secondary);"
                                title="${esc(this.t('sidebar.rename_folder'))}"
                            >✏️</button>
                            <button 
                                data-path="${esc(folder.path)}"
                                data-name="${esc(folder.name)}"
                                onclick="window.$root.handleDeleteFolderClick(this, event)"
                                class="px-1 py-0.5 text-xs rounded hover:brightness-110"
                                style="color: var(--error);"
                                title="${esc(this.t('sidebar.delete_folder'))}"
                            >
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                                </svg>
                            </button>
                        </div>
                    </div>
            `;
            
            // If expanded, render folder contents (child folders + notes)
            if (isExpanded) {
                html += `<div class="folder-contents" style="padding-left: 10px;">`;
                
                // First, render child folders (if any)
                if (folder.children && Object.keys(folder.children).length > 0) {
                    const children = Object.entries(folder.children)
                        .filter(([k, v]) => !this.hideUnderscoreFolders || !v.name.startsWith('_'))
                        .sort((a, b) => this.getFolderSortComparator()(a[1], b[1]));

                    children.forEach(([childKey, childFolder]) => {
                        html += this.renderFolderRecursive(childFolder, 0, false);
                    });
                }
                
                // Then, render notes and images in this folder (after subfolders)
                if (folder.notes && folder.notes.length > 0) {
                    folder.notes.forEach(note => {
                        html += this.renderNoteItem(note);
                    });
                }
                
                html += `</div>`; // Close folder-contents
            }
            
            html += `</div>`; // Close folder wrapper
            return html;
        },
        
        // Render a single note/media item (used by both folders and root level)
        renderNoteItem(note) {
            const esc = (s) => this.escapeHtmlAttr(s);
            const isMediaFile = note.type !== 'note';
            const isCurrentNote = this.currentNote === note.path;
            const isCurrentMedia = this.currentMedia === note.path;
            const isCurrent = isMediaFile ? isCurrentMedia : isCurrentNote;
            
            // Share icon for shared notes
            const isShared = !isMediaFile && this.isNoteShared(note.path);
            const shareIcon = isShared ? `<svg aria-hidden="true" style="display: inline-block; width: 12px; height: 12px; vertical-align: middle; margin-right: 2px; opacity: 0.7;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${SHARE_ICON_PATH}"></path></svg>` : '';
            const icon = this.getMediaIcon(note.type);
            const deleteTitle = !isMediaFile
                ? this.t('toolbar.delete_note')
                : note.type === 'drawing'
                    ? this.t('toolbar.delete_drawing')
                    : this.t('toolbar.delete_image');
            
            return `
                <div 
                    data-path="${esc(note.path)}"
                    data-name="${esc(note.name)}"
                    data-type="${note.type}"
                    draggable="true"
                    ondragstart="window.$root.onItemDragStart(this.dataset.path, this.dataset.type || 'note', event)"
                    ondragend="window.$root.onItemDragEnd()"
                    onclick="window.$root.handleItemClick(this)"
                    class="note-item px-2 py-1 text-sm relative"
                    style="${isCurrent ? 'background-color: var(--accent-light); color: var(--accent-primary);' : 'color: var(--text-primary);'} ${isMediaFile ? 'opacity: 0.85;' : ''} cursor: pointer;"
                    onmouseover="window.$root.handleItemHover(this, true)"
                    onmouseout="window.$root.handleItemHover(this, false)"
                >
                    <span class="truncate" style="display: block; padding-right: 30px;" title="${esc(note.name)}">${shareIcon}${icon}${icon ? ' ' : ''}${esc(note.name)}</span>
                    <button 
                        data-path="${esc(note.path)}"
                        data-name="${esc(note.name)}"
                        data-type="${note.type}"
                        onclick="window.$root.handleDeleteItemClick(this, event)"
                        class="note-delete-btn absolute right-2 top-1/2 transform -translate-y-1/2 px-1 py-0.5 text-xs rounded hover:brightness-110 transition-opacity"
                        style="opacity: 0; color: var(--error);"
                        title="${esc(deleteTitle)}"
                    >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                </div>
            `;
        },
        
        // Render root-level items (notes and media not in any folder)
        renderRootItems() {
            const root = this.folderTree['__root__'];
            if (!root || !root.notes || root.notes.length === 0) {
                return '';
            }
            return root.notes.map(note => this.renderNoteItem(note)).join('');
        },
        
        // Toggle folder expansion
        toggleFolder(folderPath) {
            if (this.expandedFolders.has(folderPath)) {
                this.expandedFolders.delete(folderPath);
            } else {
                this.expandedFolders.add(folderPath);
            }
            // Force Alpine reactivity by creating new Set reference
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Check if folder is expanded
        isFolderExpanded(folderPath) {
            return this.expandedFolders.has(folderPath);
        },
        
        // Expand all folders
        expandAllFolders() {
            this.allFolders.forEach(folder => {
                this.expandedFolders.add(folder);
            });
            // Force Alpine reactivity
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Collapse all folders
        collapseAllFolders() {
            this.expandedFolders.clear();
            // Force Alpine reactivity
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Expand folder tree to show a specific note
        expandFolderForNote(notePath) {
            const parts = notePath.split('/');
            
            // If note is in root, no folders to expand
            if (parts.length <= 1) return;
            
            // Remove the note name (last part)
            parts.pop();
            
            // Build and expand all parent folders
            let currentPath = '';
            parts.forEach((part, index) => {
                currentPath = index === 0 ? part : `${currentPath}/${part}`;
                this.expandedFolders.add(currentPath);
            });
            
            // Force Alpine reactivity
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Scroll note into view in the sidebar navigation
        scrollNoteIntoView(notePath) {
            // Find the note element in the sidebar
            // Use a slight delay to ensure DOM is fully rendered with Alpine bindings applied
            setTimeout(() => {
                const sidebar = document.querySelector('.flex-1.overflow-y-auto.custom-scrollbar');
                if (!sidebar) return;
                
                const noteElements = sidebar.querySelectorAll('.note-item');
                let targetElement = null;
                const noteName = notePath.split('/').pop().replace('.md', '');
                
                // Find the element that corresponds to this note
                noteElements.forEach(el => {
                    // Check if this is a note element (not folder) by checking if it has the note name
                    if (el.textContent.trim().startsWith(noteName) || el.textContent.includes(noteName)) {
                        // Check computed style to see if it's highlighted
                        const computedStyle = window.getComputedStyle(el);
                        const bgColor = computedStyle.backgroundColor;
                        
                        // Check if background has the accent color (not transparent or default)
                        if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent' && !bgColor.includes('255, 255, 255')) {
                            targetElement = el;
                        }
                    }
                });
                
                // If found, scroll it into view
                if (targetElement) {
                    targetElement.scrollIntoView({ 
                        behavior: 'smooth', 
                        block: 'center',
                        inline: 'nearest'
                    });
                }
            }, 200); // Increased delay to ensure Alpine has finished rendering
        },
    };
}
