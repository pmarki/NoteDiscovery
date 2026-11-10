import Link from '@tiptap/extension-link';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { escapeMarkdownText } from './markdown.js';

const WEB_URL_RE = /^https?:\/\/[^\s<>]+$/i;
// GFM leaves these off the end of a bare address, so such an address keeps the [text](url) form.
const TRAILING_RE = /[.,:;!?'"*_~)\]]$/;
// Text spelling an entity is written escaped, so it wouldn't read back as the same address.
const ENTITY_RE = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i;

/** Writes a link showing its own address as the bare address, the way it was most likely typed. */
export const NoteLink = Link.extend({
    renderMarkdown(node, helpers, context) {
        const { href, title } = node.attrs || {};
        const bare = !title && href && context?.meta?.markText === href && WEB_URL_RE.test(href)
            && !TRAILING_RE.test(href) && !ENTITY_RE.test(href) && escapeMarkdownText(href) === href;
        return bare ? helpers.renderChildren(node) : this.parent(node, helpers, context);
    },
});

/** The address of a paragraph that holds nothing but a web address, or null. */
export function cardAddress(node) {
    if (node.type.name !== 'paragraph' || node.childCount !== 1) return null;
    const { firstChild: child } = node;
    const [mark] = child.marks;
    if (!child.isText || child.marks.length !== 1 || mark.type.name !== 'link') return null;
    const { href } = mark.attrs;
    return href === child.text && WEB_URL_RE.test(href) ? href : null;
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
            dom.addEventListener('click', (event) => {
                if (event.target.closest('button')) return;
                event.preventDefault();
                if (!view.editable || event.ctrlKey || event.metaKey) {
                    onOpen(event);
                    return;
                }
                // To the end of the address above, which brings up its popup
                const pos = getPos();
                if (pos === undefined) return;
                view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos - 1)));
                view.focus();
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
