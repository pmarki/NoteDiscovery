// Frontmatter, the outline and backlinks
function metadataFeature() {
    return {
        // Outline (TOC) state
        outline: [], // [{level: 1, text: 'Heading', slug: 'heading'}, ...]

        // Backlinks state
        backlinks: [], // [{path: 'note.md', name: 'Note', references: [{line_number: 5, context: '...', type: 'wikilink'}]}]
        
        // Note metadata (frontmatter) state
        noteMetadata: null,
        _lastFrontmatter: null, // Cache to avoid re-parsing unchanged frontmatter
        
        // ========================================================================
        // Outline (TOC) Methods
        // ========================================================================
        
        // Extract headings from markdown content for the outline
        extractOutline(content) {
            if (!content) {
                this.outline = [];
                this.backlinks = [];
                return;
            }
            
            const headings = [];
            const lines = content.split('\n');
            const slugCounts = {}; // Track duplicate slugs
            
            // Skip frontmatter and code blocks
            let inFrontmatter = false;
            let inCodeBlock = false;
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                
                // Handle frontmatter
                if (i === 0 && line.trim() === '---') {
                    inFrontmatter = true;
                    continue;
                }
                if (inFrontmatter) {
                    if (line.trim() === '---') {
                        inFrontmatter = false;
                    }
                    continue;
                }
                
                // Handle fenced code blocks (``` or ~~~)
                if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
                    inCodeBlock = !inCodeBlock;
                    continue;
                }
                if (inCodeBlock) {
                    continue;
                }
                
                // Match heading lines (# to ######)
                const match = line.match(/^(#{1,6})\s+(.+)$/);
                if (match) {
                    const level = match[1].length;
                    const text = match[2].trim();
                    
                    // Generate slug (GitHub-style)
                    let slug = text
                        .toLowerCase()
                        .replace(/[^\w\s-]/g, '') // Remove special chars
                        .replace(/\s+/g, '-')     // Spaces to dashes
                        .replace(/-+/g, '-');     // Multiple dashes to single
                    
                    // Handle duplicate slugs
                    if (slugCounts[slug] !== undefined) {
                        slugCounts[slug]++;
                        slug = `${slug}-${slugCounts[slug]}`;
                    } else {
                        slugCounts[slug] = 0;
                    }
                    
                    headings.push({
                        level,
                        text,
                        slug,
                        line: i + 1 // 1-indexed line number
                    });
                }
            }
            
            this.outline = headings;
        },
        
        // Scroll to a heading in the editor
        scrollToHeading(heading) {
            noteEditor?.jumpToHeading(heading.text);
        },

        // Navigate to a backlink (note that links to current note)
        navigateToBacklink(backlinkPath) {
            this.loadNote(backlinkPath);
        },
        
        // Parse YAML frontmatter metadata from note content
        parseMetadata() {
            if (!this.noteContent) {
                this.noteMetadata = null;
                this._lastFrontmatter = null;
                return;
            }
            
            const content = this.noteContent;
            
            // Check if content starts with frontmatter
            if (!content.trim().startsWith('---')) {
                this.noteMetadata = null;
                this._lastFrontmatter = null;
                return;
            }
            
            try {
                const lines = content.split('\n');
                if (lines[0].trim() !== '---') {
                    this.noteMetadata = null;
                    this._lastFrontmatter = null;
                    return;
                }
                
                // Find closing ---
                let endIdx = -1;
                for (let i = 1; i < lines.length; i++) {
                    if (lines[i].trim() === '---') {
                        endIdx = i;
                        break;
                    }
                }
                
                if (endIdx === -1) {
                    this.noteMetadata = null;
                    this._lastFrontmatter = null;
                    return;
                }
                
                // Performance optimization: skip parsing if frontmatter unchanged
                const frontmatterRaw = lines.slice(0, endIdx + 1).join('\n');
                if (frontmatterRaw === this._lastFrontmatter) {
                    return; // No change, keep existing metadata
                }
                this._lastFrontmatter = frontmatterRaw;
                
                const frontmatterLines = lines.slice(1, endIdx);
                const metadata = {};
                let currentKey = null;
                let currentValue = [];
                
                for (const line of frontmatterLines) {
                    // Check for new key: value pair (supports keys with hyphens/underscores)
                    const keyMatch = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
                    
                    if (keyMatch) {
                        // Save previous key if exists
                        if (currentKey) {
                            metadata[currentKey] = this.parseYamlValue(currentValue.join('\n'));
                        }
                        
                        currentKey = keyMatch[1];
                        const value = keyMatch[2].trim();
                        currentValue = [value];
                    } else if (line.match(/^\s+-\s+/) && currentKey) {
                        // List item continuation (e.g., "  - item")
                        currentValue.push(line);
                    } else if (line.startsWith('  ') && currentKey) {
                        // Indented content (multiline value)
                        currentValue.push(line);
                    }
                }
                
                // Save last key
                if (currentKey) {
                    metadata[currentKey] = this.parseYamlValue(currentValue.join('\n'));
                }
                
                this.noteMetadata = Object.keys(metadata).length > 0 ? metadata : null;
                
            } catch (error) {
                console.error('Failed to parse frontmatter:', error);
                this.noteMetadata = null;
                this._lastFrontmatter = null;
            }
        },
        
        // Parse a YAML value (handles arrays, strings, numbers, booleans)
        parseYamlValue(value) {
            if (!value || value.trim() === '') return null;
            
            value = value.trim();
            
            // Check for inline array: [item1, item2]
            if (value.startsWith('[') && value.endsWith(']')) {
                const inner = value.slice(1, -1);
                return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(s => s);
            }
            
            // Check for YAML list format (multiple lines starting with -)
            if (value.includes('\n  -') || value.startsWith('  -')) {
                const items = [];
                const lines = value.split('\n');
                for (const line of lines) {
                    const match = line.match(/^\s*-\s*(.+)$/);
                    if (match) {
                        items.push(match[1].trim().replace(/^["']|["']$/g, ''));
                    }
                }
                return items.length > 0 ? items : value;
            }
            
            // Check for boolean
            if (value.toLowerCase() === 'true') return true;
            if (value.toLowerCase() === 'false') return false;
            
            // Check for number
            if (/^-?\d+(\.\d+)?$/.test(value)) {
                return parseFloat(value);
            }
            
            // Return as string (remove quotes if present)
            return value.replace(/^["']|["']$/g, '');
        },
        
        // Check if a string is a URL
        isUrl(str) {
            if (typeof str !== 'string') return false;
            return /^https?:\/\/\S+$/i.test(str.trim());
        },
        
        // Escape HTML to prevent XSS
        escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        },
        
        // Format metadata value for display
        formatMetadataValue(key, value) {
            if (value === null || value === undefined) return '';
            
            // Arrays are handled separately in the template
            if (Array.isArray(value)) return value;
            
            // Format dates nicely
            if (key === 'date' || key === 'created' || key === 'modified' || key === 'updated') {
                let date;
                // Parse date-only strings (YYYY-MM-DD) as local dates to avoid timezone issues
                if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
                    const [year, month, day] = value.split('-').map(Number);
                    date = new Date(year, month - 1, day);  // month is 0-indexed
                } else {
                    date = new Date(value);
                }
                if (!isNaN(date.getTime())) {
                    return date.toLocaleDateString(this.currentLocale, { 
                        year: 'numeric', 
                        month: 'short', 
                        day: 'numeric' 
                    });
                }
            }
            
            // Booleans
            if (typeof value === 'boolean') {
                return value ? this.t('common.yes') : this.t('common.no');
            }
            
            return String(value);
        },
        
        // Format metadata value as HTML (for URL support)
        formatMetadataValueHtml(key, value) {
            const formatted = this.formatMetadataValue(key, value);
            
            // Check if it's a URL
            if (this.isUrl(formatted)) {
                const escaped = this.escapeHtml(formatted);
                // Truncate long URLs for display
                const displayUrl = formatted.length > 40 
                    ? formatted.substring(0, 37) + '...' 
                    : formatted;
                return `<a href="${escaped}" target="_blank" rel="noopener noreferrer" class="metadata-link">${this.escapeHtml(displayUrl)}</a>`;
            }
            
            return this.escapeHtml(formatted);
        },
        
        // Get priority metadata fields (shown in collapsed view)
        getPriorityMetadataFields() {
            if (!this.noteMetadata) return [];
            
            // Fields to show in collapsed view, in order of priority
            const priority = ['date', 'created', 'author', 'status', 'priority', 'type', 'category'];
            const fields = [];
            
            for (const key of priority) {
                if (this.noteMetadata[key] !== undefined && !Array.isArray(this.noteMetadata[key])) {
                    const formatted = this.formatMetadataValue(key, this.noteMetadata[key]);
                    const isUrl = this.isUrl(formatted);
                    fields.push({ 
                        key, 
                        value: formatted,
                        valueHtml: isUrl ? this.formatMetadataValueHtml(key, this.noteMetadata[key]) : this.escapeHtml(formatted),
                        isUrl
                    });
                }
            }
            
            return fields.slice(0, 3); // Show max 3 fields in collapsed view
        },
        
        // Get all metadata fields except tags (for expanded view)
        getAllMetadataFields() {
            if (!this.noteMetadata) return [];
            
            return Object.entries(this.noteMetadata)
                .filter(([key]) => key !== 'tags') // Tags shown separately
                .map(([key, value]) => {
                    const isArray = Array.isArray(value);
                    const formatted = this.formatMetadataValue(key, value);
                    const isUrl = !isArray && this.isUrl(formatted);
                    return {
                        key,
                        value: formatted,
                        valueHtml: isUrl ? this.formatMetadataValueHtml(key, value) : this.escapeHtml(formatted),
                        isArray,
                        isUrl
                    };
                });
        },
        
        // Check if note has any displayable metadata
        getHasMetadata() {
            const has = this.noteMetadata && Object.keys(this.noteMetadata).length > 0;
            return has;
        },
        
        // Get tags from metadata
        getMetadataTags() {
            if (!this.noteMetadata || !this.noteMetadata.tags) return [];
            return Array.isArray(this.noteMetadata.tags) ? this.noteMetadata.tags : [this.noteMetadata.tags];
        },

        // The properties box at the top of the editor: tags and a few fields, and when
        // open in read-only mode every field (in edit mode the editor shows the YAML).
        // Closed, a tap anywhere opens it; open, its tags filter by tag.
        _drawFrontmatter({ summary, fields, open, editable }) {
            const tag = (name) => (open
                ? `<button type="button" class="metadata-tag" data-tag="${this.escapeHtml(name)}">#${this.escapeHtml(name)}</button>`
                : `<span class="metadata-tag">#${this.escapeHtml(name)}</span>`);
            const tags = this.getMetadataTags();
            let html = '<span class="note-frontmatter-icon" aria-hidden="true">⚙️</span>';
            if (this.getHasMetadata()) {
                const shown = open ? tags : tags.slice(0, 5);
                html += shown.map(tag).join('');
                if (shown.length < tags.length) {
                    html += `<span class="note-frontmatter-more">+${tags.length - shown.length}</span>`;
                }
                if (!(open && !editable)) {
                    html += this.getPriorityMetadataFields().map((field) =>
                        `<span class="note-frontmatter-field"><span>${this.escapeHtml(field.key)}:</span> ${field.valueHtml}</span>`).join('');
                }
            } else {
                html += `<span class="note-frontmatter-label">${this.escapeHtml(this.t('editor.properties'))}</span>`;
            }
            html += `<span class="note-frontmatter-chevron" aria-hidden="true">${open ? '▲' : '▼'}</span>`;
            summary.innerHTML = html;
            summary.setAttribute('aria-label', this.t('editor.properties'));
            summary.querySelectorAll('[data-tag]').forEach((button) => {
                button.addEventListener('click', () => this.toggleTag(button.dataset.tag.toLowerCase()));
            });

            fields.innerHTML = open && !editable ? this.getAllMetadataFields().map((field) => {
                const value = field.isArray
                    ? this.noteMetadata[field.key].map((item) => `<span class="note-frontmatter-item">${this.escapeHtml(String(item))}</span>`).join('')
                    : field.valueHtml;
                return `<div class="note-frontmatter-row"><span>${this.escapeHtml(field.key)}</span><span>${value}</span></div>`;
            }).join('') : '';
        },
    };
}
