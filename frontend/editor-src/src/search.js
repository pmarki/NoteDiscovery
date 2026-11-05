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
 * Mark what `findSpans(text)` returns as [from, to] pairs, or clear with null. The match
 * at `active` stands out. Text is searched one node at a time, so a match across a
 * formatting change is missed. Returns each match's start position.
 */
export function highlightMatches(view, findSpans, active = 0) {
    const { doc, tr } = view.state;
    const decorations = [];
    if (findSpans) {
        doc.descendants((node, pos) => {
            if (!node.isText) return;
            for (const [from, to] of findSpans(node.text)) {
                const className = decorations.length === active ? 'search-highlight active-match' : 'search-highlight';
                decorations.push(Decoration.inline(pos + from, pos + to, { class: className }));
            }
        });
    }
    // Read before create(), which empties the array as it builds the set.
    const positions = decorations.map(({ from }) => from);
    view.dispatch(tr.setMeta(key, DecorationSet.create(doc, decorations)));
    return positions;
}
