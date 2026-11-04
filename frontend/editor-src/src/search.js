import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const key = new PluginKey('searchHighlight');

/** Keeps search matches marked as decorations, so they never reach the saved Markdown. */
export const SearchHighlight = Extension.create({
    name: 'searchHighlight',
    addProseMirrorPlugins: () => [new Plugin({
        key,
        state: {
            init: () => DecorationSet.empty,
            apply: (tr, set) => tr.getMeta(key) ?? set.map(tr.mapping, tr.doc),
        },
        props: {
            decorations: (state) => key.getState(state),
        },
    })],
});

/**
 * Mark what `findSpans(text)` returns as [from, to] pairs, or clear with null.
 * Text is searched one node at a time, so a match across a formatting change is missed.
 * Returns the first match's position, or null.
 */
export function highlightMatches(view, findSpans) {
    const { doc, tr } = view.state;
    const decorations = [];
    if (findSpans) {
        doc.descendants((node, pos) => {
            if (!node.isText) return;
            for (const [from, to] of findSpans(node.text)) {
                decorations.push(Decoration.inline(pos + from, pos + to, { class: 'search-highlight' }));
            }
        });
    }
    // Read before create(), which empties the array as it builds the set.
    const first = decorations[0]?.from ?? null;
    view.dispatch(tr.setMeta(key, DecorationSet.create(doc, decorations)));
    return first;
}
