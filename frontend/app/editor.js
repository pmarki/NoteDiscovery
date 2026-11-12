// The Tiptap editor: mounting it, autocomplete, popups and what it draws
function editorFeature() {
    return {
        // What the undo and redo buttons can do right now
        canUndo: false,
        canRedo: false,

        // The noteContent the editor is showing. Anything else came from outside the editor.
        _editorMarkdown: '',

        // Autocomplete popup (triggered by [[ for notes, ![[ for media, / for block commands)
        wikilinkAutocomplete: {
            open: false,
            mode: 'note',        // 'note' | 'media' | 'attach' (both) | 'slash'
            inline: false,       // slash mode where a block can't go
            query: '',
            items: [],           // [{label, secondary, insert, kind, path, prefix, modified}]
            activeIndex: 0,
            position: { top: 0, left: 0, above: false, maxHeight: 300 },
        },
        _wlClientRect: null, // Caret rectangle getter from the editor

        // Address popover for the link and image buttons
        linkPrompt: {
            open: false,
            type: 'link',        // 'link' | 'wikilink'
            href: '',
            canRemove: false,
            position: { top: 0, left: 0, above: false },
        },

        // Shown while a link, formula, diagram or media file is selected
        itemPopup: {
            open: false,
            label: '',
            actions: [],         // { label, run }
            position: { top: 0, left: 0, above: false },
        },
        _itemOutOfView: false, // Hidden only by scrolling, so scrolling back restores it

        // Formatting buttons shown over selected text
        turnIntoBlocks: TURN_INTO_BLOCKS,
        turnIntoMenu: { open: false, key: '', position: { top: 0, left: 0, above: false }, maxHeight: 300 },
        tablePopup: { open: false, top: 0, left: 0 },
        addButton: { open: false, top: 0, left: 0 },
        selectionBubble: {
            open: false,
            active: {},          // { bold, italic, strike, code, link }
            block: 'text',       // a key of the editor's BLOCKS
            codeOnly: false,     // inside a code block, where marks don't apply
            inTable: false,
            position: { top: 0, left: 0, above: true },
        },

        // Source of a formula or diagram
        sourcePrompt: {
            open: false,
            label: '',
            value: '',
            isNew: false,        // Nothing was written yet, so cancelling removes the item
            position: { top: 0, left: 0, above: false },
        },
        
        // Mermaid state cache
        lastMermaidTheme: null,
        _mermaidCount: 0,

        
        // ---- Wikilink / media autocomplete -------------------------------------
        // Triggered while typing inside [[ (notes) or ![[ (media). Suggestions are
        // computed client-side from the already-loaded notes list; no backend calls.

        // The editor reports the unfinished token, or null once it ends.
        wlUpdate(suggestion) {
            if (!suggestion) { this.wlClose(); return; }

            this.wikilinkAutocomplete.mode = suggestion.isSlash ? 'slash'
                : suggestion.isAttach ? 'attach' : (suggestion.isMedia ? 'media' : 'note');
            this.wikilinkAutocomplete.inline = !!suggestion.inline;
            this.wikilinkAutocomplete.query = suggestion.query;
            this._wlClientRect = suggestion.clientRect;
            this.wlComputeItems();
            if (this.wikilinkAutocomplete.items.length === 0) { this.wlClose(); return; }
            this.wikilinkAutocomplete.activeIndex = 0;
            this.wikilinkAutocomplete.open = true;
            this.wlUpdatePosition();
            this._updateTablePopup(noteEditor?.tableAtCursor());
        },

        // Rebuild the suggestion list for the current query/mode.
        wlComputeItems() {
            const WL_LIMIT = 8;
            const q = this.wikilinkAutocomplete.query.trim().toLowerCase();
            if (this.wikilinkAutocomplete.mode === 'slash') {
                this.wikilinkAutocomplete.items = this._slashItems(q);
                return;
            }
            const { mode } = this.wikilinkAutocomplete;
            const results = [];

            for (const note of this.notes) {
                const isMedia = note.type !== 'note';
                if (mode !== 'attach' && isMedia !== (mode === 'media')) continue;
                if (mode === 'attach' && note.path === this.currentNote) continue;

                const path = note.path;
                const folder = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';

                let label, insert;
                if (isMedia) {
                    label = path.split('/').pop();   // filename with extension
                    insert = this.relativeMediaPath(this.currentNote, path);
                } else {
                    const stem = note.name.replace(/\.md$/i, '');
                    label = stem;
                    // Bare name when unique, else folder-relative path (no extension).
                    insert = (this._noteNameCounts.get(stem.toLowerCase()) || 0) > 1
                        ? path.replace(/\.md$/i, '')
                        : stem;
                }

                const labelLower = label.toLowerCase();
                const pathLower = path.toLowerCase();
                if (q && !labelLower.includes(q) && !pathLower.includes(q)) continue;

                results.push({
                    label,
                    secondary: folder,
                    insert,
                    embed: isMedia,
                    kind: note.type,
                    path,
                    prefix: q ? labelLower.startsWith(q) : false,
                    modified: note.modified || '',
                });
            }

            // Prefix matches first, then most-recently-modified, then alphabetical.
            // `modified` is an ISO timestamp, so lexical compare orders by time.
            const byMatch = (a, b) =>
                (b.prefix - a.prefix) || b.modified.localeCompare(a.modified) || a.label.localeCompare(b.label);
            if (mode !== 'attach') {
                this.wikilinkAutocomplete.items = results.sort(byMatch).slice(0, WL_LIMIT);
                return;
            }
            // Attach puts what's nearest the note first, each group with its notes before its files
            const group = this._attachGroup();
            results.forEach((item) => { item.group = group(item.path); });
            results.sort((a, b) => (a.group - b.group) || (a.embed - b.embed) || byMatch(a, b));
            this.wikilinkAutocomplete.items = results.slice(0, ATTACH_LIMIT).map((item, index, items) => ({
                ...item,
                heading: item.group === items[index - 1]?.group ? '' : this.t(ATTACH_GROUPS[item.group]),
            }));
        },

        // How near a path is to the open note: its own files, its folder, the parent folder, elsewhere
        _attachGroup() {
            const note = this.currentNote || '';
            const own = note.replace(/\.md$/i, '.attachments/');
            const parentOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
            const folder = parentOf(note);
            const parent = folder ? parentOf(folder) : null;
            return (path) => {
                if (note && path.startsWith(own)) return 0;
                const at = parentOf(path);
                if (at === folder) return 1;
                if (at === parent) return 2;
                return 3;
            };
        },

        // Block commands matching `query`, by their translated name or English keywords
        _slashItems(query) {
            const { inline } = this.wikilinkAutocomplete;
            const commands = SLASH_COMMANDS.filter((command) => !inline || command.inline);
            const items = commands.map(({ type, group, label, hint, keywords }) => {
                const name = this.t(label);
                return {
                    label: name,
                    secondary: hint,
                    insert: type,
                    group: this.t(group),
                    search: `${name} ${keywords}`.toLowerCase(),
                    prefix: name.toLowerCase().startsWith(query),
                };
            });
            if (query) return items.filter((item) => item.search.includes(query)).sort((a, b) => b.prefix - a.prefix);
            return items.map((item, index) => ({ ...item, heading: item.group === items[index - 1]?.group ? '' : item.group }));
        },

        // Keyboard handling while the popup is open. True means the key was used,
        // so the editor leaves it alone. Stopped here too, or Escape would also leave Zen mode.
        wlOnKeydown(event) {
            const wa = this.wikilinkAutocomplete;
            if (!wa.open) return false;

            switch (event.key) {
                case 'ArrowDown':
                    this.wlMove(1);
                    break;
                case 'ArrowUp':
                    this.wlMove(-1);
                    break;
                case 'Enter':
                case 'Tab':
                    this.wlAccept(wa.items[wa.activeIndex]);
                    break;
                case 'Escape':
                    this.wlClose();
                    break;
                default:
                    return false;
            }
            event.stopPropagation();
            return true;
        },

        wlMove(delta) {
            const n = this.wikilinkAutocomplete.items.length;
            if (!n) return;
            this.wikilinkAutocomplete.activeIndex =
                (this.wikilinkAutocomplete.activeIndex + delta + n) % n;
            this.$nextTick(() => document.querySelector('.wikilink-autocomplete-item.active')?.scrollIntoView({ block: 'nearest' }));
        },

        wlAccept(item) {
            if (!item) return;
            const isSlash = this.wikilinkAutocomplete.mode === 'slash';
            if (isSlash) noteEditor?.acceptSlash();
            else noteEditor?.acceptSuggestion(item.insert, item.embed);
            this.wlClose();
            if (isSlash) this.formatText(item.insert);
        },

        wlClose() {
            if (this.wikilinkAutocomplete.open) this.wikilinkAutocomplete.open = false;
            this._updateTablePopup(noteEditor?.tableAtCursor());
            if (this._slashFromAddButton) {
                this._slashFromAddButton = false;
                // Not while the editor is still reporting the change that closed the menu
                setTimeout(() => noteEditor?.removeAddedSlash());
            }
        },

        // The + button types the / itself, so the same menu opens
        openAddMenu() {
            this._slashFromAddButton = true;
            noteEditor?.typeSlash();
        },

        // Position the popup just below the caret, clamped to the viewport.
        wlUpdatePosition() {
            const rect = this._wlClientRect?.();
            if (!rect) return;

            const POPUP_W = 360;
            const rowHeight = this.wikilinkAutocomplete.mode === 'slash' ? 30 : 36; // rough, rows with icons are taller
            const popupHeight = Math.min(this.wikilinkAutocomplete.items.length * rowHeight + 8, 300); // CSS cap
            const area = this._visibleArea();
            const roomBelow = area.bottom - rect.bottom;
            const caretTop = Math.min(rect.top, area.bottom); // The caret itself can be behind the keyboard
            const roomAbove = caretTop - area.top;
            let left = rect.left;
            if (left + POPUP_W > window.innerWidth) left = Math.max(4, window.innerWidth - POPUP_W - 4);
            // Above the caret the popup hangs from its bottom edge, so it stays
            // against the line whatever its real height is.
            const above = roomBelow < popupHeight && roomAbove > roomBelow;
            const maxHeight = Math.min(300, (above ? roomAbove : roomBelow) - 4);
            this.wikilinkAutocomplete.position = { top: above ? caretTop : rect.bottom, left, above, maxHeight };
        },
        
        // Create the editor. The mount lives inside an x-if, so this runs each time it appears.
        mountNoteEditor(element) {
            noteEditor?.destroy();
            this._editorMarkdown = this.noteContent;
            noteEditor = NoteEditor.create({
                element,
                markdown: this.noteContent,
                placeholder: () => this.t('editor.placeholder'),
                resolveImageSrc: (src) => this._editorImageSrc(src),
                onChange: (value) => this._onEditorChange(value),
                drawNode: (name, target, attrs) => this._drawNode(name, target, attrs),
                linkCards: this.linkPreviews,
                decorateCode: (pre) => this.addCopyButtonToCodeBlock(pre),
                onStateChange: ({ canUndo, canRedo, table, emptyLine, item, selection }) => {
                    this.canUndo = canUndo;
                    this.canRedo = canRedo;
                    this._updateItemPopup(item);
                    this._updateSelectionBubble(selection);
                    this._updateTablePopup(table);
                    this._updateAddButton(emptyLine);
                },
                onOpenLink: (event) => this.openEditorLink(event),
                onOpenWikilink: ({ target }) => this._openInternalHref(this._wikilinkHref(target)),
                onItemKey: (item, action) => {
                    const actions = this._itemPopupContent(item)?.actions;
                    (action === 'open' ? actions?.at(-1) : actions?.[0])?.run();
                },
                onInsertSource: () => this.openSourcePrompt(noteEditor?.itemAtSelection(), { isNew: true }),
                onTasksSet: ({ checked, changed, total }) => {
                    if (!changed) return;
                    this.toast(this.t(checked ? 'editor.tasks_all_checked' : 'editor.tasks_all_unchecked', { changed, total }));
                },
                onSuggest: (suggestion) => this.wlUpdate(suggestion),
                onSuggestKey: (event) => this.wlOnKeydown(event),
                onPasteImage: (file) => this.pasteImage(file),
                onDrop: (event) => {
                    if (!this.draggedItem && !event.dataTransfer?.files?.length) return false;
                    this.onEditorDrop(event);
                    return true;
                },
            });
            noteEditor.setEditable(this.viewMode === 'edit');
            const placePopups = () => {
                if (this.wikilinkAutocomplete.open) this.wlUpdatePosition();
                if (this.itemPopup.open || this._itemOutOfView) this._updateItemPopup(noteEditor?.itemAtSelection());
                this._updateSelectionBubble(noteEditor?.textSelection());
                this._updateTablePopup(noteEditor?.tableAtCursor());
                this._updateAddButton(noteEditor?.emptyLineAtCursor());
                if (this.turnIntoMenu.open) this._placeTurnIntoMenu();
            };
            element.addEventListener('scroll', () => {
                placePopups();
                this._rememberNoteScroll(element);
            });
            window.visualViewport?.addEventListener('resize', placePopups);
            window.visualViewport?.addEventListener('scroll', placePopups);
        },
        
        _onEditorChange(value) {
            this._editorMarkdown = value;
            if (value === this.noteContent) return;
            this.noteContent = value;
            this.autoSave();
        },
        
        _showInEditor(value, options) {
            this._editorMarkdown = value;
            noteEditor?.setMarkdown(value, options);
        },
        
        // Same mapping as the preview: local paths are served by /api/media/
        _editorImageSrc(src) {
            if (!src || /^(https?:)?\/\//.test(src) || src.startsWith('data:') || src.startsWith('/api/media/')) return src;
            const vaultRelative = this.currentNote
                ? this.resolveMarkdownMediaPathForNote(this.currentNote, src)
                : src.split('#')[0].split('?')[0];
            const suffix = src.match(/[?#].*/)?.[0] ?? '';
            return `/api/media/${this.encodeVaultRelativePathForMediaApi(vaultRelative)}${suffix}`;
        },
        
        _editorDropPosition(event) {
            return noteEditor?.positionAt(event.clientX, event.clientY) ?? null;
        },
        
        // Write out everything typed so far. Call before leaving a note: a timer that
        // fires afterwards would save the next note's content instead.
        async _commitPendingEdits() {
            noteEditor?.flush();
            if (this.saveTimeout) await this.saveNote();
            while (this.isSaving) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        },
        
        undo() {
            if (this.currentNote && this.viewMode === 'edit') noteEditor?.undo();
        },
        
        redo() {
            if (this.currentNote && this.viewMode === 'edit') noteEditor?.redo();
        },
        
        // Toolbar buttons and shortcuts
        formatText(type) {
            if (type === 'link') {
                this.openLinkPrompt(type);
                return;
            }
            if (type === 'upload') {
                this.openAttachPicker();
                return;
            }
            noteEditor?.format(type);
        },
        
        // The part of the page in view. An on-screen keyboard only shrinks the visual
        // viewport, so window.innerHeight still counts the space behind it.
        _visibleArea() {
            const viewport = window.visualViewport;
            const top = viewport?.offsetTop ?? 0;
            return { top, bottom: top + (viewport?.height ?? window.innerHeight) };
        },
        
        // Just below `rect`, or just above it when there's no room. Above, the popup hangs
        // from its bottom edge, so its real height only matters for fitting it at all.
        _popupPosition(rect, height = 46, width = 340) {
            const GAP = 6;
            const left = Math.max(4, Math.min(rect.left, window.innerWidth - width - 4));
            const area = this._visibleArea();
            if (rect.bottom + GAP + height <= area.bottom) return { top: rect.bottom + GAP, left, above: false };
            if (rect.top - GAP - height >= area.top) return { top: rect.top - GAP, left, above: true };
            return { top: Math.max(area.top + 4, area.bottom - height - 4), left, above: false };
        },
        
        _updateItemPopup(item) {
            const surface = document.getElementById('note-editor')?.getBoundingClientRect();
            // The item can scroll out of the editor while the popup is open
            const visible = item && surface && item.rect.bottom > surface.top && item.rect.top < surface.bottom;
            // A card has these actions on itself
            const card = item?.kind === 'link' && item.attrs.card && this.linkPreviews;
            const content = visible && !card ? this._itemPopupContent(item) : null;
            this._itemOutOfView = !!item && !visible;
            if (!content) {
                this.itemPopup.open = false;
                return;
            }
            this.itemPopup = { open: true, ...content, position: this._popupPosition(this._visibleRect(item.rect, surface)) };
            // Its width follows its content, so it's kept on screen once drawn
            this.$nextTick(() => {
                const width = this.$refs.itemPopup?.offsetWidth;
                const maxLeft = Math.max(4, window.innerWidth - width - 4);
                if (width && this.itemPopup.position.left > maxLeft) this.itemPopup.position.left = maxLeft;
            });
        },
        
        // Above the selection, so it doesn't cover the lines being read next
        _updateSelectionBubble(selection) {
            const surface = document.getElementById('note-editor')?.getBoundingClientRect();
            const visible = selection && surface && selection.rect.bottom > surface.top && selection.rect.top < surface.bottom;
            if (this.turnIntoMenu.open && (!visible || selection.key !== this.turnIntoMenu.key)) this.turnIntoMenu.open = false;
            if (!visible) {
                if (this.selectionBubble.open) this.selectionBubble.open = false;
                return;
            }
            const { active, block, codeOnly, inTable } = selection;
            const HEIGHT = 40;
            const GAP = 6;
            // Phones show their own menu by the selection, which can't be turned off or moved
            if (window.matchMedia('(pointer: coarse)').matches) {
                const top = Math.min(this._visibleArea().bottom, surface.bottom) - GAP;
                this.selectionBubble = { open: true, active, block, codeOnly, inTable, position: { top, left: surface.left + GAP, above: true } };
                return;
            }
            const rect = this._visibleRect(selection.rect, surface);
            const position = rect.top - GAP - HEIGHT >= this._visibleArea().top
                ? { ...this._popupPosition(rect), top: rect.top - GAP, above: true }
                : this._popupPosition(rect, HEIGHT);
            this.selectionBubble = { open: true, active, block, codeOnly, inTable, position };
        },
        
        toggleTurnIntoMenu() {
            if (this.turnIntoMenu.open) {
                this.turnIntoMenu.open = false;
                return;
            }
            this.turnIntoMenu.key = noteEditor?.textSelection()?.key ?? '';
            this.turnIntoMenu.open = true;
            this._placeTurnIntoMenu();
        },
        
        _placeTurnIntoMenu() {
            const anchor = this.$refs.selectionBubble.getBoundingClientRect();
            const area = this._visibleArea();
            const maxHeight = Math.min(320, area.bottom - area.top - 8);
            this.turnIntoMenu.maxHeight = maxHeight;
            this.turnIntoMenu.position = this._popupPosition(anchor, maxHeight);
        },
        
        turnInto(type) {
            this.turnIntoMenu.open = false;
            noteEditor?.turnInto(type);
        },
        
        // Above the table when there's room there, otherwise next to the current cell.
        // One popup at a time, and never off screen, even with an on-screen keyboard up.
        _updateTablePopup(table) {
            const surface = document.getElementById('note-editor')?.getBoundingClientRect();
            const taken = this.selectionBubble.open || this.itemPopup.open || this.wikilinkAutocomplete.open;
            const visible = table && surface && table.rect.bottom > surface.top && table.rect.top < surface.bottom;
            if (taken || !visible) {
                if (this.tablePopup.open) this.tablePopup.open = false;
                return;
            }
            const WIDTH = 190;
            const HEIGHT = 40;
            const GAP = 6;
            const area = this._visibleArea();
            const minTop = Math.max(area.top, 0) + 4;
            const maxTop = area.bottom - HEIGHT - 4;
            const hasRoom = table.rect.top - GAP - HEIGHT >= Math.max(surface.top, minTop) && table.rect.top <= maxTop;
            let top = table.rect.top - GAP - HEIGHT;
            if (!hasRoom) {
                const position = this._popupPosition(table.cellRect, HEIGHT);
                top = position.above ? position.top - HEIGHT : position.top;
            }
            const anchor = hasRoom ? table.rect : table.cellRect;
            this.tablePopup = {
                open: true,
                top: Math.max(minTop, Math.min(top, maxTop)),
                left: Math.max(4, Math.min(anchor.left, window.innerWidth - WIDTH - 4)),
            };
        },
        
        // Left of the empty line, or at its right end when there's no margin for it
        _updateAddButton(rect) {
            const surface = document.getElementById('note-editor')?.getBoundingClientRect();
            const visible = rect && surface && rect.bottom > surface.top && rect.top < surface.bottom;
            if (!visible) {
                if (this.addButton.open) this.addButton.open = false;
                return;
            }
            const SIZE = window.matchMedia('(pointer: coarse)').matches ? 36 : 26;
            const GAP = 6;
            const hasMargin = rect.left - SIZE - GAP >= surface.left;
            this.addButton = {
                open: true,
                top: (rect.top + rect.bottom - SIZE) / 2,
                left: hasMargin ? rect.left - SIZE - GAP : surface.right - SIZE - GAP,
            };
        },
        
        // A tall item can be bigger than the editor, so only its visible part counts
        _visibleRect(rect, surface) {
            return {
                top: Math.max(rect.top, surface.top),
                bottom: Math.min(rect.bottom, surface.bottom),
                left: rect.left,
            };
        },
        
        // What the popup says about `item`, or null if there's nothing to offer
        _itemPopupContent(item) {
            const editable = this.viewMode === 'edit';
            const edit = (run) => (editable ? [{ label: this.t('editor.mode_edit'), icon: ACTION_ICONS.edit, run }] : []);
            const open = (run, icon) => ({ label: this.t('format.open_link'), icon, run });
            const { kind, attrs } = item;
            if (kind === 'link') {
                return {
                    label: attrs.href,
                    actions: [
                        ...edit(() => this.openLinkPrompt('link')),
                        open(() => this.openLinkAddress(attrs.href), ACTION_ICONS.openNewTab),
                    ],
                };
            }
            if (kind === 'wikilink') {
                return {
                    label: attrs.target,
                    actions: [
                        ...edit(() => this.openWikilinkPrompt(item)),
                        open(() => this._openInternalHref(this._wikilinkHref(attrs.target)), ACTION_ICONS.openNote),
                    ],
                };
            }
            if (kind === 'embed' || kind === 'image') {
                const media = this._mediaInfo(kind, attrs);
                const actions = media ? this._mediaActions(media) : [];
                if (media && editable && (media.type === 'image' || media.type === 'drawing')) {
                    actions.push(...[4, 2, 1].map((divisor) => ({
                        label: `1/${divisor}`,
                        run: () => this._scaleSelectedImage(kind, attrs, divisor),
                    })));
                }
                return actions.length ? { label: media.name, actions } : null;
            }
            const actions = edit(() => this.openSourcePrompt(noteEditor?.itemAtSelection()));
            return actions.length ? { label: this._sourceLabel(kind), actions } : null;
        },
        
        // Show the selected image at a fraction of its original width. Only the width
        // is written, so the height follows and the aspect stays. 1/1 removes the size.
        // The file is untouched.
        _scaleSelectedImage(kind, attrs, divisor) {
            let size = '';
            if (divisor !== 1) {
                const original = noteEditor?.selectedImageSize();
                if (!original) return;
                size = String(Math.max(1, Math.round(original.width / divisor)));
            }
            if (kind === 'embed') {
                const { alt } = parseImageSizeSpec(attrs.alias || '', { allowSolo: true });
                const alias = [alt, size].filter(Boolean).join('|');
                noteEditor?.updateSelectedNode({ alias: alias || null });
            } else {
                // A bare number would be read as alt text here, so the bar stays
                const { alt } = parseImageSizeSpec(attrs.alt || '');
                noteEditor?.updateSelectedNode({ alt: size ? `${alt}|${size}` : alt });
            }
        },
        
        _sourceLabel(kind) {
            return this.t(kind === 'mermaidBlock' ? 'embed.diagram' : 'embed.formula');
        },
        
        _mediaActions(media) {
            const actions = [];
            if (media.local) {
                actions.push({ label: this.t('embed.download'), icon: ACTION_ICONS.download, run: () => this._downloadMedia(media) });
            }
            if (media.local || /^(https?:)?\/\//.test(media.url)) {
                actions.push({ label: this.t('embed.open_new_tab'), icon: ACTION_ICONS.openNewTab, run: () => window.open(media.url, '_blank', 'noopener') });
            }
            return actions;
        },
        
        _downloadMedia({ url, name }) {
            const link = document.createElement('a');
            link.href = url;
            link.download = name;
            document.body.appendChild(link);
            link.click();
            link.remove();
        },
        
        // Where a media item lives and how to show it, or null for a file that isn't there
        _mediaInfo(kind, attrs) {
            let url;
            let name;
            let spec;
            if (kind === 'embed') {
                const file = this._embedFile(attrs.target.trim());
                if (!file) return null;
                url = `/api/media/${this.encodeVaultRelativePathForMediaApi(file.path)}${file.suffix}`;
                name = file.path.split('/').pop();
                spec = parseImageSizeSpec(attrs.alias || '', { allowSolo: true });
            } else {
                url = this._editorImageSrc(attrs.src);
                if (!url) return null;
                spec = parseImageSizeSpec(attrs.alt || '');
                name = url.startsWith('data:') ? (spec.alt || 'image') : this._fileNameOfUrl(url);
            }
            return {
                ...spec,
                url,
                name,
                alt: spec.alt || name.replace(/\.[^/.]+$/, ''),
                type: url.startsWith('data:') ? 'image' : (this.getMediaType(url.split(/[?#]/)[0]) || 'image'),
                local: this.safeMediaApiSrc(url) !== null,
            };
        },
        
        _fileNameOfUrl(url) {
            const last = url.split(/[?#]/)[0].split('/').pop();
            try {
                return decodeURIComponent(last);
            } catch (e) {
                return last;
            }
        },
        
        // Same href the wikilink would have as a link: absolute, because it names a note
        // rather than a location. Left as written if missing: that's what gets offered for creation.
        _wikilinkHref(target) {
            const hashIndex = target.indexOf('#');
            const base = hashIndex === -1 ? target : target.slice(0, hashIndex);
            const anchor = hashIndex === -1 ? '' : target.slice(hashIndex);
            const resolved = base ? this.resolveWikiLink(base.trim()) : null;
            return encodeURI(resolved !== null ? `/${resolved}${anchor}` : target);
        },
        
        // ---- Drawing the items the editor can't render itself ----
        // Each may run again on the same element when the item changes.
        
        _drawNode(name, element, attrs) {
            if (name === 'linkCard') this._drawLinkCard(element, attrs.href);
            else if (name === 'wikilink') this._drawWikilink(element, attrs);
            else if (name === 'mathInline') this._drawMath(element, attrs.source, false);
            else if (name === 'mathBlock') this._drawMath(element, attrs.source, true);
            else if (name === 'mermaidBlock') this._drawMermaid(element, attrs.source);
            else this._drawMedia(element, name, attrs);
        },
        
        // The server's preview of a web page, or null when it couldn't be asked.
        // `reload` asks the server again; `refresh` also has it fetch the page again.
        _linkPreview(href, { refresh = false, reload = false } = {}) {
            if (refresh || reload || !linkPreviewRequests.has(href)) {
                const query = `url=${encodeURIComponent(href)}${refresh ? '&refresh=true' : ''}`;
                const request = fetch(`/api/link-previews?${query}`)
                    .then((response) => (response.ok ? response.json() : null))
                    .catch(() => null)
                    .then((preview) => {
                        // Offline or refused: the next drawing asks again
                        if (!preview) linkPreviewRequests.delete(href);
                        return preview;
                    });
                linkPreviewRequests.set(href, request);
            }
            return linkPreviewRequests.get(href);
        },
        
        async _drawLinkCard(element, href) {
            element.dataset.drawing = href;
            // Until the preview arrives, the address itself; a redraw keeps what's there
            if (!element.firstChild) this._fillLinkCard(element, href, null, true);
            if (!linkPreviewRequests.has(href)) {
                await new Promise((resolve) => setTimeout(resolve, LINK_PREVIEW_DELAY_MS));
                // Typed on since: this card is gone or shows another address
                if (!element.isConnected || element.dataset.drawing !== href) return;
            }
            const preview = await this._linkPreview(href);
            if (element.dataset.drawing === href) this._fillLinkCard(element, href, preview, false);
        },
        
        _fillLinkCard(element, href, preview, loading) {
            let host = href;
            try {
                host = new URL(href).hostname.replace(/^www\./, '');
            } catch {}
            const usable = preview && !preview.error && preview.title;
            const part = (tag, className, text) => {
                const node = document.createElement(tag);
                node.className = className;
                if (text) node.textContent = text;
                return node;
            };
            const body = part('span', 'link-card-body');
            body.append(part('span', 'link-card-title', usable ? preview.title : host));
            const description = usable ? preview.description : href;
            if (description) body.append(part('span', 'link-card-description', description));
            const site = part('span', 'link-card-site');
            if (preview?.icon) {
                const icon = part('img', 'link-card-icon');
                icon.src = preview.icon;
                icon.alt = '';
                site.append(icon);
            }
            site.append(part('span', 'truncate', (usable && preview.site_name) || host));
            body.append(site);
            const footer = part('span', 'link-card-footer');
            if (preview?.archive) footer.append(this._linkArchiveRow(href, preview.archive, part));
            footer.append(this._linkCardActions(element, href, part));
            body.append(footer);
            element.replaceChildren(body);
            if (preview?.image) {
                const image = part('img', 'link-card-image');
                image.src = preview.image;
                image.alt = '';
                image.loading = 'lazy';
                element.append(image);
            }
            element.classList.toggle('link-card-loading', loading);
            element.title = href;
            if (preview?.archive?.status === 'pending') this._pollLinkArchive(href);
        },
        
        // Changing the address, fetching its preview again and opening it. Only edit
        // mode shows them; reading, the card opens the page itself.
        _linkCardActions(element, href, part) {
            const actions = part('span', 'link-card-actions');
            const button = (label, icon, run) => actions.append(this._linkCardButton(part, label, icon, run));
            button(this.t('editor.mode_edit'), ACTION_ICONS.edit, () => {
                element.selectAddress?.();
                this.openLinkPrompt('link');
            });
            button(this.t('link_card.refresh'), ACTION_ICONS.refresh, () => this.refreshLinkCard(href));
            button(this.t('format.open_link'), ACTION_ICONS.openNewTab, () => this.openLinkAddress(href));
            return actions;
        },
        
        _linkCardButton(part, label, icon, run) {
            const node = part('button', 'link-card-action');
            node.type = 'button';
            node.title = label;
            node.setAttribute('aria-label', label);
            node.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${icon}"></path></svg>`;
            node.addEventListener('click', (event) => {
                // The card is a link itself
                event.preventDefault();
                event.stopPropagation();
                run();
            });
            return node;
        },
        
        // The offline copy in ArchiveBox: how it's going, and buttons for what it saved
        _linkArchiveRow(href, archive, part) {
            const row = part('span', 'link-card-archive');
            const status = {
                pending: 'link_card.archiving',
                archived: 'link_card.archived',
                failed: 'link_card.archive_failed',
                unavailable: 'link_card.archive_unavailable',
            }[archive.status] || 'link_card.archiving';
            row.append(part('span', `link-card-archive-status link-card-archive-${archive.status}`, this.t(status)));
            const button = (label, run) => {
                const node = part('button', 'link-card-archive-button', label);
                node.type = 'button';
                node.addEventListener('click', (event) => {
                    // The card is a link itself
                    event.preventDefault();
                    event.stopPropagation();
                    run();
                });
                row.append(node);
            };
            const icons = { page: ACTION_ICONS.web, article: ACTION_ICONS.article, pdf: ACTION_ICONS.pdf, screenshot: ACTION_ICONS.image };
            for (const [kind, icon] of Object.entries(icons)) {
                const url = archive.copies?.[kind];
                if (url) row.append(this._linkCardButton(part, this.t(`link_card.copy_${kind}`), icon, () => window.open(url, '_blank', 'noopener')));
            }
            if (archive.status === 'failed' || archive.status === 'unavailable') {
                button(this.t('link_card.archive_retry'), () => this.archiveLinkAgain(href));
            }
            return row;
        },
        
        // Asks again later while any card for the address is still on screen
        _pollLinkArchive(href) {
            if (linkArchivePolls.has(href)) return;
            linkArchivePolls.add(href);
            setTimeout(async () => {
                linkArchivePolls.delete(href);
                const shown = [...document.querySelectorAll('.link-card')].some((card) => card.dataset.drawing === href);
                if (!shown) return;
                await this._linkPreview(href, { reload: true });
                noteEditor?.refreshRendered(['linkCard']);
            }, LINK_ARCHIVE_POLL_MS);
        },
        
        async archiveLinkAgain(href) {
            try {
                const response = await fetch(`/api/link-previews/archive?url=${encodeURIComponent(href)}`, { method: 'POST' });
                if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || 'Server returned error');
                linkPreviewRequests.set(href, Promise.resolve(await response.json()));
                noteEditor?.refreshRendered(['linkCard']);
            } catch (error) {
                ErrorHandler.handle('archive link', error);
            }
        },
        
        async refreshLinkCard(href) {
            const preview = await this._linkPreview(href, { refresh: true });
            noteEditor?.refreshRendered(['linkCard']);
            if (preview?.error) this.toast(this.t('link_card.refresh_failed', { error: preview.error }), { type: 'warning' });
        },
        
        _drawWikilink(element, { target, alias }) {
            const base = target.split('#')[0].trim();
            element.textContent = alias || target;
            element.classList.toggle('wikilink-broken', !!base && this.resolveWikiLink(base) === null);
        },
        
        _drawMath(element, source, display) {
            if (!source) {
                element.textContent = this.t('embed.formula');
                return;
            }
            // Only ever this element: a page-wide pass would rewrite $ in the note's text.
            element.textContent = display ? `\\[${source}\\]` : `\\(${source}\\)`;
            mathQueue = mathQueue
                .then(() => MathJax.typesetPromise([element]))
                .then(() => {
                    // Unbalanced braces hide the closing delimiter, so MathJax leaves the text alone
                    if (!element.querySelector('mjx-container')) element.textContent = source;
                })
                .catch((error) => console.error('MathJax typesetting failed:', error));
        },
        
        async _drawMermaid(element, source) {
            element.dataset.drawing = source;
            if (!source) {
                element.textContent = this.t('embed.diagram');
                return;
            }
            const mermaid = await this._mermaidForTheme();
            if (!mermaid) {
                element.textContent = source;
                return;
            }
            const id = `mermaid-diagram-${++this._mermaidCount}`;
            try {
                const { svg } = await mermaid.render(id, source);
                if (element.dataset.drawing !== source) return; // Changed while rendering
                const container = document.createElement('div');
                container.className = 'mermaid-rendered';
                container.innerHTML = svg; // Built by Mermaid under securityLevel: 'strict'
                element.replaceChildren(container);
            } catch (error) {
                console.error('Mermaid rendering error:', error);
                document.getElementById(`d${id}`)?.remove(); // Mermaid leaves this behind on failure
                if (element.dataset.drawing !== source) return;
                const code = document.createElement('pre');
                code.textContent = source;
                const message = document.createElement('div');
                message.className = 'note-render-error';
                message.textContent = `⚠️ Mermaid diagram error: ${error.message}`;
                element.replaceChildren(code, message);
            }
        },
        
        // Mermaid, set up for the current theme, or null if it failed to load
        async _mermaidForTheme() {
            if (!(await this.loadMermaid())) return null;
            const theme = this.getThemeType() === 'light' ? 'default' : 'dark';
            // Only reinitialize if theme changed (performance optimization)
            if (this.lastMermaidTheme !== theme) {
                window.mermaid.initialize({
                    startOnLoad: false,
                    theme,
                    securityLevel: 'strict', // Use strict for better security
                    fontFamily: 'inherit',
                    // v11 changed useMaxWidth defaults - restore responsive behavior
                    flowchart: { useMaxWidth: true },
                    sequence: { useMaxWidth: true },
                    gantt: { useMaxWidth: true },
                    journey: { useMaxWidth: true },
                    timeline: { useMaxWidth: true },
                    class: { useMaxWidth: true },
                    state: { useMaxWidth: true },
                    er: { useMaxWidth: true },
                    pie: { useMaxWidth: true },
                    quadrantChart: { useMaxWidth: true },
                    requirement: { useMaxWidth: true },
                    mindmap: { useMaxWidth: true },
                    gitGraph: { useMaxWidth: true }
                });
                this.lastMermaidTheme = theme;
            }
            return window.mermaid;
        },
        
        _drawMedia(element, kind, attrs) {
            const media = this._mediaInfo(kind, attrs);
            // Redrawn whenever the file list reloads, which must not restart a playing video
            const key = media ? `${media.url}|${media.alt}|${media.width}|${media.height}` : `missing|${attrs.target}`;
            if (element.dataset.drawn === key) return;
            element.dataset.drawn = key;
            element.replaceChildren();
            
            if (!media) {
                const name = attrs.target || attrs.src || '';
                const type = this.getMediaType(name.split(/[?#]/)[0]);
                const icon = { audio: '🎵', video: '🎬', document: '📄' }[type] || '🖼️';
                element.className = 'note-chip wikilink-broken';
                element.textContent = `${icon} ${name}`;
                return;
            }
            if (media.type === 'image' || media.type === 'drawing') {
                element.className = 'note-media';
                const image = document.createElement('img');
                image.setAttribute('src', media.url);
                image.setAttribute('alt', media.alt);
                image.setAttribute('title', media.alt);
                if (media.width) image.style.width = `${media.width}px`;
                if (media.height) image.style.height = `${media.height}px`;
                element.appendChild(image);
                return;
            }
            const embed = this.buildMediaEmbed(media.type, media.url, media.alt);
            if (!embed) {
                // External audio, video and PDFs are never embedded
                element.className = 'note-chip';
                element.textContent = `${media.type === 'document' ? '📄' : '🔗'} ${media.name}`;
                return;
            }
            element.className = 'note-media note-media-block';
            if (media.type === 'video') embed.querySelector('video').preload = 'metadata';
            if (media.type === 'document') {
                // Clicks inside the PDF never reach the page, so it needs something to click
                const bar = document.createElement('span');
                bar.className = 'note-media-bar';
                bar.textContent = `📄 ${media.name}`;
                element.appendChild(bar);
            }
            element.appendChild(embed);
        },
        
        // Ask for the source of a formula or diagram
        openSourcePrompt(item, { isNew = false } = {}) {
            if (!item) return;
            const surface = document.getElementById('note-editor')?.getBoundingClientRect();
            this.sourcePrompt = {
                open: true,
                label: this._sourceLabel(item.kind),
                value: item.attrs.source || '',
                isNew,
                position: this._popupPosition(surface ? this._visibleRect(item.rect, surface) : item.rect, 300, 560),
            };
            this.$nextTick(() => document.getElementById('source-prompt-input')?.focus());
        },
        
        applySourcePrompt() {
            const source = this.sourcePrompt.value.trim();
            this.sourcePrompt.open = false;
            if (source) noteEditor?.updateSelectedNode({ source });
            else noteEditor?.deleteSelectedNode();
        },
        
        closeSourcePrompt() {
            this.sourcePrompt.open = false;
            if (this.sourcePrompt.isNew) noteEditor?.deleteSelectedNode();
            else noteEditor?.focus();
        },
        
        openWikilinkPrompt(item) {
            this.linkPrompt = {
                open: true,
                type: 'wikilink',
                href: item.attrs.target,
                canRemove: true,
                position: this._popupPosition(item.rect),
            };
            this._focusLinkPrompt();
        },
        
        // Ask for an address at the cursor, starting from the link already there
        openLinkPrompt(type) {
            if (!noteEditor) return;
            const { href, rect } = noteEditor.linkAtSelection();
            const existing = type === 'link' ? href : '';
            this.linkPrompt = {
                open: true,
                type,
                href: existing,
                canRemove: !!existing,
                position: this._popupPosition(rect),
            };
            this._focusLinkPrompt();
        },
        
        _focusLinkPrompt() {
            this.$nextTick(() => {
                const input = document.getElementById('link-prompt-input');
                input?.focus();
                input?.select();
            });
        },
        
        applyLinkPrompt() {
            const address = this.linkPrompt.href.trim();
            if (!address) {
                this.closeLinkPrompt();
                return;
            }
            const apply = {
                link: () => noteEditor?.setLink(address),
                // Anything else would change what the [[...]] means when it's read back
                wikilink: () => !/[[\]|\n]/.test(address) && noteEditor?.updateSelectedNode({ target: address }),
            };
            const applied = apply[this.linkPrompt.type]();
            if (!applied) {
                this.toast(this.t('format.invalid_link'), { type: 'warning' });
                return;
            }
            this.linkPrompt.open = false;
        },
        
        removeLinkFromPrompt() {
            if (this.linkPrompt.type === 'wikilink') noteEditor?.deleteSelectedNode();
            else noteEditor?.removeLink();
            this.linkPrompt.open = false;
        },
        
        closeLinkPrompt() {
            this.linkPrompt.open = false;
            noteEditor?.focus();
        },
        
        // Ctrl/Cmd+click on a link, or any click in read mode: otherwise it only places the cursor
        openEditorLink(event) {
            this.openLinkAddress(event.target.closest('a')?.getAttribute('href'));
        },
        
        openLinkAddress(href) {
            if (!href) return;
            if (this._isExternalHref(href)) window.open(href, '_blank', 'noopener');
            else this._openInternalHref(href);
        },
        
        /**
         * Mermaid's core is ~650 KB across two dozen chunks, so it is fetched on first
         * use rather than at page load: most notes contain no diagrams. Diagram types
         * then load on demand from ./chunks/ next to the module.
         */
        loadMermaid() {
            if (!window.mermaidReady) {
                window.mermaidReady = import('/static/vendor/mermaid/mermaid.esm.min.mjs')
                    .then((module) => (window.mermaid = module.default))
                    .catch((error) => {
                        console.error('Mermaid failed to load:', error);
                        window.mermaidReady = null; // let the next diagram retry
                        return null;
                    });
            }
            return window.mermaidReady;
        },
        
        // Add copy button to code block
        addCopyButtonToCodeBlock(preElement) {
            // Extract language from code element class (e.g., "language-toml" -> "TOML")
            const codeElement = preElement.querySelector('code');
            let language = '';
            if (codeElement && codeElement.className) {
                const match = codeElement.className.match(/language-(\w+)/);
                if (match) {
                    const langMap = {
                        'js': 'JavaScript', 'ts': 'TypeScript', 'py': 'Python',
                        'rb': 'Ruby', 'cs': 'C#', 'cpp': 'C++', 'sh': 'Shell',
                        'bash': 'Bash', 'zsh': 'Zsh', 'yml': 'YAML', 'md': 'Markdown'
                    };
                    const rawLang = match[1].toLowerCase();
                    language = langMap[rawLang] || match[1].toUpperCase();
                }
            }
            
            // Create copy button with language label
            const button = document.createElement('button');
            button.className = 'copy-code-button';
            const displayText = language || this.t('common.copy_to_clipboard').split(' ')[0]; // Use first word as fallback
            button.innerHTML = `<span>${displayText}</span>`;
            button.dataset.originalText = displayText; // Store for restore after copy
            button.title = this.t('common.copy_to_clipboard');
            
            // Style the button
            button.style.position = 'absolute';
            button.style.top = '8px';
            button.style.right = '8px';
            button.style.padding = '4px 10px';
            button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
            button.style.border = 'none';
            button.style.borderRadius = '4px';
            button.style.cursor = 'pointer';
            button.style.opacity = '0';
            button.style.transition = 'opacity 0.2s, background-color 0.2s';
            button.style.color = 'white';
            button.style.display = 'flex';
            button.style.alignItems = 'center';
            button.style.justifyContent = 'center';
            button.style.zIndex = '10';
            button.style.fontSize = '11px';
            button.style.fontWeight = '600';
            button.style.fontFamily = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
            button.style.textTransform = 'uppercase';
            button.style.letterSpacing = '0.5px';
            
            // Style the pre element to be relative
            preElement.style.position = 'relative';
            
            // Show button on hover
            preElement.addEventListener('mouseenter', () => {
                button.style.opacity = '1';
            });
            
            preElement.addEventListener('mouseleave', () => {
                button.style.opacity = '0';
            });
            
            // Copy to clipboard on click
            button.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const codeElement = preElement.querySelector('code');
                if (!codeElement) return;
                
                const code = codeElement.textContent;
                
                const originalText = button.dataset.originalText;
                const copiedText = this.t('common.copied');
                const copyTitle = this.t('common.copy_to_clipboard');
                
                try {
                    await navigator.clipboard.writeText(code);
                    
                    // Visual feedback - show localized "Copied!"
                    button.innerHTML = `<span>${copiedText}</span>`;
                    button.style.backgroundColor = 'rgba(34, 197, 94, 0.8)';
                    button.title = copiedText;
                    
                    // Reset after 2 seconds
                    setTimeout(() => {
                        button.innerHTML = `<span>${originalText}</span>`;
                        button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
                        button.title = copyTitle;
                    }, 2000);
                } catch (err) {
                    console.error('Failed to copy code:', err);
                    
                    // Fallback for older browsers
                    const textArea = document.createElement('textarea');
                    textArea.value = code;
                    textArea.style.position = 'fixed';
                    textArea.style.left = '-999999px';
                    document.body.appendChild(textArea);
                    textArea.select();
                    
                    try {
                        document.execCommand('copy');
                        button.innerHTML = `<span>${copiedText}</span>`;
                        button.style.backgroundColor = 'rgba(34, 197, 94, 0.8)';
                        setTimeout(() => {
                            button.innerHTML = `<span>${originalText}</span>`;
                            button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
                        }, 2000);
                    } catch (fallbackErr) {
                        console.error('Fallback copy failed:', fallbackErr);
                    }
                    
                    document.body.removeChild(textArea);
                }
            });
            
            // Add button to pre element
            preElement.appendChild(button);
        },
    };
}
