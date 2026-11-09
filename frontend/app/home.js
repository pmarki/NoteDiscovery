// The homepage
function homeFeature() {
    return {
        // Homepage state
        selectedHomepageFolder: '',
        _homepageCache: {
            folderPath: null,
            notes: null,
            folders: null,
            breadcrumb: null
        },
        
        // Homepage constants
        HOMEPAGE_MAX_NOTES: 50,
        // Read before init() so the first paint matches the saved layout.
        homepageView: localStorage.getItem('homepageView') === 'list' ? 'list' : 'cards',
        // Name filter for the current homepage folder. Separate from searchQuery,
        // which is the sidebar's full-text search.
        homepageNameQuery: '',
        
        // Computed-like helpers for homepage (cached for performance)
        homepageNotes() {
            // Return cached result if folder hasn't changed
            if (this._homepageCache.folderPath === this.selectedHomepageFolder && this._homepageCache.notes) {
                return this._homepageCache.notes;
            }
            
            if (!this.folderTree || typeof this.folderTree !== 'object') {
                return [];
            }
            
            const folderNode = this.getFolderNode(this.selectedHomepageFolder || '');
            const result = (folderNode && Array.isArray(folderNode.notes)) ? folderNode.notes : [];
            
            // Cache the result
            this._homepageCache.notes = result;
            this._homepageCache.folderPath = this.selectedHomepageFolder;
            
            return result;
        },
        
        homepageFolders() {
            // Return cached result if folder hasn't changed
            if (this._homepageCache.folderPath === this.selectedHomepageFolder && this._homepageCache.folders) {
                return this._homepageCache.folders;
            }
            
            if (!this.folderTree || typeof this.folderTree !== 'object') {
                return [];
            }
            
            // Get child folders
            let childFolders = [];
            if (!this.selectedHomepageFolder) {
                // Root level: all top-level folders
                childFolders = Object.entries(this.folderTree)
                    .filter(([key]) => key !== '__root__')
                    .map(([, folder]) => folder);
            } else {
                // Inside a folder: get its children
                const parentFolder = this.getFolderNode(this.selectedHomepageFolder);
                if (parentFolder && parentFolder.children) {
                    childFolders = Object.values(parentFolder.children);
                }
            }
            
            // Map to simplified structure (note count already cached in folder node)
            const result = childFolders
                .map(folder => ({
                    name: folder.name,
                    path: folder.path,
                    noteCount: folder.noteCount || 0  // Use pre-calculated count
                }))
                .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
            
            // Cache the result
            this._homepageCache.folders = result;
            this._homepageCache.folderPath = this.selectedHomepageFolder;
            
            return result;
        },
        
        homepageBreadcrumb() {
            // Return cached result if folder hasn't changed
            if (this._homepageCache.folderPath === this.selectedHomepageFolder && this._homepageCache.breadcrumb) {
                return this._homepageCache.breadcrumb;
            }
            
            const breadcrumb = [{ name: this.t('homepage.title'), path: '' }];
            
            if (this.selectedHomepageFolder) {
                const parts = this.selectedHomepageFolder.split('/').filter(Boolean);
                let currentPath = '';
                
                parts.forEach(part => {
                    currentPath = currentPath ? `${currentPath}/${part}` : part;
                    breadcrumb.push({ name: part, path: currentPath });
                });
            }
            
            // Cache the result
            this._homepageCache.breadcrumb = breadcrumb;
            this._homepageCache.folderPath = this.selectedHomepageFolder;
            
            return breadcrumb;
        },

        setHomepageView(mode) {
            if (mode !== 'cards' && mode !== 'list') return;
            if (mode === this.homepageView) return;
            this.homepageView = mode;
            localStorage.setItem('homepageView', mode);
        },

        homepageNameNeedle() {
            return (this.homepageNameQuery || '').trim().toLowerCase();
        },

        // Filter the current folder's notes or folders by name. An empty query
        // returns the cached source array so Alpine does not rebuild the grid.
        // Notes and folders keep separate cache entries: they share a folder, but
        // a hit for one must not satisfy the other.
        _filterHomepageByName(items, kind) {
            const needle = this.homepageNameNeedle();
            if (!needle) return items;
            const cacheKey = kind === 'notes' ? 'noteFilter' : 'folderFilter';
            const cache = this._homepageCache;
            const entry = cache[cacheKey];
            if (entry && entry.needle === needle && entry.source === items) {
                return entry.result;
            }
            const filtered = items.filter(item => (item.name || '').toLowerCase().includes(needle));
            cache[cacheKey] = { needle, source: items, result: filtered };
            return filtered;
        },

        homepageVisibleNotes() {
            return this._filterHomepageByName(this.homepageNotes(), 'notes');
        },

        homepageVisibleFolders() {
            return this._filterHomepageByName(this.homepageFolders(), 'folders');
        },

        // "3 notes", "1 folder", "2 files"
        homepageCount(kind, count) {
            return `${count} ${this.t(`homepage.${kind}_${count === 1 ? 'singular' : 'plural'}`)}`;
        },
        
        // Folders and notes under "Notes", media under "Files". Empty sections are left out.
        homepageSections() {
            const items = this.homepageVisibleNotes();
            const notes = items.filter(item => item.type === 'note');
            const files = items.filter(item => item.type !== 'note');
            return [
                { key: 'notes', label: 'homepage.section_notes', folders: this.homepageVisibleFolders(), items: notes, total: notes.length },
                { key: 'files', label: 'homepage.section_files', folders: [], items: files.map(file => ({ ...file, label: file.path.split('/').pop() })), total: files.length },
            ]
                .filter(section => section.folders.length || section.items.length)
                .map(section => ({ ...section, items: section.items.slice(0, this.HOMEPAGE_MAX_NOTES) }));
        },
        
        // Helper: Format file size nicely
        formatSize(bytes) {
            if (!bytes) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
        },
        
        // Helper: Format date using current locale
        formatDate(dateStr) {
            if (!dateStr) return '';
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return '';
            return date.toLocaleDateString(this.currentLocale, { 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric' 
            });
        },
        
        // Homepage folder navigation methods
        goToHomepageFolder(folderPath) {
            this.showGraph = false; // Close graph when navigating
            this.selectedHomepageFolder = folderPath || '';
            this.homepageNameQuery = '';
            
            // Clear editor state to show landing page
            this._commitPendingEdits();
            this.currentNote = '';
            this.currentNoteName = '';
            this.noteContent = '';
            this.closeMediaViewer();
            this.outline = [];
            this.backlinks = [];
            document.title = this.appName;
            
            // Invalidate cache to force recalculation
            this._homepageCache = {
                folderPath: null,
                notes: null,
                folders: null,
                breadcrumb: null
            };
            
            window.history.pushState({ homepageFolder: folderPath || '' }, '', '/');
        },
        
        // Navigate to homepage root and clear all editor state
        goHome() {
            this._commitPendingEdits();
            this.showGraph = false; // Close graph when going home
            this.selectedHomepageFolder = '';
            this.homepageNameQuery = '';
            this.currentNote = '';
            this.currentNoteName = '';
            this.noteContent = '';
            this.closeMediaViewer();
            this.outline = [];
            this.backlinks = [];
            this.mobileSidebarOpen = false;
            document.title = this.appName;
            
            // Invalidate cache to force recalculation
            this._homepageCache = {
                folderPath: null,
                notes: null,
                folders: null,
                breadcrumb: null
            };
            
            window.history.pushState({ homepageFolder: '' }, '', '/');
        },
        
        // Mobile files/home tab - context-aware behavior
        mobileFilesTabClick() {
            if (this.currentNote || this.currentMedia || this.showGraph) {
                // Leaving content lands in the folder the item lives in, not the vault
                // root: this tab is the only way out of a note on mobile, and dropping
                // the user at the root loses their place. Root stays one tap away on
                // the homepage breadcrumb.
                const openPath = this.currentNote || this.currentMedia;
                const parentFolder = openPath
                    ? openPath.split('/').slice(0, -1).join('/')
                    : this.selectedHomepageFolder;
                this.goToHomepageFolder(parentFolder);
                this.mobileSidebarOpen = false;
            } else {
                // On homepage → toggle files sidebar
                this.activePanel = 'files';
                this.mobileSidebarOpen = !this.mobileSidebarOpen;
            }
        },
    };
}
