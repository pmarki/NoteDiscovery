import { InputRule, Node } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';

const TARGET = '[^\\[\\]\\n|]+';
const ALIAS = '[^\\[\\]\\n]+';
const LINK_SOURCE = `\\[\\[(${TARGET})(?:\\|(${ALIAS}))?\\]\\]`;
const WIKILINK_RE = new RegExp(`^${LINK_SOURCE}`);
const EMBED_RE = new RegExp(`^!${LINK_SOURCE}`);
// Pandoc's rule, so prices like "$5 and $6" stay plain text.
const MATH_SOURCE = '\\$(?!\\s)([^$\\n]*[^\\s$])\\$';
const MATH_RE = new RegExp(`^(?:${MATH_SOURCE}(?!\\d)|\\\\\\((.+?)\\\\\\))`);
const MATH_BLOCK_RE = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/;
const MERMAID_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid[ \t]*\n(?:([\s\S]*?)\n)? {0,3}\1[`~]*[ \t]*(?:\n|$)/;

const linkSource = (target, alias) => `[[${target}${alias ? `|${alias}` : ''}]]`;

// Replace the typed text with an inline atom once its closing characters arrive.
function atomInputRule(find, type, attrs) {
    return new InputRule({
        find,
        handler: ({ state, range, match }) => {
            state.tr.replaceWith(range.from, range.to, type.create(attrs(match)));
        },
    });
}

/**
 * View for an atom the app draws. `draw(name, element, attrs)` may finish later, and runs
 * again only when the attributes change or the app asks through `views`.
 */
export function drawnView({ name, tag, className, options, fallback }) {
    return ({ node }) => {
        const dom = document.createElement(tag);
        dom.className = className;
        dom.dataset.node = name;
        let { attrs } = node;
        const view = {
            name,
            redraw() {
                if (options.draw) options.draw(name, dom, attrs);
                else dom.textContent = fallback(attrs);
            },
        };
        options.views?.add(view);
        view.redraw();
        return {
            dom,
            ignoreMutation: () => true,
            update(next) {
                if (next.type !== node.type) return false;
                const changed = Object.keys(attrs).some((key) => attrs[key] !== next.attrs[key]);
                attrs = next.attrs;
                if (changed) view.redraw();
                return true;
            },
            destroy: () => options.views?.delete(view),
        };
    };
}

export const drawOptions = () => ({ draw: null, views: null, onInsert: null });

/** Inline atom shown as a chip. Stores attributes, so the Markdown source survives. */
function chipNode({ name, attributes, tokenRe, start, toAttrs, toSource, label, inputRe }) {
    return Node.create({
        name,
        group: 'inline',
        inline: true,
        atom: true,
        selectable: true,

        addOptions: drawOptions,
        addAttributes: () => attributes,

        parseHTML: () => [{ tag: `span[data-node="${name}"]` }],

        renderHTML({ node }) {
            const attrs = { class: `note-chip note-chip-${name}`, 'data-node': name };
            for (const key of Object.keys(attributes)) {
                if (node.attrs[key] != null) attrs[`data-${key}`] = node.attrs[key];
            }
            return ['span', attrs, label(node.attrs)];
        },

        renderText: ({ node }) => toSource(node.attrs),

        addNodeView() {
            return drawnView({ name, tag: 'span', className: `note-chip note-chip-${name}`, options: this.options, fallback: label });
        },

        markdownTokenName: name,
        markdownTokenizer: {
            name,
            level: 'inline',
            start,
            tokenize(src) {
                const match = tokenRe.exec(src);
                if (match) return { type: name, raw: match[0], attrs: toAttrs(match) };
            },
        },
        parseMarkdown: (token, helpers) => helpers.createNode(name, token.attrs),
        renderMarkdown: (node) => toSource(node.attrs),

        addInputRules() {
            return [atomInputRule(inputRe, this.type, toAttrs)];
        },
    });
}

const dataAttr = (key) => ({
    default: null,
    parseHTML: (element) => element.getAttribute(`data-${key}`),
});
const linkAttributes = { target: dataAttr('target'), alias: dataAttr('alias') };
const linkAttrs = (match) => ({ target: match[1], alias: match[2] || null });

export const Wikilink = chipNode({
    name: 'wikilink',
    attributes: linkAttributes,
    tokenRe: WIKILINK_RE,
    start: (src) => src.indexOf('[['),
    toAttrs: linkAttrs,
    toSource: ({ target, alias }) => linkSource(target, alias),
    label: ({ target, alias }) => alias || target,
    inputRe: new RegExp(`(?<!!)${LINK_SOURCE}$`),
});

export const Embed = chipNode({
    name: 'embed',
    attributes: linkAttributes,
    tokenRe: EMBED_RE,
    start: (src) => src.indexOf('![['),
    toAttrs: linkAttrs,
    toSource: ({ target, alias }) => `!${linkSource(target, alias)}`,
    label: ({ target, alias }) => alias || target,
    inputRe: new RegExp(`!${LINK_SOURCE}$`),
});

export const MathInline = chipNode({
    name: 'mathInline',
    attributes: { source: dataAttr('source') },
    tokenRe: MATH_RE,
    start: (src) => src.search(/\$|\\\(/),
    toAttrs: (match) => ({ source: match[1] ?? match[2] }),
    toSource: ({ source }) => `$${source}$`,
    label: ({ source }) => source,
    inputRe: new RegExp(`(?<=^|\\s)${MATH_SOURCE}$`),
});

/** Block atom holding source the app renders. Changed through the source box, never in place. */
function sourceBlock({ name, tokenRe, start, toSource, tokenSource, inputRe, priority }) {
    return Node.create({
        name,
        priority,
        group: 'block',
        atom: true,
        selectable: true,

        addOptions: drawOptions,
        addAttributes: () => ({ source: { ...dataAttr('source'), default: '' } }),

        parseHTML: () => [{ tag: `div[data-node="${name}"]` }],

        renderHTML: ({ node }) => ['div', { 'data-node': name, 'data-source': node.attrs.source }],

        renderText: ({ node }) => toSource(node.attrs.source),

        addNodeView() {
            return drawnView({ name, tag: 'div', className: 'note-source-block', options: this.options, fallback: ({ source }) => source });
        },

        markdownTokenName: name,
        markdownTokenizer: {
            name,
            level: 'block',
            start,
            tokenize(src) {
                const match = tokenRe.exec(src);
                if (match) return { type: name, raw: match[0], source: tokenSource(match) };
            },
        },
        parseMarkdown: (token, helpers) => helpers.createNode(name, { source: token.source }),
        renderMarkdown: (node) => toSource(node.attrs.source),

        addInputRules() {
            const { type, options } = this;
            return [new InputRule({
                find: inputRe,
                handler: ({ state, range }) => {
                    const $from = state.doc.resolve(range.from);
                    // The first child of a list item has to stay a paragraph.
                    if (!$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), type)) return null;
                    const pos = $from.before();
                    state.tr.replaceWith(pos, $from.after(), type.create());
                    state.tr.setSelection(NodeSelection.create(state.tr.doc, pos));
                    options.onInsert?.();
                    return undefined;
                },
            })];
        },
    });
}

export const MathBlock = sourceBlock({
    name: 'mathBlock',
    tokenRe: MATH_BLOCK_RE,
    start: (src) => src.search(/^(?:\$\$|\\\[)/m),
    toSource: (source) => `$$\n${source}\n$$`,
    tokenSource: (match) => (match[1] ?? match[2]).trim(),
    inputRe: /^\$\$\s$/,
});

// A fence must outrun any backticks inside the diagram.
const fenceFor = (source) => '`'.repeat(Math.max(3, ...(source.match(/`+/g) || []).map((run) => run.length + 1)));

export const MermaidBlock = sourceBlock({
    name: 'mermaidBlock',
    tokenRe: MERMAID_RE,
    start: (src) => src.search(/^ {0,3}(?:`{3,}|~{3,})[ \t]*mermaid[ \t]*$/m),
    toSource: (source) => `${fenceFor(source)}mermaid\n${source}\n${fenceFor(source)}`,
    tokenSource: (match) => match[2] || '',
    inputRe: /^```mermaid[\s\n]$/,
    priority: 110, // Ahead of the code block's own ``` rule
});


const CALLOUTS = {
    note: { icon: 'ℹ️', title: 'Note' },
    tip: { icon: '💡', title: 'Tip' },
    important: { icon: '❗', title: 'Important' },
    warning: { icon: '⚠️', title: 'Warning' },
    caution: { icon: '🛑', title: 'Caution' },
};
const CALLOUT_RE = /^ {0,3}>[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)(?:\n|$)((?:>.*(?:\n|$))*)/i;

/** GitHub-style `> [!TIP]` block. Its body is ordinary editable content. */
export const Callout = Node.create({
    name: 'callout',
    group: 'block',
    content: 'block+',
    defining: true,

    addAttributes: () => ({
        type: { default: 'note', parseHTML: (element) => element.dataset.callout },
        title: dataAttr('title'),
    }),

    parseHTML: () => [{ tag: 'div[data-callout]', contentElement: '.callout-body' }],

    renderHTML({ node }) {
        const { type, title } = node.attrs;
        const attrs = { class: `callout callout-${type}`, 'data-callout': type };
        if (title) attrs['data-title'] = title;
        return ['div', attrs,
            ['div', { class: 'callout-title', contenteditable: 'false' },
                ['span', { class: 'callout-icon', 'aria-hidden': 'true' }, CALLOUTS[type].icon],
                ['span', { class: 'callout-title-text' }, title || CALLOUTS[type].title]],
            ['div', { class: 'callout-body' }, 0]];
    },

    markdownTokenName: 'callout',
    markdownTokenizer: {
        name: 'callout',
        level: 'block',
        start: (src) => src.search(/^ {0,3}>[ \t]*\[!/m),
        tokenize(src, tokens, lexer) {
            const match = CALLOUT_RE.exec(src);
            if (!match) return undefined;
            const body = match[3].replace(/^>[ \t]?/gm, '').trimEnd();
            return {
                type: 'callout',
                raw: match[0],
                calloutType: match[1].toLowerCase(),
                title: match[2].trim() || null,
                tokens: lexer.blockTokens(body),
            };
        },
    },
    parseMarkdown(token, helpers) {
        const content = helpers.parseChildren(token.tokens || []);
        return helpers.createNode(
            'callout',
            { type: token.calloutType, title: token.title },
            content.length ? content : [helpers.createNode('paragraph')]
        );
    },
    renderMarkdown(node, helpers) {
        const { type, title } = node.attrs;
        const body = (node.content || []).map((child) => helpers.renderChildren([child])).join('\n\n');
        const lines = body.split('\n').map((line) => (line.trim() ? `> ${line}` : '>'));
        return [`> [!${type.toUpperCase()}]${title ? ` ${title}` : ''}`, ...lines].join('\n');
    },
});
