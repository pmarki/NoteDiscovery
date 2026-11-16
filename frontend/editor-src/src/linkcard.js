import Link from '@tiptap/extension-link';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { escapeMarkdownText } from './markdown.js';

const WEB_URL_RE = /^https?:\/\/[^\s<>]+$/i;
const WWW_RE = /^www\.[^\s<>]+$/i;
// GFM leaves these off the end of a bare address, so such an address keeps the [text](url) form.
const TRAILING_RE = /[.,:;!?'"*_~)\]]$/;
// Text spelling an entity is written escaped, so it wouldn't read back as the same address.
const ENTITY_RE = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i;

/** The address text stands for written bare: itself, or after http:// for www. (as GFM reads it). */
function bareAddress(text) {
    if (WEB_URL_RE.test(text)) return text;
    return WWW_RE.test(text) ? `http://${text}` : null;
}

/** Whether a link with this text and address can be written as just its text. */
export function isBareLink(text, href) {
    return !!href && bareAddress(text) === href;
}

/** Writes a link showing its own address as the bare address, the way it was most likely typed. */
export const NoteLink = Link.extend({
    renderMarkdown(node, helpers, context) {
        const { href, title } = node.attrs || {};
        const text = context?.meta?.markText ?? '';
        const bare = !title && isBareLink(text, href)
            && !TRAILING_RE.test(text) && !ENTITY_RE.test(text) && escapeMarkdownText(text) === text;
        return bare ? helpers.renderChildren(node) : this.parent(node, helpers, context);
    },

    addProseMirrorPlugins() {
        return [...(this.parent?.() || []), followText(this.type)];
    },
});

/**
 * Typing in a bare address changes where it points as well, so it stays bare (and
 * keeps its card). Only for the paragraph being typed in, and only while the text
 * still is a web address or a www. one.
 */
function followText(type) {
    return new Plugin({
        key: new PluginKey('linkFollowsText'),
        appendTransaction(transactions, oldState, state) {
            if (!transactions.some((tr) => tr.docChanged)) return null;
            const bare = new Set();
            oldState.selection.$from.parent.forEach((child) => {
                const mark = type.isInSet(child.marks);
                if (mark && isBareLink(child.text, mark.attrs.href)) bare.add(mark.attrs.href);
            });
            if (!bare.size) return null;
            const { $from } = state.selection;
            const start = $from.start();
            let tr = null;
            $from.parent.forEach((child, offset) => {
                const mark = type.isInSet(child.marks);
                if (!mark || !bare.has(mark.attrs.href) || isBareLink(child.text, mark.attrs.href)) return;
                const href = bareAddress(child.text);
                if (!href) return;
                const from = start + offset;
                const to = from + child.nodeSize;
                tr = (tr || state.tr).removeMark(from, to, mark).addMark(from, to, type.create({ ...mark.attrs, href }));
            });
            return tr;
        },
    });
}

/** The address of a paragraph that holds nothing but a web address, or null. */
export function cardAddress(node) {
    if (node.type.name !== 'paragraph' || node.childCount !== 1) return null;
    const { firstChild: child } = node;
    const [mark] = child.marks;
    if (!child.isText || child.marks.length !== 1 || mark.type.name !== 'link') return null;
    const { href } = mark.attrs;
    return isBareLink(child.text, href) ? href : null;
}

function findCards(doc, draw) {
    const decorations = [];
    doc.descendants((node, pos) => {
        if (node.type.spec.tableRole === 'table') return false; // A card doesn't fit in a cell
        const href = cardAddress(node);
        if (!href) return true;
        const end = pos + node.nodeSize;
        decorations.push(
            Decoration.node(pos, end, { class: 'link-card-source' }),
            Decoration.widget(end, (view, getPos) => draw(view, getPos, href), {
                key: `link-card:${href}`,
                side: -1,
                ignoreSelection: true,
                stopEvent: () => true,
                destroy: (dom) => dom.linkCardView?.destroy(),
            }),
        );
        return false;
    });
    return DecorationSet.create(doc, decorations);
}

/**
 * A card under every paragraph that is only a web address. The Markdown keeps the
 * bare address; the app draws the card with `draw('linkCard', element, { href })`.
 */
export const LinkCards = Extension.create({
    name: 'linkCards',
    addOptions: () => ({ enabled: false, draw: null, views: null, onOpen: () => {} }),

    addProseMirrorPlugins() {
        const { enabled, draw, views, onOpen } = this.options;
        if (!enabled || !draw) return [];
        const drawCard = (view, getPos, href) => {
            const dom = document.createElement('a');
            dom.className = 'link-card';
            dom.href = href;
            dom.contentEditable = 'false';
            dom.dataset.node = 'linkCard';
            const card = { name: 'linkCard', redraw: () => draw('linkCard', dom, { href }) };
            views?.add(card);
            dom.linkCardView = { destroy: () => views?.delete(card) };
            // Puts the cursor at the end of the address above, for its buttons
            dom.selectAddress = () => {
                const pos = getPos();
                if (pos === undefined) return;
                view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos - 1)));
                view.focus();
            };
            // Deletes the address above, as typing would: one undoable step
            dom.removeAddress = () => {
                const pos = getPos();
                if (pos === undefined || !view.editable) return;
                const { doc } = view.state;
                const paragraph = doc.resolve(pos).nodeBefore;
                if (!paragraph) return;
                let from = pos - paragraph.nodeSize;
                let to = pos;
                // A list item or quote holding only the address goes with it
                let $from = doc.resolve(from);
                while ($from.depth > 0 && $from.parent.childCount === 1) {
                    from = $from.before();
                    to = $from.after();
                    $from = doc.resolve(from);
                }
                const tr = view.state.tr;
                // The note keeps an empty line
                if (doc.childCount === 1 && $from.depth === 0) tr.replaceWith(from, to, doc.type.schema.nodes.paragraph.create());
                else tr.delete(from, to);
                view.dispatch(tr.scrollIntoView());
                view.focus();
            };
            // The card is a link, so a press would take the focus off the editor
            dom.addEventListener('mousedown', (event) => {
                if (!event.target.closest('button')) event.preventDefault();
            });
            dom.addEventListener('click', (event) => {
                if (event.target.closest('button')) return;
                event.preventDefault();
                // The editor would open it as a link too
                event.stopPropagation();
                if (!view.editable || event.ctrlKey || event.metaKey) {
                    onOpen(event);
                    return;
                }
                dom.selectAddress();
            });
            card.redraw();
            return dom;
        };
        const key = new PluginKey('linkCards');
        return [new Plugin({
            key,
            state: {
                init: (_, state) => findCards(state.doc, drawCard),
                apply: (tr, cards) => (tr.docChanged ? findCards(tr.doc, drawCard) : cards),
            },
            props: { decorations: (state) => key.getState(state) },
        })];
    },
});
