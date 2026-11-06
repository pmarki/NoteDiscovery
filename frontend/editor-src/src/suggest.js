import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';

const MAX_QUERY = 100;

const isEmbed = (state, range) => range.from > 1 && state.doc.textBetween(range.from - 1, range.from) === '!';

function allow({ state, range }) {
    const query = state.doc.textBetween(range.from + 2, range.to);
    if (query.length > MAX_QUERY || /[[\]|]/.test(query)) return false;
    if (state.doc.resolve(range.from).parent.type.spec.code) return false;
    return !state.doc.rangeHasMark(range.from, range.to, state.schema.marks.code);
}

function insertLink({ editor, range, props }) {
    const embed = isEmbed(editor.state, range);
    editor.chain().focus().insertContentAt(
        { from: embed ? range.from - 1 : range.from, to: range.to },
        { type: embed ? 'embed' : 'wikilink', attrs: { target: props.target, alias: null } }
    ).run();
}

/**
 * Report an unfinished [[ or ![[ to the app, which owns the results and the popup.
 * `onChange` receives { query, isMedia, clientRect }, or null when the token ends.
 */
export function wikilinkSuggestion({ onChange, onKeyDown }) {
    let active = null;

    const report = (props) => {
        active = props;
        onChange({
            query: props.query,
            isMedia: isEmbed(props.editor.state, props.range),
            clientRect: props.clientRect,
        });
    };

    const extension = Extension.create({
        name: 'wikilinkSuggestion',
        addProseMirrorPlugins() {
            return [Suggestion({
                editor: this.editor,
                char: '[[',
                allowSpaces: true,
                allowedPrefixes: null,
                allow,
                command: insertLink,
                render: () => ({
                    onStart: report,
                    onUpdate: report,
                    onExit: () => {
                        active = null;
                        onChange(null);
                    },
                    onKeyDown: ({ event }) => onKeyDown(event),
                }),
            })];
        },
    });

    return { extension, accept: (target) => active?.command({ target }) };
}

// Tables hold one line per cell in Markdown, so block commands have no place there.
function allowSlash({ state, range }) {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== 'paragraph' || range.from !== $from.start()) return false;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type.spec.tableRole) return false;
    }
    return true;
}

/**
 * Report a / at the start of a paragraph to the app, which owns the commands and the popup.
 * `onChange` receives { query, isSlash, clientRect }, or null when the token ends.
 */
export function slashSuggestion({ onChange, onKeyDown }) {
    let active = null;

    const report = (props) => {
        active = props;
        onChange({ query: props.query, isSlash: true, clientRect: props.clientRect });
    };

    const extension = Extension.create({
        name: 'slashSuggestion',
        addProseMirrorPlugins() {
            return [Suggestion({
                editor: this.editor,
                pluginKey: new PluginKey('slashSuggestion'),
                char: '/',
                startOfLine: true,
                allow: allowSlash,
                command: ({ editor, range }) => editor.chain().focus().deleteRange(range).run(),
                render: () => ({
                    onStart: report,
                    onUpdate: report,
                    onExit: () => {
                        active = null;
                        onChange(null);
                    },
                    onKeyDown: ({ event }) => onKeyDown(event),
                }),
            })];
        },
    });

    // Removes what was typed. The app then runs the command it picked.
    return { extension, accept: () => active?.command({}) };
}
