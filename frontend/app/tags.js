// Tags, filters, favorites and templates
function tagsFeature() {
    return {
        favorites: [],
        favoritesSet: new Set(), // For O(1) lookups
        favoritesExpanded: true,
        
        // Tags state
        allTags: {},
        selectedTags: [],
        tagsExpanded: false,
        tagReloadTimeout: null, // For debouncing tag reloads
        
        // Template state
        showTemplateModal: false,
        availableTemplates: [],
        selectedTemplate: '',
        newTemplateNoteName: '',
        lastUsedTemplate: '',
        
        // Load all tags
        async loadTags() {
            try {
                const response = await fetch('/api/tags');
                const data = await response.json();
                this.allTags = data.tags || {};
            } catch (error) {
                ErrorHandler.handle('load tags', error, false); // Optional: no toast
            }
        },
        
        // Debounced tag reload (prevents excessive API calls during typing)
        loadTagsDebounced() {
            // Clear existing timeout
            if (this.tagReloadTimeout) {
                clearTimeout(this.tagReloadTimeout);
            }
            
            // Set new timeout - reload tags 2 seconds after last save
            this.tagReloadTimeout = setTimeout(() => {
                this.loadTags();
            }, 2000);
        },
        
        // Toggle tag selection for filtering
        toggleTag(tag) {
            const index = this.selectedTags.indexOf(tag);
            if (index > -1) {
                this.selectedTags.splice(index, 1);
            } else {
                this.selectedTags.push(tag);
            }
            
            // Apply unified filtering
            this.applyFilters();
        },
        
        // ========================================================================
        // Template Methods
        // ========================================================================
        
        // Load available templates from _templates folder
        async loadTemplates() {
            try {
                const response = await fetch('/api/templates');
                const data = await response.json();
                this.availableTemplates = data.templates || [];
            } catch (error) {
                ErrorHandler.handle('load templates', error, false); // Optional: no toast
            }
        },
        
        // Create a new note from a template
        async createNoteFromTemplate() {
            if (!this.selectedTemplate || !this.newTemplateNoteName.trim()) {
                return;
            }
            
            try {
                // Validate the note name
                const validation = FilenameValidator.validateFilename(this.newTemplateNoteName);
                if (!validation.valid) {
                    this.toast(this.getValidationErrorMessage(validation, 'note'), { type: 'warning' });
                    return;
                }
                
                // Determine the note path based on dropdown context
                let notePath = validation.sanitized;
                if (!notePath.endsWith('.md')) {
                    notePath += '.md';
                }
                
                const targetFolder = this.inferredNewItemTargetFolder();
                
                // If we have a target folder, create note in that folder
                if (targetFolder) {
                    notePath = `${targetFolder}/${notePath}`;
                }
                
                // CRITICAL: Check if note already exists
                if (this.notePathTaken(notePath)) {
                    this.toast(this.t('notes.already_exists', { name: validation.sanitized }), { type: 'warning' });
                    return;
                }
                
                // Optimistic stub: add empty entry so sidebar updates instantly.
                // Server rendering may inject content/tags; loadNote() fetches the
                // real body and tags are refreshed via loadTagsDebounced below.
                this._optimisticAddNote(notePath, { content: '' });
                const folderPart = notePath.includes('/') ? notePath.substring(0, notePath.lastIndexOf('/')) : '';
                if (folderPart) this.expandedFolders.add(folderPart);
                this._rebuildTreeAfterMutation();
                
                try {
                    const response = await fetch('/api/templates/create-note', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            templateName: this.selectedTemplate,
                            notePath: notePath
                        })
                    });
                    if (!response.ok) {
                        const error = await response.json();
                        throw new Error(error.detail || this.t('templates.create_failed'));
                    }
                    const data = await response.json();
                    
                    this.lastUsedTemplate = this.selectedTemplate;
                    try { localStorage.setItem('lastUsedTemplate', this.selectedTemplate); } catch (_) {}
                    
                    this.showTemplateModal = false;
                    this.selectedTemplate = '';
                    this.newTemplateNoteName = '';
                    
                    await this.loadNote(data.path);
                    this.focusEditorForNewNote();
                    this.loadTagsDebounced();
                } catch (err) {
                    this.toast(err.message || this.t('templates.create_failed'), { type: 'error' });
                    await this.loadNotes({ silent: true });
                }
            } catch (error) {
                ErrorHandler.handle('create note from template', error);
            }
        },
        
        // Clear all tag filters
        clearTagFilters() {
            this.selectedTags = [];
            
            // Apply unified filtering
            this.applyFilters();
        },
        
        // Unified filtering logic combining tags and text search
        async applyFilters() {
            const hasTextSearch = this.isSearchable();
            const hasTagFilter = this.selectedTags.length > 0;
            
            // Case 1: No filters at all → show full folder tree
            if (!hasTextSearch && !hasTagFilter) {
                this.isSearching = false;
                this.searchResults = [];
                this.searchPages = [];
                this.currentSearchHighlight = '';
                this.clearSearchHighlights();
                this.buildFolderTree();
                return;
            }
            
            // Case 2: Only tag filter → convert to flat list of matching notes
            if (hasTagFilter && !hasTextSearch) {
                this.isSearching = false;
                this.searchPages = [];
                this.searchResults = this.notes.filter(note => 
                    note.type === 'note' && this.noteMatchesTags(note)
                );
                this.currentSearchHighlight = '';
                this.clearSearchHighlights();
                return;
            }
            
            // Case 3: Text search (with or without tag filter)
            if (hasTextSearch) {
                this.isSearching = true;
                try {
                    const response = await fetch(`/api/search?q=${encodeURIComponent(this.searchQuery)}`);
                    const data = await response.json();
                    
                    // Apply tag filtering to search results if tags are selected
                    let results = data.results;
                    if (hasTagFilter) {
                        results = results.filter(result => {
                            const note = this.notes.find(n => n.path === result.path);
                            return note ? this.noteMatchesTags(note) : false;
                        });
                    }
                    
                    this.searchResults = results;
                    // Tags belong to notes, so a tag filter leaves saved pages out
                    this.searchPages = hasTagFilter ? [] : (data.pages || []);
                    
                    // Highlight search term in current note if open
                    if (this.currentNote && this.noteContent) {
                        this.currentSearchHighlight = this.searchQuery;
                        this.$nextTick(() => {
                            this.highlightSearchTerm(this.searchQuery);
                        });
                    }
                } catch (error) {
                    console.error('Search failed:', error);
                    this.searchResults = [];
                    this.searchPages = [];
                } finally {
                    this.isSearching = false;
                }
            }
        },
        
        // Check if a note matches selected tags (AND logic)
        noteMatchesTags(note) {
            if (this.selectedTags.length === 0) {
                return true; // No filter active
            }
            if (!note.tags || note.tags.length === 0) {
                return false; // Note has no tags but filter is active
            }
            // Check if note has ALL selected tags (AND logic)
            return this.selectedTags.every(tag => note.tags.includes(tag));
        },
        
        // Get all tags sorted by name
        get sortedTags() {
            return Object.entries(this.allTags).sort((a, b) => a[0].localeCompare(b[0]));
        },
        
        // Get tags for current note
        get currentNoteTags() {
            if (!this.currentNote) return [];
            const note = this.notes.find(n => n.path === this.currentNote);
            return note && note.tags ? note.tags : [];
        },
        
        // ==================== FAVORITES ====================
        
        // Save favorites to localStorage
        saveFavorites() {
            try {
                localStorage.setItem('noteFavorites', JSON.stringify(this.favorites));
            } catch (e) {
                console.warn('Could not save favorites to localStorage');
            }
        },
        
        // Check if a note is favorited (O(1) lookup)
        isFavorite(notePath) {
            return this.favoritesSet.has(notePath);
        },
        
        // Toggle favorite status for a note
        toggleFavorite(notePath = null) {
            const path = notePath || this.currentNote;
            if (!path) return;
            
            if (this.favoritesSet.has(path)) {
                // Remove from favorites
                this.favorites = this.favorites.filter(f => f !== path);
            } else {
                // Add to favorites
                this.favorites = [...this.favorites, path];
            }
            // Recreate Set from array for consistency
            this.favoritesSet = new Set(this.favorites);
            this.saveFavorites();
        },
        
        // Get favorite notes with full details (for display)
        get favoriteNotes() {
            return this.favorites
                .map(path => {
                    // Find note by exact path or case-insensitive match
                    let note = this.notes.find(n => n.path === path);
                    if (!note) {
                        note = this.notes.find(n => n.path.toLowerCase() === path.toLowerCase());
                    }
                    if (!note) return null;
                    return {
                        path: note.path, // Use actual path from notes (fixes case issues)
                        name: note.path.split('/').pop().replace('.md', ''),
                        folder: note.folder || ''
                    };
                })
                .filter(Boolean); // Remove nulls (deleted notes)
        },
        
        saveFavoritesExpanded() {
            try {
                localStorage.setItem('favoritesExpanded', this.favoritesExpanded.toString());
            } catch (e) {
                console.error('Error saving favorites expanded state:', e);
            }
        },
        
        // Parse tags from markdown content (matches backend logic)
        parseTagsFromContent(content) {
            if (!content || !content.trim().startsWith('---')) {
                return [];
            }
            
            try {
                const lines = content.split('\n');
                if (lines[0].trim() !== '---') return [];
                
                // Find closing ---
                let endIdx = -1;
                for (let i = 1; i < lines.length; i++) {
                    if (lines[i].trim() === '---') {
                        endIdx = i;
                        break;
                    }
                }
                
                if (endIdx === -1) return [];
                
                const frontmatterLines = lines.slice(1, endIdx);
                const tags = [];
                let inTagsList = false;
                
                for (const line of frontmatterLines) {
                    const stripped = line.trim();
                    
                    // Check for inline array: tags: [tag1, tag2]
                    if (stripped.startsWith('tags:')) {
                        const rest = stripped.substring(5).trim();
                        if (rest.startsWith('[') && rest.endsWith(']')) {
                            const tagsStr = rest.substring(1, rest.length - 1);
                            const rawTags = tagsStr.split(',').map(t => t.trim());
                            tags.push(...rawTags.filter(t => t).map(t => t.toLowerCase()));
                            break;
                        } else if (rest) {
                            tags.push(rest.toLowerCase());
                            break;
                        } else {
                            inTagsList = true;
                        }
                    } else if (inTagsList) {
                        if (stripped.startsWith('-')) {
                            const tag = stripped.substring(1).trim();
                            if (tag && !tag.startsWith('#')) {
                                tags.push(tag.toLowerCase());
                            }
                        } else if (stripped && !stripped.startsWith('#')) {
                            break;
                        }
                    }
                }
                
                return [...new Set(tags)].sort();
            } catch (e) {
                console.error('Error parsing tags:', e);
                return [];
            }
        },
    };
}
