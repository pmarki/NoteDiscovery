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

const { create } = await import('../src/index.js');
const { escapeMarkdownText } = await import('../src/markdown.js');

const changes = [];
const editor = create({
    element: document.getElementById('root'),
    debounceMs: 0,
    onChange: (value) => changes.push(value),
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

console.log(results.join('\n'));
process.exit(process.exitCode || 0);
