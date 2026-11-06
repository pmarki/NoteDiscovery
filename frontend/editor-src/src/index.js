import { Editor, Extension, posToDOMRect } from '@tiptap/core';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import Paragraph from '@tiptap/extension-paragraph';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';

import { joinFrontmatter, splitFrontmatter } from './markdown.js';
import { Callout, drawnView, drawOptions, Embed, MathBlock, MathInline, MermaidBlock, Wikilink } from './nodes.js';
import { highlightMatches, SearchHighlight } from './search.js';
import { acceptsBlock, slashSuggestion, wikilinkSuggestion } from './suggest.js';
import { TabKey } from './tab.js';

/** Keeps the Markdown `src` in the document and only rewrites it for display. */
const NoteImage = Image.extend({
    addOptions() {
        return { ...this.parent?.(), ...drawOptions(), resolveSrc: (src) => src };
    },
    renderHTML({ node, HTMLAttributes }) {
        const rendered = this.parent?.({ node, HTMLAttributes });
        rendered[1].src = this.options.resolveSrc(node.attrs.src);
        return rendered;
    },
    addNodeView() {
        if (!this.options.draw) return null;
        return drawnView({ name: 'image', tag: 'span', className: 'note-media', options: this.options });
    },
});

/** Tiptap lifts a lone image out of its paragraph, which suits block images. Ours are inline. */
const NoteParagraph = Paragraph.extend({
    parseMarkdown(token, helpers) {
        const tokens = token.tokens || [];
        if (tokens.length === 1 && tokens[0].type === 'image') {
            return helpers.createNode('paragraph', undefined, helpers.parseInline(tokens));
        }
        return Paragraph.config.parseMarkdown(token, helpers);
    },
});

/** Syntax highlighting, plus whatever the app adds to the block, such as a copy button. */
const NoteCodeBlock = CodeBlockLowlight.extend({
    addOptions() {
        return { ...this.parent?.(), decorate: () => {} };
    },
    addNodeView() {
        return ({ node }) => {
            const dom = document.createElement('pre');
            const code = document.createElement('code');
            const setLanguage = ({ attrs }) => {
                code.className = attrs.language ? `language-${attrs.language}` : '';
            };
            setLanguage(node);
            dom.append(code);
            this.options.decorate(dom);
            return {
                dom,
                contentDOM: code,
                update(next) {
                    if (next.type !== node.type) return false;
                    setLanguage(next);
                    return true;
                },
                stopEvent: (event) => event.target !== code && !code.contains(event.target),
                ignoreMutation: (mutation) => mutation.type !== 'selection' && !code.contains(mutation.target),
            };
        };
    },
});

const SOURCE_NODES = ['mathInline', 'mathBlock', 'mermaidBlock'];

/** Shortcuts Tiptap doesn't have. Ctrl+Alt+1-3 are taken, so headings use Ctrl+Shift like the lists. */
const NoteShortcuts = Extension.create({
    name: 'noteShortcuts',
    priority: 1000, // Ahead of the hard break on Ctrl+Enter
    addOptions: () => ({ activateItem: () => false }),
    addKeyboardShortcuts() {
        const { activateItem } = this.options;
        const shortcuts = {
            'Mod-\\': () => this.editor.chain().focus().unsetAllMarks().run(),
            Enter: () => activateItem(['wikilink', ...SOURCE_NODES], 'edit'),
            'Mod-Enter': () => activateItem(['link', 'wikilink'], 'open'),
        };
        for (let level = 1; level <= 6; level += 1) {
            shortcuts[`Mod-Shift-${level}`] = () => this.editor.commands.toggleHeading({ level });
        }
        return shortcuts;
    },
});

function buildExtensions({ placeholder, resolveImageSrc, suggestion, slash, drawing, decorateCode, activateItem }) {
    return [
        StarterKit.configure({
            codeBlock: false,
            paragraph: false,
            underline: false, // No Markdown form the app ever rendered
            link: { openOnClick: false },
        }),
        NoteParagraph,
        Markdown,
        TableKit,
        TaskList,
        TaskItem.configure({ nested: true }),
        NoteCodeBlock.configure({ lowlight: createLowlight(common), decorate: decorateCode }),
        NoteImage.configure({ inline: true, resolveSrc: resolveImageSrc, ...drawing }),
        Placeholder.configure({ placeholder }),
        Wikilink.configure(drawing),
        Embed.configure(drawing),
        MathInline.configure(drawing),
        MathBlock.configure(drawing),
        MermaidBlock.configure(drawing),
        Callout,
        SearchHighlight,
        TabKey,
        NoteShortcuts.configure({ activateItem }),
        suggestion.extension,
        slash.extension,
    ];
}

function buildFrontmatterField(label, onInput) {
    const details = document.createElement('details');
    details.className = 'note-frontmatter';
    const summary = document.createElement('summary');
    summary.textContent = label;
    const field = document.createElement('textarea');
    field.spellcheck = false;
    field.rows = 4;
    field.addEventListener('input', onInput);
    details.append(summary, field);
    return { details, field };
}

// Atoms that show the app's popup when selected.
const POPUP_NODES = new Set(['wikilink', 'embed', 'image', ...SOURCE_NODES]);
const BUBBLE_MARKS = ['bold', 'italic', 'strike', 'code', 'link'];
const SOURCE_FORMATS = { formula: 'mathBlock', diagram: 'mermaidBlock' };
// What selected text can become. Each runs after clearNodes(), so nothing stays nested in the old block.
const BLOCKS = {
    text: () => {},
    heading1: (chain) => chain.setHeading({ level: 1 }),
    heading2: (chain) => chain.setHeading({ level: 2 }),
    heading3: (chain) => chain.setHeading({ level: 3 }),
    quote: (chain) => chain.setBlockquote(),
    bullet: (chain) => chain.toggleBulletList(),
    numbered: (chain) => chain.toggleOrderedList(),
    checkbox: (chain) => chain.toggleTaskList(),
    codeblock: (chain) => chain.setCodeBlock(),
};

// The kind of block the selection starts in, as a key of BLOCKS.
function blockAtSelection(target) {
    if (target.isActive('codeBlock')) return 'codeblock';
    for (const level of [1, 2, 3]) {
        if (target.isActive('heading', { level })) return `heading${level}`;
    }
    if (target.isActive('taskList')) return 'checkbox';
    if (target.isActive('bulletList')) return 'bullet';
    if (target.isActive('orderedList')) return 'numbered';
    if (target.isActive('blockquote')) return 'quote';
    return 'text';
}

/** The checkbox of the task a click toggles in read-only mode, where the item text counts too. */
function taskBoxForClick(event, editable) {
    const { target } = event;
    if (target.matches('input[type="checkbox"]')) return target;
    if (editable || event.detail !== 1 || !window.getSelection()?.isCollapsed) return null;
    if (target.closest('a, img, video, audio, iframe, pre, button, [data-node]')) return null;
    return target.closest('ul[data-type="taskList"] > li')?.querySelector(':scope > label input') ?? null;
}

/**
 * Create the note editor inside `element`. Markdown in, Markdown out: the app never
 * sees a Tiptap object, which also keeps ProseMirror out of Alpine's reactive proxies.
 */
export function create({
    element,
    markdown = '',
    placeholder = '',
    frontmatterLabel = 'Frontmatter',
    debounceMs = 150,
    resolveImageSrc = (src) => src,
    drawNode = null,
    decorateCode = () => {},
    onChange = () => {},
    onStateChange = () => {},
    onSuggest = () => {},
    onSuggestKey = () => false,
    onOpenLink = () => {},
    onOpenWikilink = () => {},
    onItemKey = () => {},
    onInsertSource = () => {},
    onTasksSet = () => {},
    onPasteImage = () => {},
    onDrop = () => false,
}) {
    let timer = null;
    let readOnlyItem = null; // Position of the item clicked in read-only mode, which has no selection
    let dragging = false; // Mouse held down in the text, so the selection isn't final yet
    let matches = [];
    let findMatches = null;

    const cancel = () => {
        clearTimeout(timer);
        timer = null;
    };
    const getMarkdown = () => joinFrontmatter(frontmatter.field.value, editor.getMarkdown());
    const flush = () => {
        if (timer === null) return;
        cancel();
        onChange(getMarkdown());
    };
    let addedSlashAt = null;
    const schedule = () => {
        cancel();
        timer = setTimeout(flush, debounceMs);
    };
    const linkAtSelection = (target) => ({
        href: target.getAttributes('link').href || '',
        rect: target.view.coordsAtPos(target.state.selection.from),
    });
    const nodeItem = (target, pos) => {
        const node = target.state.doc.nodeAt(pos);
        const dom = target.view.nodeDOM(pos);
        if (!dom || !POPUP_NODES.has(node?.type.name)) return null;
        return { kind: node.type.name, attrs: { ...node.attrs }, rect: dom.getBoundingClientRect() };
    };
    /** What the app's popup is about: a selected atom, the link at the cursor, or null. */
    const itemAtSelection = (target) => {
        if (!target.isEditable) return readOnlyItem === null ? null : nodeItem(target, readOnlyItem);
        const { selection } = target.state;
        if (selection instanceof NodeSelection) return nodeItem(target, selection.from);
        if (!selection.empty || !target.isActive('link')) return null;
        const { href, rect } = linkAtSelection(target);
        return { kind: 'link', attrs: { href }, rect };
    };
    /** What the app's bubble toolbar is about: selected text the marks can apply to, or null. */
    const textSelection = (target) => {
        const { selection, doc } = target.state;
        if (dragging || !target.isEditable || !target.isFocused) return null;
        if (!(selection instanceof TextSelection) || selection.empty) return null;
        const { from, to, $from } = selection;
        if (!doc.textBetween(from, to, ' ', ' ').trim()) return null;
        const active = Object.fromEntries(BUBBLE_MARKS.map((mark) => [mark, target.isActive(mark)]));
        return {
            rect: posToDOMRect(target.view, from, to),
            active,
            key: `${from}:${to}`,
            block: blockAtSelection(target),
            codeOnly: !!$from.parent.type.spec.code,
            inTable: target.isActive('table'),
        };
    };
    /** Where the table popup goes: the table holding the cursor and its current cell, or null. */
    const tableAtCursor = (target) => {
        if (!target.isEditable || !target.isFocused || !target.isActive('table')) return null;
        const { $from } = target.state.selection;
        const rectAtRole = (matches) => {
            for (let depth = $from.depth; depth > 0; depth -= 1) {
                if (matches($from.node(depth).type.spec.tableRole)) {
                    return target.view.nodeDOM($from.before(depth))?.getBoundingClientRect();
                }
            }
            return null;
        };
        const rect = rectAtRole((role) => role === 'table');
        const cellRect = rectAtRole((role) => role === 'cell' || role === 'header_cell');
        return rect && cellRect ? { rect, cellRect } : null;
    };
    /** The empty line under the cursor where the + button can add a block, or null. */
    const emptyLineAtCursor = (target) => {
        const { selection } = target.state;
        if (!target.isEditable || !target.isFocused || !selection.empty) return null;
        const { $from } = selection;
        if ($from.parent.content.size || !acceptsBlock($from)) return null;
        return target.view.coordsAtPos($from.pos);
    };
    // `showItem: false` keeps the popup away while the text is being changed.
    const reportState = (target, { showItem = true } = {}) => onStateChange({
        canUndo: target.can().undo(),
        canRedo: target.can().redo(),
        table: tableAtCursor(target),
        emptyLine: emptyLineAtCursor(target),
        item: showItem && (target.isFocused || !target.isEditable) ? itemAtSelection(target) : null,
        selection: textSelection(target),
    });
    const setReadOnlyItem = (target, pos) => {
        readOnlyItem = pos;
        reportState(target);
    };

    // Position of the task item that holds `box`.
    const taskPosition = (view, box) => {
        const $pos = view.state.doc.resolve(view.posAtDOM(box, 0));
        if ($pos.nodeAfter?.type.name === 'taskItem') return $pos.pos;
        for (let depth = $pos.depth; depth > 0; depth -= 1) {
            if ($pos.node(depth).type.name === 'taskItem') return $pos.before(depth);
        }
        return null;
    };
    const toggleTask = (view, box, every) => {
        const pos = taskPosition(view, box);
        if (pos === null) return;
        const { doc, tr } = view.state;
        const checked = !doc.nodeAt(pos).attrs.checked;
        let total = 0;
        let changed = 0;
        const set = (node, at) => {
            total += 1;
            if (node.attrs.checked === checked) return;
            changed += 1;
            tr.setNodeMarkup(at, null, { ...node.attrs, checked });
        };
        if (every) {
            doc.descendants((node, at) => {
                if (node.type.name === 'taskItem') set(node, at);
            });
            onTasksSet({ checked, changed, total });
        } else {
            set(doc.nodeAt(pos), pos);
        }
        if (changed) view.dispatch(tr);
    };

    const drawing = { ...drawOptions(), draw: drawNode, views: new Set(), onInsert: () => setTimeout(onInsertSource) };
    const suggestion = wikilinkSuggestion({ onChange: onSuggest, onKeyDown: onSuggestKey });
    const slash = slashSuggestion({ onChange: onSuggest, onKeyDown: onSuggestKey });
    const activateItem = (kinds, action) => {
        const item = itemAtSelection(editor);
        if (!kinds.includes(item?.kind)) return false;
        onItemKey(item, action);
        return true;
    };
    const frontmatter = buildFrontmatterField(frontmatterLabel, schedule);
    const content = document.createElement('div');
    element.replaceChildren(frontmatter.details, content);

    const editor = new Editor({
        element: content,
        extensions: buildExtensions({ placeholder, resolveImageSrc, suggestion, slash, drawing, decorateCode, activateItem }),
        onUpdate: schedule,
        onBlur: ({ editor: target }) => {
            onSuggest(null);
            reportState(target);
        },
        onTransaction: ({ editor: target, transaction }) => {
            if (transaction.docChanged) readOnlyItem = null;
            reportState(target, { showItem: !transaction.docChanged });
        },
        onFocus: ({ editor: target }) => reportState(target),
        editorProps: {
            attributes: { class: 'markdown-preview note-editor-content' },
            // Ctrl+Alt+1-3 switch the app's view mode: keep Tiptap's heading shortcuts out of it.
            handleKeyDown: (view, event) => (event.ctrlKey || event.metaKey) && event.altKey
                && /^Digit[1-3]$/.test(event.code),
            handleClick(view, pos, event) {
                if (!view.editable) setReadOnlyItem(editor, null);
                if (!(event.ctrlKey || event.metaKey) || !event.target.closest('a')) return false;
                onOpenLink(event);
                return true;
            },
            handleClickOn(view, pos, node, nodePos, event) {
                if (!POPUP_NODES.has(node.type.name)) return false;
                const opens = !view.editable || event.ctrlKey || event.metaKey;
                if (node.type.name === 'wikilink' && opens) {
                    onOpenWikilink(node.attrs);
                    return true;
                }
                if (view.editable) return false;
                setReadOnlyItem(editor, nodePos);
                return true;
            },
            handleDOMEvents: {
                mousedown() {
                    dragging = true;
                    document.addEventListener('mouseup', () => {
                        dragging = false;
                        reportState(editor);
                    }, { once: true });
                    return false;
                },
                click(view, event) {
                    if (!(event.target instanceof Element)) return false;
                    const every = event.ctrlKey || event.metaKey;
                    const box = !view.editable || every ? taskBoxForClick(event, view.editable) : null;
                    if (box) {
                        event.preventDefault();
                        // The browser undoes the box's own change once this event ends.
                        setTimeout(() => toggleTask(view, box, every));
                        return true;
                    }
                    // Outside edit mode nothing else stops the browser following the link.
                    if (view.editable || !event.target.closest('a')) return false;
                    event.preventDefault();
                    onOpenLink(event);
                    return true;
                },
            },
            handlePaste(view, event) {
                const items = Array.from(event.clipboardData?.items || []);
                const image = items.find((item) => item.type.startsWith('image/'));
                if (image) {
                    onPasteImage(image.getAsFile());
                    return true;
                }
                const text = event.clipboardData?.getData('text/plain');
                const hasHtml = event.clipboardData?.types.includes('text/html');
                if (!text || hasHtml || view.state.selection.$from.parent.type.spec.code) return false;
                editor.commands.insertContent(text, { contentType: 'markdown' });
                return true;
            },
            handleDrop: (view, event) => onDrop(event) === true,
        },
    });

    function setMarkdown(value, { resetHistory = false } = {}) {
        cancel();
        const { yaml, body } = splitFrontmatter(value);
        frontmatter.field.value = yaml;
        frontmatter.details.open = false;
        const json = editor.markdown.parse(body);
        if (!resetHistory) {
            editor.commands.setContent(json, { emitUpdate: false });
            return;
        }
        // A new state, not setContent: otherwise undo walks back into the previous note.
        readOnlyItem = null;
        addedSlashAt = null;
        const { schema, state } = editor;
        const doc = json.content?.length ? schema.nodeFromJSON(json) : schema.topNodeType.createAndFill();
        editor.view.updateState(EditorState.create({ doc, plugins: state.plugins }));
        reportState(editor, { showItem: false });
    }

    const FORMATS = {
        bold: (chain) => chain.toggleBold(),
        italic: (chain) => chain.toggleItalic(),
        strikethrough: (chain) => chain.toggleStrike(),
        code: (chain) => chain.toggleCode(),
        heading: (chain) => chain.toggleHeading({ level: 2 }),
        heading1: (chain) => chain.toggleHeading({ level: 1 }),
        heading2: (chain) => chain.toggleHeading({ level: 2 }),
        heading3: (chain) => chain.toggleHeading({ level: 3 }),
        quote: (chain) => chain.toggleBlockquote(),
        bullet: (chain) => chain.toggleBulletList(),
        numbered: (chain) => chain.toggleOrderedList(),
        checkbox: (chain) => chain.toggleTaskList(),
        codeblock: (chain) => chain.toggleCodeBlock(),
        table: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
        divider: (chain) => chain.setHorizontalRule(),
        callout: (chain) => chain.wrapIn('callout'),
        noteLink: (chain) => chain.insertContent('[['),
        clear: (chain) => chain.unsetAllMarks(),
        addRow: (chain) => chain.addRowAfter(),
        addColumn: (chain) => chain.addColumnAfter(),
        deleteRow: (chain) => chain.deleteRow(),
        deleteColumn: (chain) => chain.deleteColumn(),
        deleteTable: (chain) => chain.deleteTable(),
    };

    // The block goes after any text on the line, and always after the paragraph a list item must start with.
    const insertSourceBlock = (name) => {
        const { state, view } = editor;
        const { $from } = state.selection;
        const type = state.schema.nodes[name];
        const replaces = !$from.parent.content.size
            && $from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), type);
        const pos = replaces ? $from.before() : $from.after();
        const tr = state.tr.replaceWith(pos, replaces ? $from.after() : pos, type.create());
        view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)));
        drawing.onInsert();
    };

    const scrollToPosition = (position, block) => {
        const { node } = editor.view.domAtPos(position);
        (node.nodeType === 1 ? node : node.parentElement).scrollIntoView({ block });
    };

    setMarkdown(markdown, { resetHistory: true });

    return {
        setMarkdown,
        getMarkdown,
        isValid() {
            try {
                editor.state.doc.check();
                return true;
            } catch {
                return false;
            }
        },
        flush,
        format(type) {
            if (type in SOURCE_FORMATS) insertSourceBlock(SOURCE_FORMATS[type]);
            else FORMATS[type]?.(editor.chain().focus()).run();
        },
        turnInto(type) {
            const chain = editor.chain().focus().clearNodes();
            BLOCKS[type]?.(chain);
            chain.run();
        },
        // Typing the / opens the normal menu. The + button uses this, so it can undo it.
        typeSlash() {
            addedSlashAt = editor.state.selection.from;
            editor.chain().focus().insertContent('/').run();
        },
        // By position, because a click elsewhere closes the menu by moving the cursor away.
        removeAddedSlash() {
            const { doc, tr } = editor.state;
            const position = addedSlashAt;
            addedSlashAt = null;
            if (position === null || position > doc.content.size) return;
            const $position = doc.resolve(position);
            if ($position.parent.textContent !== '/') return;
            editor.view.dispatch(tr.delete($position.start(), $position.end()));
        },
        tableAtCursor: () => tableAtCursor(editor),
        emptyLineAtCursor: () => emptyLineAtCursor(editor),
        linkAtSelection: () => linkAtSelection(editor),
        itemAtSelection: () => itemAtSelection(editor),
        textSelection: () => textSelection(editor),
        // Replaces the selected atom in one step, so a single undo brings the old one back.
        updateSelectedNode(attrs) {
            const { selection, tr } = editor.state;
            if (!(selection instanceof NodeSelection)) return false;
            tr.setNodeMarkup(selection.from, null, { ...selection.node.attrs, ...attrs });
            editor.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, selection.from)));
            return editor.commands.focus();
        },
        selectNodeAt: (pos) => editor.commands.setNodeSelection(pos),
        deleteSelectedNode: () => editor.chain().focus().deleteSelection().run(),
        refreshRendered(names) {
            drawing.views.forEach((view) => {
                if (names.includes(view.name)) view.redraw();
            });
        },
        setEditable(editable) {
            readOnlyItem = null;
            frontmatter.details.hidden = !editable;
            editor.setEditable(editable, false);
            reportState(editor, { showItem: false });
        },
        // False when the address isn't allowed, such as javascript:
        setLink(href) {
            if (!editor.can().setLink({ href })) return false;
            const chain = editor.chain().focus();
            if (editor.isActive('link')) {
                // Back to the old cursor, or the next keystroke would replace the whole link.
                const { from, to } = editor.state.selection;
                return chain.extendMarkRange('link').setLink({ href }).setTextSelection({ from, to }).run();
            }
            if (editor.state.selection.empty) {
                return chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
            }
            return chain.setLink({ href }).run();
        },
        removeLink() {
            const { from, to } = editor.state.selection;
            return editor.chain().focus().extendMarkRange('link').unsetLink().setTextSelection({ from, to }).run();
        },
        insertMarkdown(value, position = null) {
            const options = { contentType: 'markdown' };
            if (position === null) return editor.chain().focus().insertContent(value, options).run();
            // The note may have shrunk while an upload was running.
            const target = Math.min(position, editor.state.doc.content.size);
            return editor.chain().focus().insertContentAt(target, value, options).run();
        },
        acceptSuggestion: suggestion.accept,
        acceptSlash: slash.accept,
        highlight(findSpans) {
            findMatches = findSpans;
            matches = highlightMatches(editor.view, findSpans);
            if (matches.length) scrollToPosition(matches[0], 'center');
            return matches.length;
        },
        gotoMatch(index) {
            matches = highlightMatches(editor.view, findMatches, index);
            if (index in matches) scrollToPosition(matches[index], 'center');
        },
        jumpToHeading(text) {
            let target = null;
            editor.state.doc.descendants((node, pos) => {
                if (target === null && node.type.name === 'heading' && node.textContent.trim() === text) target = pos + 1;
                return target === null;
            });
            if (target === null) return;
            editor.chain().focus().setTextSelection(target).run();
            scrollToPosition(target, 'start');
        },
        positionAt: (left, top) => editor.view.posAtCoords({ left, top })?.pos ?? null,
        undo: () => editor.commands.undo(),
        redo: () => editor.commands.redo(),
        focus: () => editor.commands.focus(),
        isFocused: () => editor.isFocused,
        destroy() {
            cancel();
            editor.destroy();
        },
    };
}
