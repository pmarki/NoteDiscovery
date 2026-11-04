import { InputRule, Node, textblockTypeInputRule } from '@tiptap/core';

const TARGET = '[^\\[\\]\\n|]+';
const ALIAS = '[^\\[\\]\\n]+';
const LINK_SOURCE = `\\[\\[(${TARGET})(?:\\|(${ALIAS}))?\\]\\]`;
const WIKILINK_RE = new RegExp(`^${LINK_SOURCE}`);
const EMBED_RE = new RegExp(`^!${LINK_SOURCE}`);
// Pandoc's rule, so prices like "$5 and $6" stay plain text.
const MATH_SOURCE = '\\$(?!\\s)([^$\\n]*[^\\s$])\\$';
const MATH_RE = new RegExp(`^${MATH_SOURCE}(?!\\d)`);
const MATH_BLOCK_RE = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/;

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

/** Inline atom shown as a chip. Stores attributes, so the Markdown source survives. */
function chipNode({ name, attributes, tokenRe, start, toAttrs, toSource, label, inputRe }) {
    return Node.create({
        name,
        group: 'inline',
        inline: true,
        atom: true,
        selectable: true,

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
    attributes: { latex: dataAttr('latex') },
    tokenRe: MATH_RE,
    start: (src) => src.indexOf('$'),
    toAttrs: (match) => ({ latex: match[1] }),
    toSource: ({ latex }) => `$${latex}$`,
    label: ({ latex }) => latex,
    inputRe: new RegExp(`(?<=^|\\s)${MATH_SOURCE}$`),
});

/** Block math stays editable as source until Phase 3 renders it. */
export const MathBlock = Node.create({
    name: 'mathBlock',
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,

    parseHTML: () => [{ tag: 'pre[data-node="mathBlock"]', preserveWhitespace: 'full' }],

    renderHTML: () => ['pre', { 'data-node': 'mathBlock', class: 'note-math-block' }, ['code', 0]],

    markdownTokenName: 'mathBlock',
    markdownTokenizer: {
        name: 'mathBlock',
        level: 'block',
        start: (src) => src.search(/^\$\$/m),
        tokenize(src) {
            const match = MATH_BLOCK_RE.exec(src);
            if (match) return { type: 'mathBlock', raw: match[0], latex: match[1].trim() };
        },
    },
    parseMarkdown: (token, helpers) => helpers.createNode(
        'mathBlock', {}, token.latex ? [helpers.createTextNode(token.latex)] : []
    ),
    renderMarkdown: (node) => `$$\n${(node.content || []).map((child) => child.text).join('')}\n$$`,

    addInputRules() {
        return [textblockTypeInputRule({ find: /^\$\$\s$/, type: this.type })];
    },
});
