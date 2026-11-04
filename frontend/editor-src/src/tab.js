import { Extension } from '@tiptap/core';

const LIST_ITEMS = ['listItem', 'taskItem'];

/**
 * Runs after the list and table keymaps and takes whatever they leave. Tab must not
 * fall through, or the browser moves focus out of the editor to the address bar.
 * Shift+Tab may, outside code, so keyboard users still have a way out.
 */
export const TabKey = Extension.create({
    name: 'tabKey',
    priority: 50,

    addKeyboardShortcuts() {
        return {
            Tab: () => {
                // A list item that can't indent any further just stays where it is.
                if (LIST_ITEMS.some((name) => this.editor.isActive(name))) return true;
                return this.editor.commands.command(({ tr }) => {
                    tr.insertText('\t').scrollIntoView();
                    return true;
                });
            },
            'Shift-Tab': () => {
                const { $from } = this.editor.state.selection;
                if (!$from.parent.type.spec.code) return false;

                const lineStart = $from.parent.textContent.lastIndexOf('\n', $from.parentOffset - 1) + 1;
                if ($from.parent.textContent[lineStart] !== '\t') return true;
                return this.editor.commands.command(({ tr }) => {
                    tr.delete($from.start() + lineStart, $from.start() + lineStart + 1);
                    return true;
                });
            },
        };
    },
});
