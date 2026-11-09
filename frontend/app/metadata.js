// Frontmatter, note stats, the outline and backlinks
function metadataFeature() {
    return {
        // Outline (TOC) state
        outline: [], // [{level: 1, text: 'Heading', slug: 'heading'}, ...]

        // Backlinks state
        backlinks: [], // [{path: 'note.md', name: 'Note', references: [{line_number: 5, context: '...', type: 'wikilink'}]}]
        
        // Stats plugin state
        statsPluginEnabled: false,
        noteStats: null,
        statsExpanded: false,
        
        // Note metadata (frontmatter) state
        noteMetadata: null,
        metadataExpanded: false,
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
        
        /**
         * Source line of every task item, in document order. Frontmatter and fenced
         * code are skipped since neither renders a checkbox. Callers pair these with the
         * rendered boxes only when the counts match, which is safe as long as this can
         * over-count but never under-count: a miss here could cancel out a spare and
         * pass that check with everything shifted by one.
         */
        _scanTaskLines(source) {
            if (typeof source !== 'string' || !source) return [];
            const lines = source.split('\n');
            const taskLines = [];
            let startIdx = 0;

            if (lines[0] && lines[0].trim() === '---') {
                for (let i = 1; i < lines.length; i++) {
                    if (lines[i].trim() === '---') {
                        startIdx = i + 1;
                        break;
                    }
                }
            }

            // Indented fences count here: one nested in a list item still hides tasks.
            const FENCE = /^\s*(`{3,}|~{3,})/;
            let openFence = null;

            for (let i = startIdx; i < lines.length; i++) {
                const fence = lines[i].match(FENCE);
                if (openFence) {
                    if (fence && fence[1][0] === openFence[0] && fence[1].length >= openFence.length) {
                        openFence = null;
                    }
                    continue;
                }
                if (fence) {
                    openFence = fence[1];
                    continue;
                }
                if (TASK_ITEM_RE.test(lines[i])) taskLines.push(i);
            }

            return taskLines;
        },

        // Check if stats plugin is enabled
        async checkStatsPlugin() {
            try {
                const response = await fetch('/api/plugins');
                const data = await response.json();
                const statsPlugin = data.plugins.find(p => p.id === 'note_stats');
                this.statsPluginEnabled = statsPlugin && statsPlugin.enabled;
                
                // Calculate stats for current note if enabled
                if (this.statsPluginEnabled && this.noteContent) {
                    this.calculateStats();
                }
            } catch (error) {
                console.error('Failed to check stats plugin:', error);
                this.statsPluginEnabled = false;
            }
        },
        
        // Calculate note statistics (client-side)
        calculateStats() {
            if (!this.statsPluginEnabled || !this.noteContent) {
                this.noteStats = null;
                return;
            }
            
            const content = this.noteContent;
            
            // Word count
            const words = (content.match(/\S+/g) || []).length;
            
            // Character count
            const chars = content.replace(/\s/g, '').length;
            const totalChars = content.length;
            
            // Reading time (200 words per minute)
            const readingTime = Math.max(1, Math.round(words / 200));
            
            // Line count
            const lines = content.split('\n').length;
            
            // Paragraph count
            const paragraphs = content.split('\n\n').filter(p => p.trim()).length;
            
            // Sentences: punctuation [.!?]+ followed by space or end-of-string
            const sentences = (content.match(/[.!?]+(?:\s|$)/g) || []).length;
            
            // List items: lines starting with -, *, + or a number (e.g. 1., 10.), excluding tasks [-]
            const listItems = (content.match(/^\s*(?:[-*+]|\d+\.)\s+(?!\[)/gm) || []).length;
            
            // Tables: markdown table separator rows (| --- | --- |)
            const tables = (content.match(/^\s*\|(?:\s*:?-+:?\s*\|){1,}\s*$/gm) || []).length;
            
            // Link count (standard markdown links)
            const markdownLinkMatches = content.match(/\[([^\]]+)\]\(([^\)]+)\)/g) || [];
            const markdownLinks = markdownLinkMatches.length;
            // Test the target, not the whole link: a label mentioning ".md" is not an internal link.
            const markdownInternalLinks = markdownLinkMatches.filter(l => /\]\([^)]+\.md(?:#[^)]*)?\)$/.test(l)).length;
            
            // Wikilink count ([[note]] or [[note|display text]] format)
            const wikilinks = (content.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g) || []).length;
            
            // Total links (markdown + wikilinks)
            const links = markdownLinks + wikilinks;
            const internalLinks = markdownInternalLinks + wikilinks; // All wikilinks are internal
            
            // Code blocks
            const codeBlocks = (content.match(/```[\s\S]*?```/g) || []).length;
            // Fences come out first: the ``` pairs around a block otherwise match
            // the inline pattern and each block counts as an inline span as well.
            const inlineCode = (content.replace(/```[\s\S]*?```/g, '').match(/`[^`]+`/g) || []).length;
            
            // Headings
            const h1 = (content.match(/^# /gm) || []).length;
            const h2 = (content.match(/^## /gm) || []).length;
            const h3 = (content.match(/^### /gm) || []).length;
            
            // Tasks: found the same way the preview's clickable checkboxes are, so the
            // panel counts exactly the boxes you can see and tick. A plain `- [x]` search
            // would instead count examples inside code fences and frontmatter while
            // missing every task on a *, + or numbered marker.
            const contentLines = content.split('\n');
            const taskLines = this._scanTaskLines(content);
            const totalTasks = taskLines.length;
            const completedTasks = taskLines.filter((i) => {
                const state = contentLines[i].match(TASK_ITEM_RE);
                return state && state[2] !== ' ';
            }).length;
            const pendingTasks = totalTasks - completedTasks;
            const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
            
            // Images
            const images = (content.match(/!\[([^\]]*)\]\(([^\)]+)\)/g) || []).length;
            
            // Blockquotes
            const blockquotes = (content.match(/^> /gm) || []).length;
            
            this.noteStats = {
                words,
                sentences,
                characters: chars,
                total_characters: totalChars,
                reading_time_minutes: readingTime,
                lines,
                paragraphs,
                list_items: listItems,
                tables,
                links,
                internal_links: internalLinks,
                external_links: links - internalLinks,
                wikilinks,
                code_blocks: codeBlocks,
                inline_code: inlineCode,
                headings: {
                    h1,
                    h2,
                    h3,
                    total: h1 + h2 + h3
                },
                tasks: {
                    total: totalTasks,
                    completed: completedTasks,
                    pending: pendingTasks,
                    completion_rate: completionRate
                },
                images,
                blockquotes
            };
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
    };
}
