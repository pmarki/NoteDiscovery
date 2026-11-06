// Markdown behaviour of the note editor, run headless: npm test
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>');
const { window } = dom;
for (const key of ['document', 'Node', 'Element', 'HTMLElement', 'DOMParser', 'MutationObserver',
    'getComputedStyle', 'Text', 'Range', 'DocumentFragment', 'Event', 'CustomEvent']) {
    globalThis[key] = window[key];
}
globalThis.window = window;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({});
document.elementFromPoint = () => null;
window.Element.prototype.scrollIntoView = () => {};

const { create } = await import('../src/index.js');
const { escapeMarkdownText } = await import('../src/markdown.js');

const changes = [];
let suggestion = null;
const editor = create({
    element: document.getElementById('root'),
    debounceMs: 0,
    onChange: (value) => changes.push(value),
    onSuggest: (value) => { suggestion = value; },
});
const roundTrip = (markdown) => {
    editor.setMarkdown(markdown, { resetHistory: true });
    return editor.getMarkdown();
};

const results = [];
const test = (name, run) => {
    try {
        run();
        results.push(`ok    ${name}`);
    } catch (error) {
        results.push(`FAIL  ${name}\n      ${error.message.split('\n').slice(0, 6).join('\n      ')}`);
        process.exitCode = 1;
    }
};

// Each of these must come back byte for byte.
const EXACT = {
    frontmatter: '---\ntags: [a, b]\ntitle: X\n---\n\n# Hi\n',
    'frontmatter only': '---\ntitle: X\n---\n',
    wikilink: 'See [[Some Note|alias]] and [[Other]].\n',
    embed: '![[photo.png]]\n\n![[doc.pdf|My doc]]\n',
    tags: 'Text #tag and #other/nested here\n',
    'inline math': 'Inline $a_1 * b_2$ and more\n',
    'block math': '$$\nx_1^2 * y\n$$\n',
    'price is not math': 'It costs $5 and $6 today\n',
    'mermaid fence': '```mermaid\ngraph TD; A-->B\n```\n',
    'mermaid with backticks': '````mermaid\ngraph TD; A["```"]\n````\n',
    callout: '> [!TIP] Be careful\n> First *para*\n>\n> Second\n',
    'callout with code': '> [!WARNING]\n> ```js\n> a()\n> ```\n',
    'sized image': '![photo|100x200](a.png)\n',
    'sized embed': '![[photo.png|100]]\n',
    'embed by path': '![[my note.attachments/a b.png]]\n\n![[../x/y.png|100]]\n',
    'code fence': '```python\nprint("a_b")\n\nx = 1 * 2\n```\n',
    tasks: '- [ ] a\n- [x] b\n  - [ ] nested\n',
    'ordered list': '3. three\n4. four\n',
    'plain underscores': 'snake_case and a_b_c stay readable\n',
    'plain star': 'Multiply 1 * 2 here\n',
    'plain brackets': 'An [aside] without a link\n',
    'bold and italic': '**bold** *it* ~~gone~~ `code`\n',
    link: '[text](https://example.com) and [note](folder/My%20Note.md)\n',
    image: '![alt](folder/a.png)\n',
    'hard break': 'line one  \nline two\n',
    quote: '> quoted\n',
    heading: '## Title\n\nBody\n',
    rule: 'a\n\n---\n\nb\n',
    'tab inside a line': 'a\tb\n',
    'tab starting a paragraph': '&#9;indented\n',
    'tab in code': '```\n\tx\n```\n',
    empty: '',
};
for (const [name, markdown] of Object.entries(EXACT)) {
    test(`exact: ${name}`, () => assert.equal(roundTrip(markdown), markdown));
}

// Text must survive as text, even if the file spells it differently.
const STABLE = [
    '| a | b |\n|:--|--:|\n| 1 | 2 |\n\nafter\n',
    'a *b* _c_ __d__ `e` \\*not em\\* \\_not em\\_ \\`tick\\`\n',
    '[not](a link) \\[x\\](y) \\[\\[z\\]\\]\n',
    'tilde \\~\\~x\\~\\~ and back\\\\slash\n',
    '- a\n\n  second para\n- b\n\n1. c\n   - d\n',
    '> - a\n>\n> b\n',
    '---\na: 1\n---\n\n| x |\n|---|\n| [[y\\|z]] |\n',
];
STABLE.forEach((markdown, i) => {
    test(`stable after one normalisation: case ${i + 1}`, () => {
        const once = roundTrip(markdown);
        assert.equal(roundTrip(once), once);
        assert.equal(roundTrip(roundTrip(once)), once);
    });
});

test('escapes what would change meaning', () => {
    assert.equal(escapeMarkdownText('*x*'), '\\*x\\*');
    assert.equal(escapeMarkdownText('_x_'), '\\_x\\_');
    assert.equal(escapeMarkdownText('[[x]]'), '\\[\\[x]]');
    assert.equal(escapeMarkdownText('[x](y)'), '[x\\](y)');
    assert.equal(escapeMarkdownText('~~x~~'), '\\~\\~x\\~\\~');
    assert.equal(roundTrip('\\*x\\* \\[\\[y]]\n'), '\\*x\\* \\[\\[y]]\n');
});

test('tiptap still routes text through the escape override', () => {
    assert.equal(roundTrip('a_b\n'), 'a_b\n');
});

test('loading a note reports no change', async () => {
    changes.length = 0;
    roundTrip('# Hi\n\n* one\n');
    assert.equal(changes.length, 0);
});

test('undo cannot cross a reset into the previous note', () => {
    editor.setMarkdown('first\n', { resetHistory: true });
    editor.insertMarkdown(' more');
    editor.setMarkdown('second\n', { resetHistory: true });
    editor.undo();
    assert.equal(editor.getMarkdown(), 'second\n');
});

test('undo works within a note', () => {
    editor.setMarkdown('first\n', { resetHistory: true });
    editor.insertMarkdown('added');
    assert.notEqual(editor.getMarkdown(), 'first\n');
    editor.undo();
    assert.equal(editor.getMarkdown(), 'first\n');
});

test('unsafe link is dropped', () => {
    assert.ok(!document.querySelector('#root a[href^="javascript"]'));
    roundTrip('[x](javascript:alert(1))\n');
    assert.ok(!document.querySelector('#root a[href^="javascript"]'));
});

test('chips render note text as text, never markup', () => {
    roundTrip('[[<img src=x onerror=alert(1)>]]\n');
    // ProseMirror adds its own img.ProseMirror-separator. Compare counts: printing a failed
    // assert on a live editor node walks the whole view and can exhaust memory.
    assert.equal(document.querySelectorAll('#root img:not(.ProseMirror-separator)').length, 0);
    assert.ok(document.querySelector('#root .note-chip').textContent.includes('<img'));
});

test('[[ reports a note query and accepting it makes a wikilink', () => {
    editor.setMarkdown('', { resetHistory: true });
    editor.insertMarkdown('See [[So');
    assert.equal(suggestion?.query, 'So');
    assert.equal(suggestion?.isMedia, false);
    editor.acceptSuggestion('Some Note');
    assert.equal(editor.getMarkdown(), 'See [[Some Note]]\n');
    assert.equal(suggestion, null);
});

test('every sample loads as a valid document', () => {
    for (const markdown of [...Object.values(EXACT), '![a](b.png)\n\ntext\n', '- ![a](b.png)\n', '> ![a](b.png)\n']) {
        editor.setMarkdown(markdown, { resetHistory: true });
        assert.equal(editor.isValid(), true, markdown);
    }
});

test('other math delimiters load as math and save as dollars', () => {
    assert.equal(roundTrip('Inline \\(a_1\\) here\n'), 'Inline $a_1$ here\n');
    assert.equal(roundTrip('\\[\nx_1\n\\]\n'), '$$\nx_1\n$$\n');
});

test('a tilde mermaid fence is a diagram', () => {
    assert.equal(roundTrip('~~~mermaid\ngraph TD\n~~~\n'), '```mermaid\ngraph TD\n```\n');
});

test('selected source can be replaced, undone and deleted', () => {
    editor.setMarkdown('$$\na\n$$\n\ntext\n', { resetHistory: true });
    editor.selectNodeAt(0);
    assert.equal(editor.itemAtSelection().kind, 'mathBlock');
    assert.equal(editor.itemAtSelection().attrs.source, 'a');
    assert.equal(editor.updateSelectedNode({ source: 'b' }), true);
    assert.equal(editor.getMarkdown(), '$$\nb\n$$\n\ntext\n');
    assert.equal(editor.itemAtSelection().kind, 'mathBlock');
    editor.undo();
    assert.equal(editor.getMarkdown(), '$$\na\n$$\n\ntext\n');
    editor.selectNodeAt(0);
    editor.deleteSelectedNode();
    assert.equal(editor.getMarkdown(), 'text\n');
});

test('read-only mode keeps the note and reports no item', () => {
    editor.setMarkdown('[[A]]\n', { resetHistory: true });
    editor.setEditable(false);
    assert.equal(editor.itemAtSelection(), null);
    assert.equal(editor.getMarkdown(), '[[A]]\n');
    editor.setEditable(true);
});

test('search counts matches and moves between them without touching the Markdown', () => {
    editor.setMarkdown('one two one\n\none\n', { resetHistory: true });
    const find = (text) => [...text.matchAll(/one/g)].map((match) => [match.index, match.index + 3]);
    assert.equal(editor.highlight(find), 3);
    editor.gotoMatch(2);
    assert.equal(document.querySelectorAll('.search-highlight').length, 3);
    assert.equal(document.querySelectorAll('.active-match').length, 1);
    assert.equal(editor.getMarkdown(), 'one two one\n\none\n');
    assert.equal(editor.highlight(null), 0);
});

test('![[ reports a media query and accepting it makes an embed', () => {
    editor.setMarkdown('', { resetHistory: true });
    editor.insertMarkdown('![[ph');
    assert.equal(suggestion?.isMedia, true);
    editor.acceptSuggestion('photo.png');
    assert.equal(editor.getMarkdown(), '![[photo.png]]\n');
});

test('no suggestions inside code', () => {
    editor.setMarkdown('```\nx\n```\n', { resetHistory: true });
    editor.insertMarkdown('[[So');
    assert.equal(suggestion, null);
});

test('search highlights never reach the Markdown', () => {
    editor.setMarkdown('find me and find you\n', { resetHistory: true });
    editor.highlight((text) => [...text.matchAll(/find/g)].map((m) => [m.index, m.index + 4]));
    assert.equal(document.querySelectorAll('#root .search-highlight').length, 2);
    assert.equal(editor.getMarkdown(), 'find me and find you\n');
    editor.highlight(null);
    assert.equal(document.querySelectorAll('#root .search-highlight').length, 0);
});

// Types /x in the empty paragraph at the cursor and picks a command, as the popup does.
const slash = (type) => {
    editor.insertMarkdown('/x');
    const opened = suggestion?.isSlash === true;
    editor.acceptSlash();
    editor.format(type);
    return opened;
};

test('/ opens at the start of a line or after a space, and says when only inline commands fit', () => {
    const state = (markdown, typed = '/') => {
        editor.setMarkdown(markdown, { resetHistory: true });
        editor.insertMarkdown(typed);
        const result = suggestion?.isSlash === true ? (suggestion.inline ? 'inline' : 'block') : 'closed';
        editor.setMarkdown('', { resetHistory: true });
        return result;
    };
    assert.equal(state(''), 'block');
    assert.equal(state('', 'a/'), 'closed');
    assert.equal(state('', 'and /'), 'inline');
    assert.equal(state('```\nx\n```\n'), 'closed');
    assert.equal(state('', '[[a /'), 'closed');
});

test('every / command leaves a valid document that survives a reload', () => {
    const types = ['heading1', 'bullet', 'numbered', 'checkbox', 'quote', 'codeblock', 'table',
        'divider', 'callout', 'formula', 'diagram'];
    const failures = [];
    for (const place of [null, 'bullet', 'checkbox', 'quote', 'callout']) {
        for (const type of types) {
            editor.setMarkdown('', { resetHistory: true });
            if (place) slash(place);
            if (!slash(type)) failures.push(`${place}/${type}: no menu`);
            if (!editor.isValid()) failures.push(`${place}/${type}: invalid`);
            // An empty block can take two reloads to vanish, so stability starts after them.
            const saved = roundTrip(roundTrip(editor.getMarkdown()));
            if (roundTrip(saved) !== saved) failures.push(`${place}/${type}: ${JSON.stringify(saved)}`);
        }
    }
    assert.equal(failures.join('; '), '');
});

test('/ can start a wikilink', () => {
    editor.setMarkdown('', { resetHistory: true });
    slash('noteLink');
    assert.equal(suggestion?.isSlash, undefined);
    assert.equal(suggestion?.query, '');
});

test('a new formula or diagram is selected, ready for its source', () => {
    editor.setMarkdown('', { resetHistory: true });
    slash('formula');
    assert.equal(editor.itemAtSelection()?.kind, 'mathBlock');
    editor.updateSelectedNode({ source: 'x^2' });
    assert.equal(editor.getMarkdown(), '$$\nx^2\n$$\n');
    editor.setMarkdown('', { resetHistory: true });
    slash('diagram');
    assert.equal(editor.itemAtSelection()?.kind, 'mermaidBlock');
});

test('the selection report covers text only', () => {
    editor.setMarkdown('some **bold** text\n\n```\ncode\n```\n', { resetHistory: true });
    editor.focus();
    assert.equal(editor.textSelection(), null);
});

console.log(results.join('\n'));
process.exit(process.exitCode || 0);
