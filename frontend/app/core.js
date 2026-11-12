// App core: state shared by every feature, startup and config
function coreFeature() {
    return {
        // App state
        appName: 'Keep It',
        appVersion: '0.0.0',
        mediaUploadTypes: MEDIA_UPLOAD_TYPES.join(','),
        authEnabled: false,
        demoMode: false,
        autosaveDelayMs: CONFIG.AUTOSAVE_DELAY,  // hydrated from /api/config in loadConfig()
        defaultTheme: CONFIG.DEFAULT_THEME,      // hydrated from /api/config in loadConfig()
        uploadMaxNoteMb: CONFIG.UPLOAD_MAX_NOTE_MB, // hydrated from /api/config in loadConfig()
        linkPreviews: false, // Cards for links on a line of their own; from /api/config
        notes: [],

        currentNote: '',
        currentNoteName: '',
        noteContent: '',
        viewMode: 'edit', // 'edit', 'read'
        previousViewMode: 'edit',
        
        // Preview rendering debounce
        _previewDebounceTimeout: null,
        
        // Check if app is empty (no notes and no folders)
        get isAppEmpty() {
            const notesArray = Array.isArray(this.notes) ? this.notes : [];
            const foldersArray = Array.isArray(this.allFolders) ? this.allFolders : [];
            return notesArray.length === 0 && foldersArray.length === 0;
        }, 
        
        // DOM element cache (to avoid repeated querySelector calls)
        _domCache: {
            editor: null
        },
        
        // Initialize app
        async init() {
            // Prevent double initialization (Alpine.js may call x-init twice in some cases)
            if (window.__noteapp_initialized) return;
            window.__noteapp_initialized = true;
            
            // Store global reference for native event handlers in x-html content
            window.$root = this;
            
            // ESC key to cancel drag operations
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.draggedItem) {
                    this.cancelDrag();
                }
            });
            
            await this.loadConfig();
            await this.loadThemes();
            await this.initTheme();
            await this.loadAvailableLocales();
            // Note: Translations are preloaded synchronously before Alpine init (see index.html)
            // loadLocale() is only called when user changes language from settings
            await this.loadNotes();
            await this.loadSharedNotePaths();
            this.loadTrash();
            await this.loadTemplates();
            this.loadLocalSettings();
            
            // Outside changes (preview task toggles, closing a note) must reach the editor
            this.$watch('noteContent', (value) => {
                if (value !== this._editorMarkdown) {
                    this._showInEditor(value, { resetHistory: !this.currentNote });
                }
            });
            
            // Timers won't run once the page is gone, so save on the way out
            const saveOnLeave = () => {
                noteEditor?.flush();
                if (this.saveTimeout) this.saveNote({ keepalive: true });
            };
            window.addEventListener('pagehide', saveOnLeave);
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) saveOnLeave();
            });
            
            // Parse URL and load specific note if provided
            this.loadItemFromURL();
            // Something shared from another app, maybe from before a login
            this.checkPendingShare();
            
            // Set initial homepage state ONLY if we're actually on the homepage
            if (window.location.pathname === '/') {
                window.history.replaceState({ homepageFolder: '' }, '', '/');
                document.title = this.appName;
            }
            
            // Listen for browser back/forward navigation
            window.addEventListener('popstate', (e) => {
                if (e.state && e.state.notePath) {
                    // Navigating to a note
                    const searchQuery = e.state.searchQuery || '';
                    this.loadNote(e.state.notePath, false, searchQuery); // false = don't update history
                    
                    // Update search box and trigger search if needed
                    if (searchQuery) {
                        this.searchQuery = searchQuery;
                        this.searchNotes();
                    } else {
                        this.searchQuery = '';
                        this.searchResults = [];
                        this.searchPages = [];
                        this.clearSearchHighlights();
                    }
                } else if (e.state && e.state.mediaPath) {
                    // Navigating to a media file
                    this.viewMedia(e.state.mediaPath, null, false);
                } else {
                    // Navigating back to homepage
                    this._commitPendingEdits();
                    this.currentNote = '';
                    this.noteContent = '';
                    this.currentNoteName = '';
                    this.outline = [];
                    this.backlinks = [];
                    this.shareInfo = null; // Reset share info
                    document.title = this.appName;
                    
                    // Restore homepage folder state if it was saved
                    if (e.state && e.state.homepageFolder !== undefined) {
                        this.selectedHomepageFolder = e.state.homepageFolder || '';
                    } else {
                        // No folder state in history, go to root
                        this.selectedHomepageFolder = '';
                    }
                    
                    // Invalidate cache to force recalculation
                    this._homepageCache = {
                        folderPath: null,
                        notes: null,
                        folders: null,
                        breadcrumb: null
                    };
                    
                    // Clear search
                    this.searchQuery = '';
                    this.searchResults = [];
                    this.searchPages = [];
                    this.clearSearchHighlights();
                }
            });
            
            // Cache DOM references after initial render
            this.$nextTick(() => {
                this.refreshDOMCache();
            });
            
            // Watch view mode changes and auto-save
            this.$watch('viewMode', (newValue) => {
                this.saveViewMode();
                noteEditor?.setEditable(newValue === 'edit');
            });
            
            // Watch for changes in note content to re-apply search highlights
            this.$watch('noteContent', () => {
                if (this.currentSearchHighlight) {
                    // Re-apply highlights after content changes (with small delay for render)
                    this.$nextTick(() => {
                        setTimeout(() => {
                            // Don't focus editor during content changes (false)
                            this.highlightSearchTerm(this.currentSearchHighlight);
                        }, 50);
                    });
                }
            });
            
            // Watch tags panel expanded state and save to localStorage
            this.$watch('tagsExpanded', () => {
                this.saveTagsExpanded();
            });
            
            // Watch favorites expanded state and save to localStorage
            this.$watch('favoritesExpanded', () => {
                this.saveFavoritesExpanded();
            });
            
            // Setup keyboard shortcuts (only once to prevent double triggers)
            if (!window.__noteapp_shortcuts_initialized) {
                window.__noteapp_shortcuts_initialized = true;
                window.addEventListener('keydown', (e) => {
                    // Use e.key (not e.code) for letter keys to support non-QWERTY keyboard layouts
                    
                    // Ctrl/Cmd + S to save (drawing saves PNG; notes save markdown)
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                        if (this.currentMedia && this.currentMediaType === 'drawing') {
                            e.preventDefault();
                            this.drawingSave();
                        } else {
                            e.preventDefault();
                            this.saveNote();
                        }
                    }
                    
                    // Ctrl/Cmd + Alt + P for Quick Switcher
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'p') {
                        e.preventDefault();
                        this.openQuickSwitcher();
                        return;
                    }
                    
                    // Ctrl/Cmd + Alt/Option + N for new note
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'n') {
                        e.preventDefault();
                        this.createNote();
                    }
                    
                    // Ctrl/Cmd + Alt/Option + F for new folder
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'f') {
                        e.preventDefault();
                        this.createFolder();
                    }
                    
                    // Inside the editor, Tiptap's keymap has already handled undo and redo
                    const inEditor = e.target.closest?.('#note-editor');
                    
                    // Ctrl/Cmd + Z for undo (drawing vs note editor)
                    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
                        if (this.currentMedia && this.currentMediaType === 'drawing') {
                            e.preventDefault();
                            this.drawingUndo();
                        } else if (!inEditor) {
                            e.preventDefault();
                            this.undo();
                        }
                    }
                    
                    // Ctrl/Cmd + Y OR Ctrl/Cmd+Shift+Z for redo
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                        if (this.currentMedia && this.currentMediaType === 'drawing') {
                            e.preventDefault();
                            this.drawingRedo();
                        } else if (!inEditor) {
                            e.preventDefault();
                            this.redo();
                        }
                    }
                    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
                        if (this.currentMedia && this.currentMediaType === 'drawing') {
                            e.preventDefault();
                            this.drawingRedo();
                        } else if (!inEditor) {
                            e.preventDefault();
                            this.redo();
                        }
                    }
                    
                    // F3 for next search match
                    if (e.code === 'F3' && !e.shiftKey) {
                        e.preventDefault();
                        this.nextMatch();
                    }
                    
                    // Shift + F3 for previous search match
                    if (e.code === 'F3' && e.shiftKey) {
                        e.preventDefault();
                        this.previousMatch();
                    }
                    
                    // Ctrl/Cmd + Alt/Option + Z to toggle Zen mode.
                    // Global (fires regardless of focus) so users can enter/exit Zen without
                    // first clicking into the editor. Requires an open note; noop otherwise.
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'z') {
                        if (this.currentNote) {
                            e.preventDefault();
                            this.toggleZenMode();
                        }
                    }
                    
                    // View-mode shortcuts (global — fire regardless of focus):
                    //   Ctrl/Cmd + Alt/Option + 1  → Edit
                    //   Ctrl/Cmd + Alt/Option + 3  → Read
                    //   Ctrl/Cmd + Alt/Option + V  → Toggle between them
                    // Skipped when no note is open, in Zen mode (edit-only), or while the graph
                    // overlay is showing. Uses e.code for digits so the physical top-row keys
                    // fire on AZERTY/QWERTZ layouts (where 1/2/3 need Shift) and to bypass
                    // Mac's Option+digit dead-key composer (Option+1 = ¡, etc.).
                    if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey
                        && this.currentNote && !this.zenMode && !this.showGraph) {
                        let targetMode = null;
                        if (e.code === 'Digit1') {
                            targetMode = 'edit';
                        } else if (e.code === 'Digit3') {
                            targetMode = 'read';
                        } else if (e.key.toLowerCase() === 'v') {
                            targetMode = this.viewMode === 'edit' ? 'read' : 'edit';
                        }
                        if (targetMode !== null) {
                            e.preventDefault();
                            this.viewMode = targetMode;
                        }
                    }
                    
                    // Bold, italic and the rest come from Tiptap's keymap
                    if (noteEditor?.isFocused() && this.currentNote) {
                        // Ctrl/Cmd + K for link
                        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                            e.preventDefault();
                            this.formatText('link');
                        }
                        
                        // Ctrl/Cmd + Alt/Option + T for table
                        if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 't') {
                            e.preventDefault();
                            this.formatText('table');
                        }
                    }
                    
                    // Escape to exit Zen mode (works anywhere)
                    if (e.key === 'Escape' && this.zenMode) {
                        e.preventDefault();
                        this.toggleZenMode();
                    }
                });
            }
            
            // Listen for system theme changes
            if (window.matchMedia) {
                window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                    if (this.currentTheme === 'system') {
                        this.applyTheme('system');
                    }
                });
            }
            
            // Listen for fullscreen changes (to sync zen mode state)
            document.addEventListener('fullscreenchange', () => {
                if (!document.fullscreenElement && this.zenMode) {
                    // User exited fullscreen manually, exit zen mode too
                    this.zenMode = false;
                    this.viewMode = this.previousViewMode;
                }
            });
            
            // Toasts from ErrorHandler and code paths without Alpine `this`
            if (!window.__noteapp_toast_listener) {
                window.__noteapp_toast_listener = true;
                window.addEventListener('keepit:toast', (e) => {
                    const d = e.detail || {};
                    if (typeof d.message !== 'string' || !d.message) return;
                    this.toast(d.message, {
                        type: d.type || 'error',
                        durationMs: d.durationMs
                    });
                });
            }
        },
        
        // Load app configuration
        async loadConfig() {
            try {
                const response = await fetch('/api/config');
                const config = await response.json();
                this.appName = config.name;
                this.appVersion = config.version || '0.0.0';
                this.authEnabled = config.authentication?.enabled || false;
                this.demoMode = config.demoMode || false;
                // Server already clamps autosaveDelayMs to a sane range; we just sanity-check the type.
                if (Number.isFinite(config.autosaveDelayMs) && config.autosaveDelayMs > 0) {
                    this.autosaveDelayMs = config.autosaveDelayMs;
                }
                if (typeof config.defaultTheme === 'string' && config.defaultTheme) {
                    this.defaultTheme = config.defaultTheme;
                }
                if (Number.isFinite(config.uploadMaxNoteMb) && config.uploadMaxNoteMb > 0) {
                    this.uploadMaxNoteMb = config.uploadMaxNoteMb;
                }
                this.linkPreviews = config.linkPreviews === true;
                if (typeof config.sharePublicOrigin === 'string' && config.sharePublicOrigin) {
                    this.sharePublicOrigin = config.sharePublicOrigin;
                }
            } catch (error) {
                console.error('Failed to load config:', error);
            }
        },
        
        
        // Refresh DOM element cache
        refreshDOMCache() {
            this._domCache.editor = document.getElementById('note-editor');
        },
    };
}
