// Themes, locales, toasts, sorting and the layout of the panels
function settingsFeature() {
    return {
        zenMode: false,
        // Hides only the .sidebar-panel content (files / search / tags / outline / etc.) while
        // keeping the icon rail visible — a lighter "focus mode" than zenMode. Persisted via
        // LOCAL_SETTINGS so it survives reload; hydrated by loadLocalSettings() at app init,
        // which is why the initial value here matches the LOCAL_SETTINGS default.
        sidebarPanelCollapsed: false,
        
        // Theme state
        currentTheme: 'light',
        availableThemes: [],
        
        // Locale/i18n state
        currentLocale: localStorage.getItem('locale') || 'en-US',
        availableLocales: [],
        // Translations loaded from backend (preloaded before Alpine init via window.__preloadedTranslations)
        translations: window.__preloadedTranslations || {},
        
        // Syntax highlighting
        
        // Readable line length (preview max-width)
        readableLineLength: true,
        
        // Hide underscore-prefixed folders (such as _templates) from sidebar
        // Read synchronously to prevent flash on initial render
        hideUnderscoreFolders: localStorage.getItem('hideUnderscoreFolders') === 'true',

        // Tab key inserts tab character instead of changing focus

        // Note sorting mode (a-z, z-a, newest, oldest, largest, smallest)
        sortMode: localStorage.getItem('sortMode') || 'a-z',

        // Icon rail / panel state
        activePanel: 'files', // 'files', 'search', 'tags', 'outline', 'backlinks', 'shared', 'trash', 'settings'
        
        // Sidebar resize state
        sidebarWidth: CONFIG.DEFAULT_SIDEBAR_WIDTH,
        isResizing: false,
        
        // Mobile sidebar state
        mobileSidebarOpen: false,
        
        // Non-blocking notifications (replaces window.alert)
        toasts: [],
        _toastIdSeq: 0,
        
        // Load available themes from backend
        async loadThemes() {
            try {
                const response = await fetch('/api/themes');
                const data = await response.json();
                
                // Use theme names directly from backend (already include emojis)
                this.availableThemes = data.themes;
            } catch (error) {
                console.error('Failed to load themes:', error);
                // Fallback to default themes
                this.availableThemes = [
                    { id: 'light', name: '🌞 Light' },
                    { id: 'dark', name: '🌙 Dark' }
                ];
            }
        },
        
        // Initialize theme system
        async initTheme() {
            // A user's saved preference takes priority over the configured default.
            const savedTheme = localStorage.getItem('noteDiscoveryTheme') || this.defaultTheme;
            this.currentTheme = savedTheme;
            await this.applyTheme(savedTheme);
        },
        
        // Set and apply theme
        async setTheme(themeId) {
            this.currentTheme = themeId;
            localStorage.setItem('noteDiscoveryTheme', themeId);
            await this.applyTheme(themeId);
        },
        
        // Load all localStorage settings at once using centralized config
        loadLocalSettings() {
            for (const [prop, config] of Object.entries(LOCAL_SETTINGS)) {
                try {
                    const saved = localStorage.getItem(config.key);
                    
                    if (saved === null) {
                        // Use default value if not set
                        this[prop] = config.default;
                    } else if (config.type === 'boolean') {
                        this[prop] = saved === 'true';
                    } else if (config.type === 'number') {
                        const num = parseFloat(saved);
                        // Validate range if specified
                        if (!isNaN(num) && 
                            (config.min === undefined || num >= config.min) && 
                            (config.max === undefined || num <= config.max)) {
                            this[prop] = num;
                        } else {
                            this[prop] = config.default;
                        }
                    } else if (config.type === 'string') {
                        // Validate against allowed values if specified
                        if (!config.valid || config.valid.includes(saved)) {
                            this[prop] = saved;
                        } else {
                            this[prop] = config.default;
                        }
                    } else if (config.type === 'json') {
                        this[prop] = JSON.parse(saved);
                    }
                } catch (error) {
                    console.error(`Error loading setting ${prop}:`, error);
                    this[prop] = config.default;
                }
            }
            
            // Special case: favorites also needs to update the Set for O(1) lookups
            this.favoritesSet = new Set(this.favorites);
        },
        
        // Readable line length toggle (for preview max-width)
        toggleReadableLineLength() {
            this.readableLineLength = !this.readableLineLength;
            localStorage.setItem('readableLineLength', this.readableLineLength);
        },
        
        // Hide underscore folders toggle (sidebar tree and graph)
        toggleHideUnderscoreFolders() {
            this.hideUnderscoreFolders = !this.hideUnderscoreFolders;
            localStorage.setItem('hideUnderscoreFolders', this.hideUnderscoreFolders);
            if (this.showGraph) {
                this.initGraph();
            }
        },

        // Hide / show only the sidebar PANEL (files, search, outline, etc.); the icon rail
        // stays put so users can still switch panels with one click after re-expanding.
        // Width is animated via CSS; sidebarWidth itself is intentionally NOT touched, so a
        // user's custom drag-resized width is restored automatically on expand.
        toggleSidebarPanel() {
            this.sidebarPanelCollapsed = !this.sidebarPanelCollapsed;
            localStorage.setItem('sidebarPanelCollapsed', this.sidebarPanelCollapsed);
        },

        // Switch the active sidebar panel (Files / Search / Tags / Outline / Backlinks / Shared
        // / Settings) with smart toggle behaviour for the icon rail:
        //
        //   collapsed       + click any icon X  → expand + switch to X
        //   expanded, on Y  + click icon X      → switch to X (no collapse change)
        //   expanded, on X  + click icon X      → collapse (symmetric "click active to close")
        //
        // That third rule matches the VS Code / Cursor / JetBrains / Obsidian convention where
        // re-clicking the active sidebar icon hides the panel. Without it, the only way to
        // collapse would be the dedicated toggle button, which is fine but leaves an asymmetry.
        //
        // On mobile (≤768px) the desktop collapse is CSS-overridden, so the panel is always
        // visible; we deliberately skip toggling in that case so a one-off mobile tap doesn't
        // silently clear the user's persisted desktop preference.
        openSidebarPanel(panelName) {
            const isDesktop = window.innerWidth > 768;
            if (isDesktop && this.activePanel === panelName && !this.sidebarPanelCollapsed) {
                this.toggleSidebarPanel();
                return;
            }
            this.activePanel = panelName;
            if (isDesktop && this.sidebarPanelCollapsed) {
                this.toggleSidebarPanel();
            }
        },

        // Sort mode configuration
        sortModes: ['a-z', 'z-a', 'newest', 'oldest', 'largest', 'smallest'],
        sortModeIcons: {
            'a-z': 'A↓',
            'z-a': 'Z↓',
            'newest': '🕐↓',
            'oldest': '🕐↑',
            'largest': '📄↓',
            'smallest': '📄↑'
        },

        // Cycle through sort modes
        cycleSortMode() {
            const currentIndex = this.sortModes.indexOf(this.sortMode);
            const nextIndex = (currentIndex + 1) % this.sortModes.length;
            this.sortMode = this.sortModes[nextIndex];
            localStorage.setItem('sortMode', this.sortMode);
            // Rebuild tree to apply new sort order
            this.buildFolderTree();
        },

        // Get current sort icon
        getSortIcon() {
            return this.sortModeIcons[this.sortMode] || 'A↓';
        },

        // Get sort comparator based on current mode (for notes)
        getSortComparator() {
            switch (this.sortMode) {
                case 'z-a':
                    return (a, b) => b.name.toLowerCase().localeCompare(a.name.toLowerCase());
                case 'newest':
                    return (a, b) => (b.modified || '').localeCompare(a.modified || '');
                case 'oldest':
                    return (a, b) => (a.modified || '').localeCompare(b.modified || '');
                case 'largest':
                    return (a, b) => (b.size || 0) - (a.size || 0);
                case 'smallest':
                    return (a, b) => (a.size || 0) - (b.size || 0);
                case 'a-z':
                default:
                    return (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
            }
        },

        // Get sort comparator for folders (only A-Z/Z-A, others default to A-Z)
        getFolderSortComparator() {
            if (this.sortMode === 'z-a') {
                return (a, b) => b.name.toLowerCase().localeCompare(a.name.toLowerCase());
            }
            // Default: A-Z for all other modes
            return (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        },

        // Apply theme to document
        async applyTheme(themeId) {
            // Load theme CSS from file. The head preload may already have inserted
            // #dynamic-theme for this id; skip the second download and the CSS write
            // in that case. Highlight.js is still updated below, because the preload
            // does not touch #highlight-theme.
            try {
                const existing = document.getElementById('dynamic-theme');
                const alreadyLoaded = existing
                    && existing.textContent
                    && document.documentElement.getAttribute('data-theme') === themeId;

                if (!alreadyLoaded) {
                    const response = await fetch(`/api/themes/${themeId}`);
                    const data = await response.json();

                    let styleEl = existing;
                    if (!styleEl) {
                        styleEl = document.createElement('style');
                        styleEl.id = 'dynamic-theme';
                        document.head.appendChild(styleEl);
                    }
                    styleEl.textContent = data.css;

                    document.documentElement.setAttribute('data-theme', themeId);
                }
                
                // Load appropriate Highlight.js theme for code syntax highlighting
                const highlightTheme = document.getElementById('highlight-theme');
                if (highlightTheme) {
                    if (themeId === 'light') {
                        highlightTheme.href = '/static/vendor/highlight.js/styles/github.min.css';
                    } else {
                        // Use dark theme for dark/custom themes
                        highlightTheme.href = '/static/vendor/highlight.js/styles/github-dark.min.css';
                    }
                }
                
                // Small delay to allow theme CSS to load
                if (this.currentNote) setTimeout(() => noteEditor?.refreshRendered(['mermaidBlock']), 100);
                
                // Refresh graph if visible (longer delay to ensure CSS is applied)
                if (this.showGraph) {
                    setTimeout(() => this.initGraph(), 300);
                }
                
                // Update PWA theme-color meta tag to match current theme
                const themeColorMeta = document.querySelector('meta[name="theme-color"]');
                if (themeColorMeta) {
                    // Get the accent color from CSS variables
                    const accentColor = getComputedStyle(document.documentElement)
                        .getPropertyValue('--accent-primary').trim() || '#667eea';
                    themeColorMeta.setAttribute('content', accentColor);
                }
            } catch (error) {
                console.error('Failed to load theme:', error);
            }
        },
        
        // ==================== INTERNATIONALIZATION ====================
        
        // Translation function - get translated string by key
        t(key, params = {}) {
            const keys = key.split('.');
            let value = this.translations;
            
            for (const k of keys) {
                value = value?.[k];
            }
            
            // Fallback to key if translation not found (silently - default translations are inline)
            if (typeof value !== 'string') {
                return key;
            }
            
            // Replace {{param}} placeholders
            return value.replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? `{{${name}}}`);
        },
        
        /**
         * Non-blocking toast (replaces window.alert). Types map to theme CSS variables.
         * @param {string} message
         * @param {{ type?: 'error'|'warning'|'info'|'success', durationMs?: number }} [options]
         * @returns {number|undefined} toast id
         */
        toast(message, options = {}) {
            if (typeof message !== 'string' || !message) return;
            const type = ['error', 'warning', 'info', 'success'].includes(options.type)
                ? options.type
                : 'info';
            let durationMs = options.durationMs;
            if (durationMs == null || typeof durationMs !== 'number' || durationMs < 0) {
                durationMs = type === 'error' ? CONFIG.TOAST_DURATION_ERROR_MS
                    : type === 'warning' ? CONFIG.TOAST_DURATION_WARNING_MS
                        : type === 'success' ? CONFIG.TOAST_DURATION_SUCCESS_MS
                            : CONFIG.TOAST_DURATION_INFO_MS;
            }
            const id = ++this._toastIdSeq;
            const entry = { id, message, type, _tid: null };
            this.toasts.push(entry);
            while (this.toasts.length > CONFIG.TOAST_MAX_VISIBLE) {
                const first = this.toasts.shift();
                if (first && first._tid) clearTimeout(first._tid);
            }
            entry._tid = setTimeout(() => this.dismissToast(id), durationMs);
            return id;
        },
        
        dismissToast(id) {
            const idx = this.toasts.findIndex((t) => t.id === id);
            if (idx === -1) return;
            const entry = this.toasts[idx];
            if (entry._tid) {
                clearTimeout(entry._tid);
                entry._tid = null;
            }
            this.toasts.splice(idx, 1);
        },
        
        /**
         * Get localized error message from FilenameValidator result
         * @param {object} validation - The validation result from FilenameValidator
         * @param {string} type - 'note' or 'folder'
         * @returns {string} Localized error message
         */
        getValidationErrorMessage(validation, type = 'note') {
            switch (validation.error) {
                case 'empty':
                    return type === 'note' 
                        ? this.t('notes.empty_name') 
                        : this.t('folders.invalid_name');
                case 'forbidden_chars':
                    return this.t('validation.forbidden_chars', { 
                        chars: validation.forbiddenChars 
                    });
                case 'reserved_name':
                    return this.t('validation.reserved_name');
                case 'invalid_dot':
                    return this.t('validation.invalid_dot');
                case 'trailing_dot_space':
                    return this.t('validation.trailing_dot_space');
                default:
                    return type === 'note' 
                        ? this.t('notes.invalid_name') 
                        : this.t('folders.invalid_name');
            }
        },
        
        // Load available locales from backend
        async loadAvailableLocales() {
            try {
                const response = await fetch('/api/locales');
                const data = await response.json();
                this.availableLocales = data.locales || [];
            } catch (error) {
                console.error('Failed to load available locales:', error);
                this.availableLocales = [{ code: 'en-US', name: 'English', flag: '🇺🇸' }];
            }
        },
        
        // Load translations for a specific locale
        async loadLocale(localeCode = null) {
            const targetLocale = localeCode || localStorage.getItem('locale') || 'en-US';
            
            try {
                const response = await fetch(`/api/locales/${targetLocale}`);
                if (response.ok) {
                    this.translations = await response.json();
                    this.currentLocale = targetLocale;
                    localStorage.setItem('locale', targetLocale);
                } else if (targetLocale !== 'en-US') {
                    // Fallback to en-US if requested locale not found
                    await this.loadLocale('en-US');
                }
            } catch (error) {
                console.error('Failed to load locale:', error);
                // If en-US also fails, translations will be empty and t() will return keys
                if (targetLocale !== 'en-US') {
                    await this.loadLocale('en-US');
                }
            }
        },
        
        // Change locale and reload translations
        async changeLocale(localeCode) {
            await this.loadLocale(localeCode);
        },
        
        // Get current theme type (light or dark)
        // Returns: 'light' or 'dark'
        // Used by features that need to adapt to theme brightness (e.g., Mermaid diagrams, Chart.js)
        getThemeType() {
            // Handle system theme
            if (this.currentTheme === 'system') {
                const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                return isDark ? 'dark' : 'light';
            }
            
            // Try to get theme type from loaded theme metadata
            const currentThemeData = this.availableThemes.find(t => t.id === this.currentTheme);
            if (currentThemeData && currentThemeData.type) {
                // Use metadata from theme file (light or dark)
                return currentThemeData.type; // Already 'light' or 'dark'
            }
            
            // Backward compatibility: fallback to hardcoded map if metadata not available
            const fallbackMap = {
                'light': 'light',
                'vs-blue': 'light'
            };
            
            return fallbackMap[this.currentTheme] || 'dark';
        },
        
        // Save sidebar width to localStorage
        saveSidebarWidth() {
            localStorage.setItem('sidebarWidth', this.sidebarWidth.toString());
        },
        
        // Save view mode to localStorage
        saveViewMode() {
            try {
                localStorage.setItem('viewMode', this.viewMode);
            } catch (error) {
                console.error('Error saving view mode:', error);
            }
        },
        
        saveTagsExpanded() {
            try {
                localStorage.setItem('tagsExpanded', this.tagsExpanded.toString());
            } catch (error) {
                console.error('Error saving tags expanded state:', error);
            }
        },
        
        saveAttachmentsExpanded() {
            try {
                localStorage.setItem('attachmentsExpanded', this.attachmentsExpanded.toString());
            } catch (error) {
                console.error('Error saving attachments expanded state:', error);
            }
        },
        
        // Start resizing sidebar
        startResize(event) {
            this.isResizing = true;
            event.preventDefault();
            
            const resize = (e) => {
                if (!this.isResizing) return;
                
                // Calculate new width based on mouse position
                const newWidth = e.clientX;
                
                // Clamp between min and max
                if (newWidth >= 200 && newWidth <= 600) {
                    this.sidebarWidth = newWidth;
                }
            };
            
            const stopResize = () => {
                if (this.isResizing) {
                    this.isResizing = false;
                    this.saveSidebarWidth();
                    document.removeEventListener('mousemove', resize);
                    document.removeEventListener('mouseup', stopResize);
                }
            };
            
            document.addEventListener('mousemove', resize);
            document.addEventListener('mouseup', stopResize);
        },
        
        // Toggle Zen Mode (full immersive writing experience)
        async toggleZenMode() {
            if (!this.zenMode) {
                // Entering Zen Mode
                this.previousViewMode = this.viewMode;
                this.viewMode = 'edit';
                this.mobileSidebarOpen = false;
                this.zenMode = true;
                
                // Request fullscreen
                try {
                    const elem = document.documentElement;
                    if (elem.requestFullscreen) {
                        await elem.requestFullscreen();
                    } else if (elem.webkitRequestFullscreen) {
                        await elem.webkitRequestFullscreen();
                    } else if (elem.msRequestFullscreen) {
                        await elem.msRequestFullscreen();
                    }
                } catch (e) {
                    // Fullscreen not supported or denied, continue anyway
                    console.log('Fullscreen not available:', e);
                }
                
                // Focus editor after transition
                setTimeout(() => noteEditor?.focus(), 300);
            } else {
                // Exiting Zen Mode
                this.zenMode = false;
                this.viewMode = this.previousViewMode;
                
                // Exit fullscreen
                try {
                    if (document.exitFullscreen) {
                        await document.exitFullscreen();
                    } else if (document.webkitExitFullscreen) {
                        await document.webkitExitFullscreen();
                    } else if (document.msExitFullscreen) {
                        await document.msExitFullscreen();
                    }
                } catch (e) {
                    console.log('Exit fullscreen error:', e);
                }
            }
        },
    };
}
