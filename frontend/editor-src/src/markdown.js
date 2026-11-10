import { MarkdownManager } from '@tiptap/markdown';

const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Split a note into its YAML frontmatter (without the fences) and its body. */
export function splitFrontmatter(markdown) {
    const match = FRONTMATTER_RE.exec(markdown);
    if (!match) return { yaml: '', body: markdown };
    return { yaml: match[1] || '', body: markdown.slice(match[0].length).replace(/^(\r?\n)+/, '') };
}

/** Inverse of splitFrontmatter. Bodies always end in exactly one newline. */
export function joinFrontmatter(yaml, body) {
    const text = body.replace(/^\n+/, '').trimEnd();
    const tail = text ? `${text}\n` : '';
    if (!yaml.trim()) return tail;
    return `---\n${yaml.trimEnd()}\n---\n${tail ? `\n${tail}` : ''}`;
}

/**
 * Escape only what would change meaning when parsed again. Tiptap's default escapes
 * every occurrence, which writes `snake\_case` and `\[x\]` into the note, where
 * search and MCP clients read them literally.
 */
export function escapeMarkdownText(text) {
    return text
        // Tiptap writes every & as &amp;, but only one that starts an entity needs it ("a&b", "?x=1&y=2").
        .replace(/&amp;(?!#\d+;|#x[\da-f]+;|[a-z][a-z\d]*;)/gi, '&')
        .replace(/[\\`]/g, '\\$&')
        .replace(/~~/g, '\\~\\~')
        // Spaced out ("1 * 2") a star can't open or close emphasis.
        .replace(/\*/g, (star, i, s) => (/\s|^$/.test(s[i - 1] ?? '') && /\s|^$/.test(s[i + 1] ?? '') ? star : '\\*'))
        // Inside a word ("snake_case") an underscore can't either.
        .replace(/_/g, (bar, i, s) => (/[\p{L}\p{N}]/u.test(s[i - 1] ?? '') && /[\p{L}\p{N}]/u.test(s[i + 1] ?? '') ? bar : '\\_'))
        // Brackets only matter as [[wikilink]], [text](url) or [text][ref].
        .replace(/\[\[/g, '\\[\\[')
        .replace(/\](?=[([])/g, '\\]')
        // A paragraph starting with a real tab would reload as a code block.
        .replace(/^\t/, '&#9;');
}

// Private in Tiptap, so test/markdown.test.mjs fails if an upgrade renames it.
MarkdownManager.prototype.escapeMarkdownSyntax = escapeMarkdownText;
