import { Editor } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { EditorState } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';

import { joinFrontmatter, splitFrontmatter } from './markdown.js';
import { Embed, MathBlock, MathInline, Wikilink } from './nodes.js';
import { highlightMatches, SearchHighlight } from './search.js';
import { wikilinkSuggestion } from './suggest.js';
import { TabKey } from './tab.js';

/** Keeps the Markdown `src` in the document and only rewrites it for display. */
const NoteImage = Image.extend({
    addOptions() {
        return { ...this.parent?.(), resolveSrc: (src) => src };
    },
    renderHTML({ node, HTMLAttributes }) {
        const rendered = this.parent?.({ node, HTMLAttributes });
        rendered[1].src = this.options.resolveSrc(node.attrs.src);
        return rendered;
    },
});

function buildExtensions({ placeholder, resolveImageSrc, suggestion }) {
    return [
        StarterKit.configure({
            underline: false, // No Markdown form the preview renders
            link: { openOnClick: false },
        }),
        Markdown,
        TableKit,
        TaskList,
        TaskItem.configure({ nested: true }),
        NoteImage.configure({ inline: true, resolveSrc: resolveImageSrc }),
        Placeholder.configure({ placeholder }),
        Wikilink,
        Embed,
        MathInline,
        MathBlock,
        SearchHighlight,
        TabKey,
        suggestion.extension,
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
    onChange = () => {},
    onHistoryChange = () => {},
    onSuggest = () => {},
    onSuggestKey = () => false,
    onPasteImage = () => {},
    onDrop = () => false,
}) {
    let timer = null;

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
    const schedule = () => {
        cancel();
        timer = setTimeout(flush, debounceMs);
    };
    const reportHistory = (target) => onHistoryChange(target.can().undo(), target.can().redo());

    const suggestion = wikilinkSuggestion({ onChange: onSuggest, onKeyDown: onSuggestKey });
    const frontmatter = buildFrontmatterField(frontmatterLabel, schedule);
    const content = document.createElement('div');
    element.replaceChildren(frontmatter.details, content);

    const editor = new Editor({
        element: content,
        extensions: buildExtensions({ placeholder, resolveImageSrc, suggestion }),
        onUpdate: schedule,
        onBlur: () => onSuggest(null),
        onTransaction: ({ editor: target }) => reportHistory(target),
        editorProps: {
            attributes: { class: 'markdown-preview note-editor-content' },
            // Ctrl+Alt+1-3 switch the app's view mode: keep Tiptap's heading shortcuts out of it.
            handleKeyDown: (view, event) => (event.ctrlKey || event.metaKey) && event.altKey
                && /^Digit[1-3]$/.test(event.code),
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
        const { schema, state } = editor;
        const doc = json.content?.length ? schema.nodeFromJSON(json) : schema.topNodeType.createAndFill();
        editor.view.updateState(EditorState.create({ doc, plugins: state.plugins }));
        reportHistory(editor);
    }

    const FORMATS = {
        bold: (chain) => chain.toggleBold(),
        italic: (chain) => chain.toggleItalic(),
        strikethrough: (chain) => chain.toggleStrike(),
        code: (chain) => chain.toggleCode(),
        heading: (chain) => chain.toggleHeading({ level: 2 }),
        quote: (chain) => chain.toggleBlockquote(),
        bullet: (chain) => chain.toggleBulletList(),
        numbered: (chain) => chain.toggleOrderedList(),
        checkbox: (chain) => chain.toggleTaskList(),
        codeblock: (chain) => chain.toggleCodeBlock(),
        table: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
    };

    const scrollToPosition = (position, block) => {
        const { node } = editor.view.domAtPos(position);
        (node.nodeType === 1 ? node : node.parentElement).scrollIntoView({ block });
    };

    setMarkdown(markdown, { resetHistory: true });

    return {
        setMarkdown,
        getMarkdown,
        flush,
        format: (type) => FORMATS[type]?.(editor.chain().focus()).run(),
        setLink: (href) => {
            const chain = editor.chain().focus();
            if (editor.state.selection.empty) {
                return chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
            }
            return chain.setLink({ href }).run();
        },
        insertImage: (src, alt = '') => editor.chain().focus().setImage({ src, alt }).run(),
        insertMarkdown(value, position = null) {
            const options = { contentType: 'markdown' };
            if (position === null) return editor.chain().focus().insertContent(value, options).run();
            // The note may have shrunk while an upload was running.
            const target = Math.min(position, editor.state.doc.content.size);
            return editor.chain().focus().insertContentAt(target, value, options).run();
        },
        acceptSuggestion: suggestion.accept,
        highlight(findSpans, { scroll = false } = {}) {
            const first = highlightMatches(editor.view, findSpans);
            if (scroll && first !== null) scrollToPosition(first, 'center');
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
