// Keep It Frontend Application

// The live Tiptap editor. Kept out of noteApp()'s data: Alpine's reactive proxies break ProseMirror.
let noteEditor = null;

// MathJax can't typeset two things at once, so formulas wait their turn here.
let mathQueue = Promise.resolve();
// Link previews by address, each fetched once per page load (see _linkPreview)
const linkPreviewRequests = new Map();
// Addresses whose offline copy is still being made, with a check already scheduled
const linkArchivePolls = new Set();
// How often a card asks again while ArchiveBox works on its copy
const LINK_ARCHIVE_POLL_MS = 20000;
// A new address waits this long before its preview is asked for, so typing one
// doesn't fetch (and archive) every partial address on the way
const LINK_PREVIEW_DELAY_MS = 800;

// Parses an Obsidian-style inline image size spec from an alt-like string.
// Returns { alt, width, height } — width/height are null when not specified.
//
//   parseImageSizeSpec("caption")            -> {alt:"caption",  w:null, h:null}
//   parseImageSizeSpec("caption|100")        -> {alt:"caption",  w:100,  h:null}
//   parseImageSizeSpec("caption|100x200")    -> {alt:"caption",  w:100,  h:200}
//   parseImageSizeSpec("100", {allowSolo})   -> {alt:"",         w:100,  h:null}   (wikilink only)
//   parseImageSizeSpec("100x200",{allowSolo})-> {alt:"",         w:100,  h:200}    (wikilink only)
//
// A dimension of 0 is treated as "unset" (Obsidian convention: |0x200 = height only).
// allowSolo=true accepts a bare `<digits>` string as a size; used for wikilinks
// where `![[img|100]]` unambiguously means "size 100" (no alt to confuse). For
// standard markdown `![100](x)` we default allowSolo=false so "100" stays as alt.
function parseImageSizeSpec(text, opts = {}) {
    const allowSolo = opts.allowSolo === true;
    if (!text) return { alt: '', width: null, height: null };
    const trimmed = text.trim();
    if (allowSolo) {
        const solo = trimmed.match(/^(\d+)(?:[xX](\d+))?$/);
        if (solo) {
            const w = parseInt(solo[1], 10);
            const h = solo[2] !== undefined ? parseInt(solo[2], 10) : null;
            return {
                alt: '',
                width: w > 0 ? w : null,
                height: (h !== null && h > 0) ? h : null,
            };
        }
    }
    const idx = trimmed.lastIndexOf('|');
    if (idx === -1) return { alt: trimmed, width: null, height: null };
    const size = trimmed.slice(idx + 1).trim();
    const m = size.match(/^(\d+)(?:[xX](\d+))?$/);
    if (!m) return { alt: trimmed, width: null, height: null };
    const w = parseInt(m[1], 10);
    const h = m[2] !== undefined ? parseInt(m[2], 10) : null;
    return {
        alt: trimmed.slice(0, idx).trim(),
        width: w > 0 ? w : null,
        height: (h !== null && h > 0) ? h : null,
    };
}

// Configuration constants
const CONFIG = {
    AUTOSAVE_DELAY: 1000,              // ms - Fallback only; runtime value lives on this.autosaveDelayMs (hydrated from /api/config). Used by autoSave() and _drawingScheduleAutosave().
    DEFAULT_THEME: 'light',            // Fallback only; runtime value lives on this.defaultTheme (hydrated from /api/config). Used by initTheme() when localStorage has no saved preference.
    UPLOAD_MAX_NOTE_MB: 10,            // MB - Fallback only; runtime value lives on this.uploadMaxNoteMb (hydrated from /api/config). Used by importMarkdownFile() to cap drag-drop .md imports.
    /** Must match drawingRedraw() fill and eraser stroke color (opaque “whiteboard”). */
    DRAWING_BACKGROUND: '#ffffff',
    /**
     * Drawing document size (intrinsic resolution). Pointer events, ops and the saved
     * PNG all live in this fixed space; the display canvas may render smaller.
     */
    DRAWING_DEFAULT_DOC_W: 1200,
    DRAWING_DEFAULT_DOC_H: 800,
    /** Hard bounds applied when (re)loading or creating a drawing. */
    DRAWING_MIN_DOC_DIM: 64,
    DRAWING_MAX_DOC_DIM: 4096,
    SEARCH_DEBOUNCE_DELAY: 500,        // ms - Delay before running note search while typing
    SEARCH_MIN_QUERY_LENGTH: 2,        // Shorter queries show the folder tree instead of searching
    SHARE_SLUG_MIN_LENGTH: 3,          // Mirrors SLUG_MIN_LENGTH in backend/share.py
    SHARE_SLUG_MAX_LENGTH: 64,         // Mirrors SLUG_MAX_LENGTH in backend/share.py
    SHARE_SLUG_WORDS: 4,               // Words pulled from a note when suggesting a link name
    SHARE_SLUG_CHECK_DEBOUNCE: 300,    // ms - Delay before asking the server whether a name is free
    SAVE_INDICATOR_DURATION: 2000,     // ms - How long to show "saved" indicator
    DEFAULT_SIDEBAR_WIDTH: 256,        // px - Default sidebar width (w-64 in Tailwind)
    TOAST_MAX_VISIBLE: 4,              // Max stacked toasts; oldest dropped when exceeded
    TOAST_DURATION_ERROR_MS: 7000,
    TOAST_DURATION_WARNING_MS: 5500,
    TOAST_DURATION_INFO_MS: 4500,
    TOAST_DURATION_SUCCESS_MS: 3500,
};

/** Heroicons outline paths for popup actions shown as icons; the label becomes the tooltip */
const ACTION_ICONS = {
    download: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4',
    openNewTab: 'M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14',
    openNote: 'M13 7l5 5m0 0l-5 5m5-5H6',
    edit: 'M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z',
    confirm: 'M5 13l4 4L19 7',
    refresh: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
    web: 'M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9',
    article: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
    pdf: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    image: 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z',
    delete: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16',
};

/** Heroicons outline "share" (same d= as shared-note icon in the file tree) */
// The note icon of partials/note-icon.html, and the folder icon, for markup built in JS
const NOTE_ICON_SVG = '<svg class="note-icon" viewBox="12 7 48 50" aria-hidden="true">'
    + '<path d="M19 11h19l9 9v31a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3V14a3 3 0 0 1 3-3z" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"/>'
    + '<path d="M38 11v7a2 2 0 0 0 2 2h7" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"/>'
    + '<path d="M23 27h15M23 35h9" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'
    + '<circle cx="45" cy="45" r="10" fill="#fbbf24"/>'
    + '</svg>';
const FOLDER_ICON_PATH = 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z';
// The PDF icon of partials/pdf-icon.html, for markup built in JS (the file tree)
const PDF_ICON_SVG = '<svg class="pdf-icon" viewBox="0 0 48 56" aria-hidden="true">'
    + '<path d="M6 2h26l14 14v36a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="var(--bg-primary)" stroke="var(--border-primary)" stroke-width="2"/>'
    + '<path d="M32 2v12a2 2 0 0 0 2 2h12" fill="none" stroke="var(--border-primary)" stroke-width="2"/>'
    + '<rect x="0" y="30" width="36" height="16" rx="3" fill="#e5252a"/>'
    + '<text x="18" y="42" text-anchor="middle" fill="#fff" font-size="11" font-weight="700" font-family="system-ui, sans-serif">PDF</text>'
    + '</svg>';
const SHARE_ICON_PATH = 'M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z';

/**
 * Latin letters that Unicode decomposition cannot reduce to an ASCII base letter.
 * Accents come off "ó" and "ż" on their own, but "ł" and "ß" are indivisible, so
 * without this they read as punctuation: "żółty" would become "zo-ty".
 */
const SLUG_TRANSLITERATIONS = {
    'ł': 'l', 'ø': 'o', 'ß': 'ss', 'đ': 'd', 'ð': 'd', 'þ': 'th',
    'æ': 'ae', 'œ': 'oe', 'ħ': 'h', 'ı': 'i', 'ŧ': 't',
};
const SLUG_TRANSLITERATION_RE = new RegExp(`[${Object.keys(SLUG_TRANSLITERATIONS).join('')}]`, 'gi');

// localStorage settings configuration - centralized definition of all persisted settings
const LOCAL_SETTINGS = {
    // Boolean settings
    readableLineLength: { key: 'readableLineLength', type: 'boolean', default: true },
    favoritesExpanded: { key: 'favoritesExpanded', type: 'boolean', default: true },
    tagsExpanded: { key: 'tagsExpanded', type: 'boolean', default: false },
    attachmentsExpanded: { key: 'attachmentsExpanded', type: 'boolean', default: false },
    hideUnderscoreFolders: { key: 'hideUnderscoreFolders', type: 'boolean', default: false },
    sidebarPanelCollapsed: { key: 'sidebarPanelCollapsed', type: 'boolean', default: false },
    autoFillNoteTitle: { key: 'autoFillNoteTitle', type: 'boolean', default: false },
    // String settings
    sortMode: { key: 'sortMode', type: 'string', default: 'a-z' },
    newButtonAction: {
        key: 'newButtonAction', type: 'string', default: 'chooser',
        valid: ['chooser', 'note', 'folder', 'template', 'drawing']
    },
    lastUsedTemplate: { key: 'lastUsedTemplate', type: 'string', default: '' },
    // Number settings with validation
    sidebarWidth: { key: 'sidebarWidth', type: 'number', default: CONFIG.DEFAULT_SIDEBAR_WIDTH, min: 200, max: 600 },
    // String settings with validation
    viewMode: { key: 'viewMode', type: 'string', default: 'edit', valid: ['edit', 'read'] },
    // Homepage layout. Cards stay the default so existing vaults look unchanged.
    homepageView: { key: 'homepageView', type: 'string', default: 'cards', valid: ['cards', 'list'] },
    attachmentsView: { key: 'attachmentsView', type: 'string', default: 'cards', valid: ['cards', 'list'] },
    // JSON settings
    favorites: { key: 'noteFavorites', type: 'json', default: [] },
};

// Centralized error handling
const ErrorHandler = {
    /**
     * Handle errors consistently across the app
     * @param {string} operation - The operation that failed (e.g., "load notes", "save note")
     * @param {Error} error - The error object
     * @param {boolean} notify - Whether to show a toast (listens on keepit:toast)
     */
    handle(operation, error, notify = true) {
        console.error(`Failed to ${operation}:`, error);
        if (notify) {
            const message = `Failed to ${operation}. Please try again.`;
            window.dispatchEvent(new CustomEvent('keepit:toast', {
                detail: { message, type: 'error' }
            }));
        }
    }
};

/**
 * Encode one vault-relative path for a URL.
 * Each segment is encoded on its own so a `#` stays in the path. Left raw, the
 * browser treats it as a fragment and the request hits a different note.
 */
function encodeVaultPath(path) {
    if (!path) return '';
    return String(path).split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * Centralized filename validation
 * Supports Unicode characters (international text) but blocks dangerous filesystem characters.
 * Does NOT silently modify filenames - validates and returns status.
 */
const FilenameValidator = {
    // Characters that are forbidden in filenames across Windows/macOS/Linux,
    // plus `#`, `[` and `]`. A hash is legal on disk, but in this app it starts a
    // heading link (`[[Note#heading]]`) and, unencoded, it is a URL fragment.
    // Brackets would end an embed of the note's own attachment folder early.
    // Windows: \ / : * ? " < > |
    // macOS: / :
    // Linux: / \0
    // Common set to block (including control characters)
    FORBIDDEN_CHARS: /[\\/:*?"<>|#\[\]\x00-\x1f]/,
    
    // For display purposes - human readable list
    FORBIDDEN_CHARS_DISPLAY: '\\ / : * ? " < > | # [ ]',
    
    /**
     * Validate a filename (single segment, no path separators)
     * @param {string} name - The filename to validate
     * @returns {{ valid: boolean, error?: string, sanitized?: string }}
     */
    validateFilename(name) {
        if (!name || typeof name !== 'string') {
            return { valid: false, error: 'empty' };
        }
        
        const trimmed = name.trim();
        if (!trimmed) {
            return { valid: false, error: 'empty' };
        }
        
        // Check for forbidden characters
        if (this.FORBIDDEN_CHARS.test(trimmed)) {
            return { 
                valid: false, 
                error: 'forbidden_chars',
                forbiddenChars: this.FORBIDDEN_CHARS_DISPLAY
            };
        }
        
        // Check for reserved Windows names (case-insensitive)
        const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
        if (reservedNames.test(trimmed)) {
            return { valid: false, error: 'reserved_name' };
        }
        
        // Check for names starting/ending with dots or spaces (problematic on some systems)
        if (trimmed.startsWith('.') && trimmed.length === 1) {
            return { valid: false, error: 'invalid_dot' };
        }
        if (trimmed.endsWith('.') || trimmed.endsWith(' ')) {
            return { valid: false, error: 'trailing_dot_space' };
        }
        
        return { valid: true, sanitized: trimmed };
    },
    
    /**
     * Validate a path (may contain forward slashes for folder separators)
     * @param {string} path - The path to validate
     * @returns {{ valid: boolean, error?: string, sanitized?: string }}
     */
    validatePath(path) {
        if (!path || typeof path !== 'string') {
            return { valid: false, error: 'empty' };
        }
        
        const trimmed = path.trim();
        if (!trimmed) {
            return { valid: false, error: 'empty' };
        }
        
        // Split by forward slash and validate each segment
        const segments = trimmed.split('/').filter(s => s.length > 0);
        if (segments.length === 0) {
            return { valid: false, error: 'empty' };
        }
        
        for (const segment of segments) {
            const result = this.validateFilename(segment);
            if (!result.valid) {
                return result;
            }
        }
        
        // Rebuild path without empty segments
        return { valid: true, sanitized: segments.join('/') };
    }
};

/** Max leading spaces Shift+Tab removes per line when matching one “tab indent” vs \t inserts. */
const EDITOR_TAB_OUTDENT_MAX_SPACES = 4;

// The / menu. `type` is what formatText() runs, `hint` shows the Markdown it stands for.
const SLASH_COMMANDS = [
    { type: 'upload', group: 'format.group_links', label: 'format.upload', hint: '', keywords: 'attach file upload image picture photo audio video pdf', inline: true },
    { type: 'attach', group: 'format.group_links', label: 'format.attach', hint: '[[', keywords: 'attach wikilink note link file embed image pdf', inline: true },
    { type: 'heading1', group: 'format.text', label: 'format.heading_1', hint: '#', keywords: 'h1 heading title' },
    { type: 'heading2', group: 'format.text', label: 'format.heading_2', hint: '##', keywords: 'h2 heading' },
    { type: 'heading3', group: 'format.text', label: 'format.heading_3', hint: '###', keywords: 'h3 heading' },
    { type: 'quote', group: 'format.text', label: 'format.quote', hint: '>', keywords: 'quote blockquote' },
    { type: 'callout', group: 'format.text', label: 'format.callout', hint: '> [!NOTE]', keywords: 'callout note tip warning admonition' },
    { type: 'bullet', group: 'format.group_lists', label: 'format.bullet_list', hint: '-', keywords: 'bullet list ul' },
    { type: 'numbered', group: 'format.group_lists', label: 'format.numbered_list', hint: '1.', keywords: 'numbered ordered list ol' },
    { type: 'checkbox', group: 'format.group_lists', label: 'format.checkbox', hint: '- [ ]', keywords: 'task todo checkbox list' },
    { type: 'codeblock', group: 'format.group_blocks', label: 'format.codeblock', hint: '```', keywords: 'code block fence' },
    { type: 'table', group: 'format.group_blocks', label: 'format.table', hint: '', keywords: 'table grid' },
    { type: 'divider', group: 'format.group_blocks', label: 'format.divider', hint: '---', keywords: 'divider line rule hr separator' },
    { type: 'formula', group: 'format.group_blocks', label: 'embed.formula', hint: '$$', keywords: 'formula math latex equation' },
    { type: 'diagram', group: 'format.group_blocks', label: 'embed.diagram', hint: 'mermaid', keywords: 'diagram mermaid chart flowchart' },
];

// Headings of the Attach list, nearest to the open note first. It holds more than the
// [[ list, since it's also for browsing.
const ATTACH_GROUPS = ['format.attach_note', 'format.attach_folder', 'format.attach_parent', 'format.attach_other'];
const ATTACH_LIMIT = 50;

// What selected text can become, in the Turn into menu. `type` is what turnInto() runs.
const TURN_INTO_BLOCKS = [
    { type: 'text', label: 'format.text' },
    { type: 'heading1', label: 'format.heading_1' },
    { type: 'heading2', label: 'format.heading_2' },
    { type: 'heading3', label: 'format.heading_3' },
    { type: 'quote', label: 'format.quote' },
    { type: 'bullet', label: 'format.bullet_list' },
    { type: 'numbered', label: 'format.numbered_list' },
    { type: 'checkbox', label: 'format.checkbox' },
    { type: 'codeblock', label: 'format.codeblock' },
];

const MEDIA_FORMATS_DISPLAY = 'JPG, PNG, GIF, WebP, MP3, MP4, PDF, MD';

const MEDIA_UPLOAD_TYPES = [
    // Images
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
    // Audio
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/m4a', 'audio/x-m4a',
    // Video
    'video/mp4', 'video/webm', 'video/quicktime',
    // Documents
    'application/pdf'
];

