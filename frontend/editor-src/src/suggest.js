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

// `props.embed` picks the node when the app knows better than the typed !, as after Attach
function insertLink({ editor, range, props }) {
    const typedEmbed = isEmbed(editor.state, range);
    const embed = props.embed ?? typedEmbed;
    editor.chain().focus().insertContentAt(
        { from: typedEmbed ? range.from - 1 : range.from, to: range.to },
        { type: embed ? 'embed' : 'wikilink', attrs: { target: props.target, alias: null } }
    ).run();
}

/**
 * Report an unfinished [[ or ![[ to the app, which owns the results and the popup.
 * `onChange` receives { query, isMedia, isAttach, clientRect }, or null when the token ends.
 * `isAttach` means the [[ came from the Attach command, so notes and files both apply.
 */
export function wikilinkSuggestion({ onChange, onKeyDown }) {
    let active = null;
    let attachAt = null;

    const report = (props) => {
        active = props;
        onChange({
            query: props.query,
            isMedia: isEmbed(props.editor.state, props.range),
            isAttach: props.range.from === attachAt,
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
                        attachAt = null;
                        onChange(null);
                    },
                    onKeyDown: ({ event }) => onKeyDown(event),
                }),
            })];
        },
    });

    return {
        extension,
        accept: (target, embed) => active?.command({ target, embed }),
        // Types the [[ for the Attach command
        attach(editor) {
            attachAt = editor.state.selection.from;
            editor.chain().focus().insertContent('[[').run();
        },
    };
}

// Tables hold one line per cell in Markdown, so block commands have no place there.
export function acceptsBlock($pos) {
    if ($pos.parent.type.name !== 'paragraph' || $pos.pos !== $pos.start()) return false;
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
        if ($pos.node(depth).type.spec.tableRole) return false;
    }
    return true;
}

function allowSlash({ state, range }) {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.spec.code) return false;
    // A / typed inside an unfinished [[ belongs to that link
    const before = $from.parent.textBetween(0, $from.parentOffset, '', ' ');
    if (before.lastIndexOf('[[') > before.lastIndexOf(']]')) return false;
    return !state.doc.rangeHasMark(range.from, range.to, state.schema.marks.code);
}

/**
 * Report a / after a space or at the start of a line to the app, which owns the commands and the popup.
 * `onChange` receives { query, isSlash, inline, clientRect }, or null when the token ends.
 * `inline` means a block can't go there, so only inline commands apply.
 */
export function slashSuggestion({ onChange, onKeyDown }) {
    let active = null;

    const report = (props) => {
        active = props;
        onChange({
            query: props.query,
            isSlash: true,
            inline: !acceptsBlock(props.editor.state.doc.resolve(props.range.from)),
            clientRect: props.clientRect,
        });
    };

    const extension = Extension.create({
        name: 'slashSuggestion',
        addProseMirrorPlugins() {
            return [Suggestion({
                editor: this.editor,
                pluginKey: new PluginKey('slashSuggestion'),
                char: '/',
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
