// Search, moving between matches and the quick switcher
function searchFeature() {
    return {
        searchQuery: '',
        searchResults: [],
        currentSearchHighlight: '', // Track current highlighted search term
        currentMatchIndex: 0, // Current match being viewed
        totalMatches: 0, // Total number of matches in the note

        // Search state
        searchDebounceTimeout: null,
        isSearching: false,
        
        // Quick Switcher state (Ctrl+Alt+P)
        showQuickSwitcher: false,
        quickSwitcherQuery: '',
        quickSwitcherIndex: 0,
        quickSwitcherResults: [],
        
        // Highlight search term in editor and preview
        highlightSearchTerm(query) {
            if (!query || !query.trim()) {
                this.clearSearchHighlights();
                return;
            }
            
            const searchTerm = query.trim();
            
            this.totalMatches = noteEditor?.highlight(
                (text) => this.findFoldedMatches(text, searchTerm)
            ) ?? 0;
            this.currentMatchIndex = this.totalMatches > 0 ? 0 : -1;
        },
        
        // Fold text the way the backend search does (case and accents ignored),
        // so a note found with "esparragos" also highlights "Espárragos".
        // ς and ß follow Python's casefold(), which the backend uses.
        foldForSearch(text) {
            return text.toLowerCase()
                .replace(/ς/g, 'σ')
                .replace(/ß/g, 'ss')
                .normalize('NFD')
                .replace(/\p{Mn}/gu, '');
        },
        
        // Find the term in the folded text and return [start, end] spans in the
        // original text, so the highlight covers the text as written. Folding can
        // change the length ("ß" becomes "ss", a combining accent disappears), so
        // each folded character remembers where it came from.
        findFoldedMatches(text, term, limit = Infinity) {
            const foldedTerm = this.foldForSearch(term);
            if (!foldedTerm) return [];
            
            let folded;
            let start = null;
            let end = null;
            if (/^[\x00-\x7f]*$/.test(text)) {
                folded = text.toLowerCase();
            } else {
                const parts = [];
                start = [];
                end = [];
                let i = 0;
                for (const ch of text) {
                    const foldedCh = this.foldForSearch(ch);
                    parts.push(foldedCh);
                    for (let k = 0; k < foldedCh.length; k++) {
                        start.push(i);
                        end.push(i + ch.length);
                    }
                    i += ch.length;
                }
                folded = parts.join('');
            }
            
            const spans = [];
            let pos = folded.indexOf(foldedTerm);
            while (pos !== -1 && spans.length < limit) {
                const matchEnd = pos + foldedTerm.length;
                if (start === null) {
                    spans.push([pos, matchEnd]);
                } else {
                    let stop = end[matchEnd - 1];
                    // Keep a combining accent with the letter it belongs to
                    while (stop < text.length && /\p{Mn}/u.test(text[stop])) {
                        stop++;
                    }
                    spans.push([start[pos], stop]);
                }
                pos = folded.indexOf(foldedTerm, matchEnd);
            }
            return spans;
        },
        
        // Navigate to next search match
        nextMatch() {
            if (this.totalMatches === 0) return;
            
            this.currentMatchIndex = (this.currentMatchIndex + 1) % this.totalMatches;
            noteEditor?.gotoMatch(this.currentMatchIndex);
        },
        
        // Navigate to previous search match
        previousMatch() {
            if (this.totalMatches === 0) return;
            
            this.currentMatchIndex = (this.currentMatchIndex - 1 + this.totalMatches) % this.totalMatches;
            noteEditor?.gotoMatch(this.currentMatchIndex);
        },
        
        // Clear search highlights
        clearSearchHighlights() {
            noteEditor?.highlight(null);
            this.totalMatches = 0;
            this.currentMatchIndex = -1;
        },
        
        // Search notes
        // Whether the query is worth sending. A single character matches most of
        // a vault and can't use the search index, so it reads every note to
        // answer something nobody wants — the sidebar shows its hint instead.
        isSearchable() {
            return this.searchQuery.trim().length >= CONFIG.SEARCH_MIN_QUERY_LENGTH;
        },

        debouncedSearchNotes() {
            if (this.searchDebounceTimeout) {
                clearTimeout(this.searchDebounceTimeout);
            }

            const hasTextSearch = this.isSearchable();
            if (!hasTextSearch) {
                this.isSearching = false;
                this.searchNotes();
                return;
            }

            this.isSearching = true;
            this.searchResults = [];

            this.searchDebounceTimeout = setTimeout(() => {
                this.searchNotes();
            }, CONFIG.SEARCH_DEBOUNCE_DELAY);
        },

        // Search notes by text (calls unified filter logic)
        async searchNotes() {
            await this.applyFilters();
        },
        
        // ============================================
        // Quick Switcher (Ctrl+Alt+P)
        // ============================================
        
        openQuickSwitcher() {
            this.showQuickSwitcher = true;
            this.quickSwitcherQuery = '';
            this.quickSwitcherIndex = 0;
            // Populate initial results
            this.quickSwitcherResults = (this.allNotes || []).slice(0, 10);
            // Focus the input after the modal renders
            this.$nextTick(() => {
                const input = document.getElementById('quickSwitcherInput');
                if (input) input.focus();
            });
        },
        
        closeQuickSwitcher() {
            this.showQuickSwitcher = false;
            this.quickSwitcherQuery = '';
            this.quickSwitcherIndex = 0;
        },
        
        // Filter notes for quick switcher based on query
        filterQuickSwitcher(query) {
            // Only include actual notes, not images
            const notes = (this.notes || []).filter(n => n.type === 'note');
            if (!query || !query.trim()) {
                // Show recent notes when no query
                return notes.slice(0, 10);
            }
            const q = query.toLowerCase();
            return notes
                .filter(n => 
                    n.name.toLowerCase().includes(q) || 
                    n.path.toLowerCase().includes(q)
                )
                .slice(0, 10);
        },
        
        // Handle keyboard navigation in quick switcher
        handleQuickSwitcherKeydown(e) {
            const results = this.quickSwitcherResults;
            
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.quickSwitcherIndex = Math.min(this.quickSwitcherIndex + 1, results.length - 1);
                this.scrollQuickSwitcherIntoView();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.quickSwitcherIndex = Math.max(this.quickSwitcherIndex - 1, 0);
                this.scrollQuickSwitcherIntoView();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const note = results[this.quickSwitcherIndex];
                if (note) {
                    this.loadNote(note.path);
                    this.closeQuickSwitcher();
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.closeQuickSwitcher();
            }
        },
        
        // Scroll selected item into view in quick switcher
        scrollQuickSwitcherIntoView() {
            this.$nextTick(() => {
                const items = document.querySelectorAll('[data-quick-switcher-item]');
                if (items[this.quickSwitcherIndex]) {
                    items[this.quickSwitcherIndex].scrollIntoView({ block: 'nearest' });
                }
            });
        },
        
        // Select note from quick switcher by click
        selectQuickSwitcherNote(note) {
            this.loadNote(note.path);
            this.closeQuickSwitcher();
        },
    };
}
