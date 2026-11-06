// NoteDiscovery Frontend Application

// The live Tiptap editor. Kept out of noteApp()'s data: Alpine's reactive proxies break ProseMirror.
let noteEditor = null;

// MathJax can't typeset two things at once, so formulas wait their turn here.
let mathQueue = Promise.resolve();

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

/** Heroicons outline "share" (same d= as shared-note icon in the file tree) */
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
    // JSON settings
    favorites: { key: 'noteFavorites', type: 'json', default: [] },
};

// Centralized error handling
const ErrorHandler = {
    /**
     * Handle errors consistently across the app
     * @param {string} operation - The operation that failed (e.g., "load notes", "save note")
     * @param {Error} error - The error object
     * @param {boolean} notify - Whether to show a toast (listens on notediscovery:toast)
     */
    handle(operation, error, notify = true) {
        console.error(`Failed to ${operation}:`, error);
        if (notify) {
            const message = `Failed to ${operation}. Please try again.`;
            window.dispatchEvent(new CustomEvent('notediscovery:toast', {
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
    { type: 'attach', group: 'format.group_media', label: 'format.attach', hint: '', keywords: 'attach file upload image picture photo audio video pdf', inline: true },
    { type: 'link', group: 'format.group_links', label: 'format.link', hint: '', keywords: 'link url address', inline: true },
    { type: 'noteLink', group: 'format.group_links', label: 'format.note_link', hint: '[[', keywords: 'wikilink note link', inline: true },
];

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

/** GFM task item as (everything up to `[`)(state). Literal spaces around the
 *  brackets, not \s, because that is what marked requires; the leading chain covers
 *  containers opened on the same line, e.g. `- > - [ ] x`, which marked does render.
 *  Missing a task marked renders is the one unsafe direction: see _scanTaskLines. */
const TASK_ITEM_RE = /^(\s*(?:(?:[-*+]|\d{1,9}[.)]) +|>\s*)*(?:[-*+]|\d{1,9}[.)]) +\[)([ xX])(?=\] )/;

function noteApp() {
    return {
        // App state
        appName: 'NoteDiscovery',
        appVersion: '0.0.0',
        mediaUploadTypes: MEDIA_UPLOAD_TYPES.join(','),
        authEnabled: false,
        demoMode: false,
        alreadyDonated: false,
        autosaveDelayMs: CONFIG.AUTOSAVE_DELAY,  // hydrated from /api/config in loadConfig()
        defaultTheme: CONFIG.DEFAULT_THEME,      // hydrated from /api/config in loadConfig()
        uploadMaxNoteMb: CONFIG.UPLOAD_MAX_NOTE_MB, // hydrated from /api/config in loadConfig()
        // Optional public origin for share links; empty keeps window.location.origin.
        sharePublicOrigin: '',
        notes: [],

        // True while /api/notes is in flight. Drives the "Loading your vault…"
        // placeholder + the delayed overlay (notesLoadingShowOverlay).
        notesLoading: true,
        notesLoadingShowOverlay: false,
        _notesLoadingOverlayTimer: null,

        currentNote: '',
        currentNoteName: '',
        noteContent: '',
        viewMode: 'edit', // 'edit', 'read'
        searchQuery: '',
        
        // Graph state (separate overlay, doesn't affect viewMode)
        showGraph: false,
        graphInstance: null,
        graphLoaded: false,
        graphData: null,
        searchResults: [],
        currentSearchHighlight: '', // Track current highlighted search term
        currentMatchIndex: 0, // Current match being viewed
        totalMatches: 0, // Total number of matches in the note
        isSaving: false,
        lastSaved: false,
        noteBaseHash: null,        // Fingerprint of the current note as last read or written on disk
        _saveQueued: false,        // A save was requested while another was in flight
        _saveConflictOpen: false,  // The "changed elsewhere" prompt is showing; saves wait
        linkCopied: false,
        zenMode: false,
        // Hides only the .sidebar-panel content (files / search / tags / outline / etc.) while
        // keeping the icon rail visible — a lighter "focus mode" than zenMode. Persisted via
        // LOCAL_SETTINGS so it survives reload; hydrated by loadLocalSettings() at app init,
        // which is why the initial value here matches the LOCAL_SETTINGS default.
        sidebarPanelCollapsed: false,
        previousViewMode: 'edit',
        favorites: [],
        favoritesSet: new Set(), // For O(1) lookups
        favoritesExpanded: true,
        saveTimeout: null,
        
        // Note lookup maps for O(1) wikilink resolution (built on loadNotes)
        _noteLookup: {
            byPath: new Map(),           // path -> true
            byPathLower: new Map(),      // path.toLowerCase() -> true
            byName: new Map(),           // name (without .md) -> true  
            byNameLower: new Map(),      // name.toLowerCase() -> true
            byEndPath: new Map(),        // '/filename' and '/filename.md' -> true
        },
        
        // Media lookup map for O(1) media wikilink resolution (built on loadNotes)
        // Maps media filename (case-insensitive) -> full path
        _mediaPaths: new Set(),
        
        // Preview rendering debounce
        _previewDebounceTimeout: null,
        
        // Theme state
        currentTheme: 'light',
        availableThemes: [],
        
        // Locale/i18n state
        currentLocale: localStorage.getItem('locale') || 'en-US',
        availableLocales: [],
        // Translations loaded from backend (preloaded before Alpine init via window.__preloadedTranslations)
        translations: window.__preloadedTranslations || {},
        
        // Syntax highlighting
        
        // Readable line length (preview max-width)
        readableLineLength: true,
        
        // Hide underscore-prefixed folders (such as _templates) from sidebar
        // Read synchronously to prevent flash on initial render
        hideUnderscoreFolders: localStorage.getItem('hideUnderscoreFolders') === 'true',

        // Tab key inserts tab character instead of changing focus

        // Note sorting mode (a-z, z-a, newest, oldest, largest, smallest)
        sortMode: localStorage.getItem('sortMode') || 'a-z',

        // Icon rail / panel state
        activePanel: 'files', // 'files', 'search', 'tags', 'outline', 'backlinks', 'shared', 'trash', 'settings'
        
        // Folder state
        folderTree: [],
        allFolders: [],
        expandedFolders: new Set(),
        dragOverFolder: null,  // Track which folder is being hovered during drag
        
        // Tags state
        allTags: {},
        selectedTags: [],
        tagsExpanded: false,
        tagReloadTimeout: null, // For debouncing tag reloads

        // Search state
        searchDebounceTimeout: null,
        isSearching: false,
        
        // Outline (TOC) state
        outline: [], // [{level: 1, text: 'Heading', slug: 'heading'}, ...]

        // Backlinks state
        backlinks: [], // [{path: 'note.md', name: 'Note', references: [{line_number: 5, context: '...', type: 'wikilink'}]}]

        // Scroll sync state
        
        // Unified drag state for notes, folders, and media
        draggedItem: null,  // { path: string, type: 'note' | 'folder' | 'image' | 'audio' | 'video' | 'document' }
        dropTarget: null,   // 'editor' | 'folder' | null
        externalDragActive: false,  // true while OS files (not sidebar items) are being dragged over the editor
        
        // What the undo and redo buttons can do right now
        canUndo: false,
        canRedo: false,

        // The noteContent the editor is showing. Anything else came from outside the editor.
        _editorMarkdown: '',

        // Per-note editor scroll position, keyed by note path. Captured when leaving a note in
        // loadNote() and restored when returning to the same note in the same session. Stays
        // in memory only — cleared on page reload, intentionally (matches typical editor UX).
        noteScrollPositions: {},
        
        // Stats plugin state
        statsPluginEnabled: false,
        noteStats: null,
        statsExpanded: false,
        
        // Note metadata (frontmatter) state
        noteMetadata: null,
        metadataExpanded: false,
        _lastFrontmatter: null, // Cache to avoid re-parsing unchanged frontmatter
        
        // Sidebar resize state
        sidebarWidth: CONFIG.DEFAULT_SIDEBAR_WIDTH,
        isResizing: false,
        
        // Mobile sidebar state
        mobileSidebarOpen: false,
        
        // Split view resize state
        
        // Dropdown state
        showNewDropdown: false,
        dropdownTargetFolder: null, // Folder context for "New" dropdown ('' = root, null = not set)
        dropdownPosition: { top: 0, left: 0 }, // Position for contextual dropdown

        // Autocomplete popup (triggered by [[ for notes, ![[ for media, / for block commands)
        wikilinkAutocomplete: {
            open: false,
            mode: 'note',        // 'note' | 'media' | 'slash'
            inline: false,       // slash mode where a block can't go
            query: '',
            items: [],           // [{label, secondary, insert, kind, prefix, modified}]
            activeIndex: 0,
            position: { top: 0, left: 0, above: false, maxHeight: 300 },
        },
        _wlClientRect: null, // Caret rectangle getter from the editor

        // Address popover for the link and image buttons
        linkPrompt: {
            open: false,
            type: 'link',        // 'link' | 'wikilink'
            href: '',
            canRemove: false,
            position: { top: 0, left: 0, above: false },
        },

        // Shown while a link, formula, diagram or media file is selected
        itemPopup: {
            open: false,
            label: '',
            actions: [],         // { label, run }
            position: { top: 0, left: 0, above: false },
        },
        _itemOutOfView: false, // Hidden only by scrolling, so scrolling back restores it

        // Formatting buttons shown over selected text
        turnIntoBlocks: TURN_INTO_BLOCKS,
        turnIntoMenu: { open: false, key: '', position: { top: 0, left: 0, above: false }, maxHeight: 300 },
        tablePopup: { open: false, top: 0, left: 0 },
        addButton: { open: false, top: 0, left: 0 },
        selectionBubble: {
            open: false,
            active: {},          // { bold, italic, strike, code, link }
            block: 'text',       // a key of the editor's BLOCKS
            codeOnly: false,     // inside a code block, where marks don't apply
            inTable: false,
            position: { top: 0, left: 0, above: true },
        },

        // Source of a formula or diagram
        sourcePrompt: {
            open: false,
            label: '',
            value: '',
            isNew: false,        // Nothing was written yet, so cancelling removes the item
            position: { top: 0, left: 0, above: false },
        },
        _noteNameCounts: new Map(), // lower note stem -> count, for name-vs-path insertion
        
        // Template state
        showTemplateModal: false,
        availableTemplates: [],
        selectedTemplate: '',
        newTemplateNoteName: '',
        newButtonAction: 'chooser',
        autoFillNoteTitle: false,
        lastUsedTemplate: '',
        
        // New note / folder name modal (replaces window.prompt)
        showCreateNameModal: false,
        createNameModalKind: 'note',
        createNameModalTargetFolder: '',
        createNameModalInput: '',
        
        // Rename folder modal (replaces window.prompt)
        showRenameFolderModal: false,
        renameFolderPath: '',
        renameFolderOldName: '',
        renameFolderInput: '',
        
        // Generic confirm dialog (replaces window.confirm)
        showConfirmModal: false,
        confirmModalTitle: '',
        confirmModalMessage: '',
        confirmModalDanger: true,
        confirmModalConfirmLabel: '',
        confirmModalCancelLabel: '',
        _confirmModalResolve: null,
        
        // Share state
        showShareModal: false,
        shareInfo: null,
        shareLoading: false,
        showShareQR: false,
        shareLinkCopied: false,
        shareUseRandomLink: true,   // Off hands the link name to the user
        shareSlug: '',              // Just the last URL segment, without /share/
        shareSlugState: '',         // '' while unknown, 'ok', or a rejection reason code
        _shareSlugCheckTid: null,
        _shareResetTid: null,
        _sharedNotePaths: new Set(),  // O(1) lookup for shared note indicators
        _sharedNotePathsList: [], // sorted paths, mirrors Set for reactive sidebar panel
        trashItems: [], // what GET /api/trash lists, most recently deleted first
        
        // Quick Switcher state (Ctrl+Alt+P)
        showQuickSwitcher: false,
        quickSwitcherQuery: '',
        quickSwitcherIndex: 0,
        quickSwitcherResults: [],
        
        // Non-blocking notifications (replaces window.alert)
        toasts: [],
        _toastIdSeq: 0,
        
        // Homepage state
        selectedHomepageFolder: '',
        _homepageCache: {
            folderPath: null,
            notes: null,
            folders: null,
            breadcrumb: null
        },
        
        // Homepage constants
        HOMEPAGE_MAX_NOTES: 50,
        // Read before init() so the first paint matches the saved layout.
        homepageView: localStorage.getItem('homepageView') === 'list' ? 'list' : 'cards',
        // Name filter for the current homepage folder. Separate from searchQuery,
        // which is the sidebar's full-text search.
        homepageNameQuery: '',
        
        // Computed-like helpers for homepage (cached for performance)
        homepageNotes() {
            // Return cached result if folder hasn't changed
            if (this._homepageCache.folderPath === this.selectedHomepageFolder && this._homepageCache.notes) {
                return this._homepageCache.notes;
            }
            
            if (!this.folderTree || typeof this.folderTree !== 'object') {
                return [];
            }
            
            const folderNode = this.getFolderNode(this.selectedHomepageFolder || '');
            const result = (folderNode && Array.isArray(folderNode.notes)) ? folderNode.notes : [];
            
            // Cache the result
            this._homepageCache.notes = result;
            this._homepageCache.folderPath = this.selectedHomepageFolder;
            
            return result;
        },
        
        homepageFolders() {
            // Return cached result if folder hasn't changed
            if (this._homepageCache.folderPath === this.selectedHomepageFolder && this._homepageCache.folders) {
                return this._homepageCache.folders;
            }
            
            if (!this.folderTree || typeof this.folderTree !== 'object') {
                return [];
            }
            
            // Get child folders
            let childFolders = [];
            if (!this.selectedHomepageFolder) {
                // Root level: all top-level folders
                childFolders = Object.entries(this.folderTree)
                    .filter(([key]) => key !== '__root__')
                    .map(([, folder]) => folder);
            } else {
                // Inside a folder: get its children
                const parentFolder = this.getFolderNode(this.selectedHomepageFolder);
                if (parentFolder && parentFolder.children) {
                    childFolders = Object.values(parentFolder.children);
                }
            }
            
            // Map to simplified structure (note count already cached in folder node)
            const result = childFolders
                .map(folder => ({
                    name: folder.name,
                    path: folder.path,
                    noteCount: folder.noteCount || 0  // Use pre-calculated count
                }))
                .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
            
            // Cache the result
            this._homepageCache.folders = result;
            this._homepageCache.folderPath = this.selectedHomepageFolder;
            
            return result;
        },
        
        homepageBreadcrumb() {
            // Return cached result if folder hasn't changed
            if (this._homepageCache.folderPath === this.selectedHomepageFolder && this._homepageCache.breadcrumb) {
                return this._homepageCache.breadcrumb;
            }
            
            const breadcrumb = [{ name: this.t('homepage.title'), path: '' }];
            
            if (this.selectedHomepageFolder) {
                const parts = this.selectedHomepageFolder.split('/').filter(Boolean);
                let currentPath = '';
                
                parts.forEach(part => {
                    currentPath = currentPath ? `${currentPath}/${part}` : part;
                    breadcrumb.push({ name: part, path: currentPath });
                });
            }
            
            // Cache the result
            this._homepageCache.breadcrumb = breadcrumb;
            this._homepageCache.folderPath = this.selectedHomepageFolder;
            
            return breadcrumb;
        },

        setHomepageView(mode) {
            if (mode !== 'cards' && mode !== 'list') return;
            if (mode === this.homepageView) return;
            this.homepageView = mode;
            localStorage.setItem('homepageView', mode);
        },

        homepageNameNeedle() {
            return (this.homepageNameQuery || '').trim().toLowerCase();
        },

        // Filter the current folder's notes or folders by name. An empty query
        // returns the cached source array so Alpine does not rebuild the grid.
        // Notes and folders keep separate cache entries: they share a folder, but
        // a hit for one must not satisfy the other.
        _filterHomepageByName(items, kind) {
            const needle = this.homepageNameNeedle();
            if (!needle) return items;
            const cacheKey = kind === 'notes' ? 'noteFilter' : 'folderFilter';
            const cache = this._homepageCache;
            const entry = cache[cacheKey];
            if (entry && entry.needle === needle && entry.source === items) {
                return entry.result;
            }
            const filtered = items.filter(item => (item.name || '').toLowerCase().includes(needle));
            cache[cacheKey] = { needle, source: items, result: filtered };
            return filtered;
        },

        homepageVisibleNotes() {
            return this._filterHomepageByName(this.homepageNotes(), 'notes');
        },

        homepageVisibleFolders() {
            return this._filterHomepageByName(this.homepageFolders(), 'folders');
        },
        
        // Helper: Format file size nicely
        formatSize(bytes) {
            if (!bytes) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
        },
        
        // Helper: Format date using current locale
        formatDate(dateStr) {
            if (!dateStr) return '';
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return '';
            return date.toLocaleDateString(this.currentLocale, { 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric' 
            });
        },
        
        getFolderNode(folderPath = '') {
            if (!this.folderTree || typeof this.folderTree !== 'object') {
                return null;
            }
            
            if (!folderPath) {
                return this.folderTree['__root__'] || { name: '', path: '', children: {}, notes: [], noteCount: 0 };
            }
            
            const parts = folderPath.split('/').filter(Boolean);
            let currentLevel = this.folderTree;
            let node = null;
            
            for (const part of parts) {
                if (!currentLevel[part]) {
                    return null;
                }
                node = currentLevel[part];
                currentLevel = node.children || {};
            }
            
            return node;
        },
        
        // Check if app is empty (no notes and no folders)
        get isAppEmpty() {
            const notesArray = Array.isArray(this.notes) ? this.notes : [];
            const foldersArray = Array.isArray(this.allFolders) ? this.allFolders : [];
            return notesArray.length === 0 && foldersArray.length === 0;
        }, 
        
        // Mermaid state cache
        lastMermaidTheme: null,
        _mermaidCount: 0,
        _scrollRestorePending: false, // A note is loading, so scrolling says nothing about where it was left
        
        // Media viewer state
        currentMedia: '',  // Path to current media file (kept as 'currentMedia' for compatibility)
        currentMediaType: 'image',  // 'image', 'audio', 'video', 'document', 'drawing'
        
        // Drawing canvas (drawing-*.png only) — ops are session-only until Save flattens to PNG.
        // Coordinates in drawingOps[] are stored in DOCUMENT space (drawingDocW × drawingDocH),
        // not display CSS pixels, so resizing the editor pane never moves strokes and exported
        // PNGs are byte-deterministic regardless of screen size or device pixel ratio.
        drawingTool: 'freehand',
        drawingColor: '#1a1a1a',
        drawingLineWidth: 4,
        drawingOps: [],
        /**
         * Intrinsic drawing dimensions (document px). Overwritten per-drawing by
         * createNewDrawing() or initDrawingViewer(); edit CONFIG to change the default.
         */
        drawingDocW: CONFIG.DRAWING_DEFAULT_DOC_W,
        drawingDocH: CONFIG.DRAWING_DEFAULT_DOC_H,
        drawingRedoStack: [],
        drawingDraft: null,
        drawingIsPointerDown: false,
        // Text tool — pending input state. The HTML overlay <input> binds to drawingTextValue
        // while drawingTextActive is true; on commit a 'text' op is pushed to drawingOps.
        drawingTextActive: false,
        drawingTextDocX: 0,         // commit position in DOC space
        drawingTextDocY: 0,
        drawingTextCssX: 0,         // overlay <input> position in CSS pixels (canvas-relative)
        drawingTextCssY: 0,
        drawingTextValue: '',
        drawingTextDocFontSize: 24, // font size in DOC pixels (auto-scales to display)
        /** True after the PNG from disk has been decoded into _drawingBaseImage; false after Clear. */
        drawingHasRasterFromFile: false,
        /** Prevents overlapping drawingSave() runs (Ctrl+S + autosave + fast retries). */
        _drawingSaveInFlight: false,
        /** If true, run drawingSave again after the current one finishes (coalesce). */
        _drawingSaveQueued: false,
        _drawingAutosaveTimeout: null,
        
        // DOM element cache (to avoid repeated querySelector calls)
        _domCache: {
            editor: null
        },
        
        // Initialize app
        async init() {
            // Prevent double initialization (Alpine.js may call x-init twice in some cases)
            if (window.__noteapp_initialized) return;
            window.__noteapp_initialized = true;
            
            // Store global reference for native event handlers in x-html content
            window.$root = this;
            
            // ESC key to cancel drag operations
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.draggedItem) {
                    this.cancelDrag();
                }
            });
            
            await this.loadConfig();
            await this.loadThemes();
            await this.initTheme();
            await this.loadAvailableLocales();
            // Note: Translations are preloaded synchronously before Alpine init (see index.html)
            // loadLocale() is only called when user changes language from settings
            await this.loadNotes();
            await this.loadSharedNotePaths();
            this.loadTrash();
            await this.loadTemplates();
            await this.checkStatsPlugin();
            this.loadLocalSettings();
            
            // Outside changes (preview task toggles, closing a note) must reach the editor
            this.$watch('noteContent', (value) => {
                if (value !== this._editorMarkdown) {
                    this._showInEditor(value, { resetHistory: !this.currentNote });
                }
            });
            
            // Timers won't run once the page is gone, so save on the way out
            const saveOnLeave = () => {
                noteEditor?.flush();
                if (this.saveTimeout) this.saveNote({ keepalive: true });
            };
            window.addEventListener('pagehide', saveOnLeave);
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) saveOnLeave();
            });
            
            // Parse URL and load specific note if provided
            this.loadItemFromURL();
            
            // Set initial homepage state ONLY if we're actually on the homepage
            if (window.location.pathname === '/') {
                window.history.replaceState({ homepageFolder: '' }, '', '/');
                document.title = this.appName;
            }
            
            // Listen for browser back/forward navigation
            window.addEventListener('popstate', (e) => {
                if (e.state && e.state.notePath) {
                    // Navigating to a note
                    const searchQuery = e.state.searchQuery || '';
                    this.loadNote(e.state.notePath, false, searchQuery); // false = don't update history
                    
                    // Update search box and trigger search if needed
                    if (searchQuery) {
                        this.searchQuery = searchQuery;
                        this.searchNotes();
                    } else {
                        this.searchQuery = '';
                        this.searchResults = [];
                        this.clearSearchHighlights();
                    }
                } else if (e.state && e.state.mediaPath) {
                    // Navigating to a media file
                    this.viewMedia(e.state.mediaPath, null, false);
                } else {
                    // Navigating back to homepage
                    this._commitPendingEdits();
                    this.currentNote = '';
                    this.noteContent = '';
                    this.currentNoteName = '';
                    this.outline = [];
                    this.backlinks = [];
                    this.shareInfo = null; // Reset share info
                    document.title = this.appName;
                    
                    // Restore homepage folder state if it was saved
                    if (e.state && e.state.homepageFolder !== undefined) {
                        this.selectedHomepageFolder = e.state.homepageFolder || '';
                    } else {
                        // No folder state in history, go to root
                        this.selectedHomepageFolder = '';
                    }
                    
                    // Invalidate cache to force recalculation
                    this._homepageCache = {
                        folderPath: null,
                        notes: null,
                        folders: null,
                        breadcrumb: null
                    };
                    
                    // Clear search
                    this.searchQuery = '';
                    this.searchResults = [];
                    this.clearSearchHighlights();
                }
            });
            
            // Cache DOM references after initial render
            this.$nextTick(() => {
                this.refreshDOMCache();
            });
            
            // Watch view mode changes and auto-save
            this.$watch('viewMode', (newValue) => {
                this.saveViewMode();
                noteEditor?.setEditable(newValue === 'edit');
            });
            
            // Watch for changes in note content to re-apply search highlights
            this.$watch('noteContent', () => {
                if (this.currentSearchHighlight) {
                    // Re-apply highlights after content changes (with small delay for render)
                    this.$nextTick(() => {
                        setTimeout(() => {
                            // Don't focus editor during content changes (false)
                            this.highlightSearchTerm(this.currentSearchHighlight);
                        }, 50);
                    });
                }
            });
            
            // Watch tags panel expanded state and save to localStorage
            this.$watch('tagsExpanded', () => {
                this.saveTagsExpanded();
            });
            
            // Watch favorites expanded state and save to localStorage
            this.$watch('favoritesExpanded', () => {
                this.saveFavoritesExpanded();
            });
            
            // Setup keyboard shortcuts (only once to prevent double triggers)
            if (!window.__noteapp_shortcuts_initialized) {
                window.__noteapp_shortcuts_initialized = true;
                window.addEventListener('keydown', (e) => {
                    // Use e.key (not e.code) for letter keys to support non-QWERTY keyboard layouts
                    
                    // Ctrl/Cmd + S to save (drawing saves PNG; notes save markdown)
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                        if (this.currentMedia && this.currentMediaType === 'drawing') {
                            e.preventDefault();
                            this.drawingSave();
                        } else {
                            e.preventDefault();
                            this.saveNote();
                        }
                    }
                    
                    // Ctrl/Cmd + Alt + P for Quick Switcher
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'p') {
                        e.preventDefault();
                        this.openQuickSwitcher();
                        return;
                    }
                    
                    // Ctrl/Cmd + Alt/Option + N for new note
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'n') {
                        e.preventDefault();
                        this.createNote();
                    }
                    
                    // Ctrl/Cmd + Alt/Option + F for new folder
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'f') {
                        e.preventDefault();
                        this.createFolder();
                    }
                    
                    // Inside the editor, Tiptap's keymap has already handled undo and redo
                    const inEditor = e.target.closest?.('#note-editor');
                    
                    // Ctrl/Cmd + Z for undo (drawing vs note editor)
                    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
                        if (this.currentMedia && this.currentMediaType === 'drawing') {
                            e.preventDefault();
                            this.drawingUndo();
                        } else if (!inEditor) {
                            e.preventDefault();
                            this.undo();
                        }
                    }
                    
                    // Ctrl/Cmd + Y OR Ctrl/Cmd+Shift+Z for redo
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                        if (this.currentMedia && this.currentMediaType === 'drawing') {
                            e.preventDefault();
                            this.drawingRedo();
                        } else if (!inEditor) {
                            e.preventDefault();
                            this.redo();
                        }
                    }
                    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
                        if (this.currentMedia && this.currentMediaType === 'drawing') {
                            e.preventDefault();
                            this.drawingRedo();
                        } else if (!inEditor) {
                            e.preventDefault();
                            this.redo();
                        }
                    }
                    
                    // F3 for next search match
                    if (e.code === 'F3' && !e.shiftKey) {
                        e.preventDefault();
                        this.nextMatch();
                    }
                    
                    // Shift + F3 for previous search match
                    if (e.code === 'F3' && e.shiftKey) {
                        e.preventDefault();
                        this.previousMatch();
                    }
                    
                    // Ctrl/Cmd + Alt/Option + Z to toggle Zen mode.
                    // Global (fires regardless of focus) so users can enter/exit Zen without
                    // first clicking into the editor. Requires an open note; noop otherwise.
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'z') {
                        if (this.currentNote) {
                            e.preventDefault();
                            this.toggleZenMode();
                        }
                    }
                    
                    // View-mode shortcuts (global — fire regardless of focus):
                    //   Ctrl/Cmd + Alt/Option + 1  → Edit
                    //   Ctrl/Cmd + Alt/Option + 3  → Read
                    //   Ctrl/Cmd + Alt/Option + V  → Toggle between them
                    // Skipped when no note is open, in Zen mode (edit-only), or while the graph
                    // overlay is showing. Uses e.code for digits so the physical top-row keys
                    // fire on AZERTY/QWERTZ layouts (where 1/2/3 need Shift) and to bypass
                    // Mac's Option+digit dead-key composer (Option+1 = ¡, etc.).
                    if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey
                        && this.currentNote && !this.zenMode && !this.showGraph) {
                        let targetMode = null;
                        if (e.code === 'Digit1') {
                            targetMode = 'edit';
                        } else if (e.code === 'Digit3') {
                            targetMode = 'read';
                        } else if (e.key.toLowerCase() === 'v') {
                            targetMode = this.viewMode === 'edit' ? 'read' : 'edit';
                        }
                        if (targetMode !== null) {
                            e.preventDefault();
                            this.viewMode = targetMode;
                        }
                    }
                    
                    // Bold, italic and the rest come from Tiptap's keymap
                    if (noteEditor?.isFocused() && this.currentNote) {
                        // Ctrl/Cmd + K for link
                        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                            e.preventDefault();
                            this.formatText('link');
                        }
                        
                        // Ctrl/Cmd + Alt/Option + T for table
                        if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 't') {
                            e.preventDefault();
                            this.formatText('table');
                        }
                    }
                    
                    // Escape to exit Zen mode (works anywhere)
                    if (e.key === 'Escape' && this.zenMode) {
                        e.preventDefault();
                        this.toggleZenMode();
                    }
                });
            }
            
            // Listen for system theme changes
            if (window.matchMedia) {
                window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                    if (this.currentTheme === 'system') {
                        this.applyTheme('system');
                    }
                });
            }
            
            // Listen for fullscreen changes (to sync zen mode state)
            document.addEventListener('fullscreenchange', () => {
                if (!document.fullscreenElement && this.zenMode) {
                    // User exited fullscreen manually, exit zen mode too
                    this.zenMode = false;
                    this.viewMode = this.previousViewMode;
                }
            });
            
            // Toasts from ErrorHandler and code paths without Alpine `this`
            if (!window.__noteapp_toast_listener) {
                window.__noteapp_toast_listener = true;
                window.addEventListener('notediscovery:toast', (e) => {
                    const d = e.detail || {};
                    if (typeof d.message !== 'string' || !d.message) return;
                    this.toast(d.message, {
                        type: d.type || 'error',
                        durationMs: d.durationMs
                    });
                });
            }
        },
        
        // Load app configuration
        async loadConfig() {
            try {
                const response = await fetch('/api/config');
                const config = await response.json();
                this.appName = config.name;
                this.appVersion = config.version || '0.0.0';
                this.authEnabled = config.authentication?.enabled || false;
                this.demoMode = config.demoMode || false;
                this.alreadyDonated = config.alreadyDonated || false;
                // Server already clamps autosaveDelayMs to a sane range; we just sanity-check the type.
                if (Number.isFinite(config.autosaveDelayMs) && config.autosaveDelayMs > 0) {
                    this.autosaveDelayMs = config.autosaveDelayMs;
                }
                if (typeof config.defaultTheme === 'string' && config.defaultTheme) {
                    this.defaultTheme = config.defaultTheme;
                }
                if (Number.isFinite(config.uploadMaxNoteMb) && config.uploadMaxNoteMb > 0) {
                    this.uploadMaxNoteMb = config.uploadMaxNoteMb;
                }
                if (typeof config.sharePublicOrigin === 'string' && config.sharePublicOrigin) {
                    this.sharePublicOrigin = config.sharePublicOrigin;
                }
            } catch (error) {
                console.error('Failed to load config:', error);
            }
        },
        
        // Load available themes from backend
        async loadThemes() {
            try {
                const response = await fetch('/api/themes');
                const data = await response.json();
                
                // Use theme names directly from backend (already include emojis)
                this.availableThemes = data.themes;
            } catch (error) {
                console.error('Failed to load themes:', error);
                // Fallback to default themes
                this.availableThemes = [
                    { id: 'light', name: '🌞 Light' },
                    { id: 'dark', name: '🌙 Dark' }
                ];
            }
        },
        
        // Initialize theme system
        async initTheme() {
            // A user's saved preference takes priority over the configured default.
            const savedTheme = localStorage.getItem('noteDiscoveryTheme') || this.defaultTheme;
            this.currentTheme = savedTheme;
            await this.applyTheme(savedTheme);
        },
        
        // Set and apply theme
        async setTheme(themeId) {
            this.currentTheme = themeId;
            localStorage.setItem('noteDiscoveryTheme', themeId);
            await this.applyTheme(themeId);
        },
        
        // Load all localStorage settings at once using centralized config
        loadLocalSettings() {
            for (const [prop, config] of Object.entries(LOCAL_SETTINGS)) {
                try {
                    const saved = localStorage.getItem(config.key);
                    
                    if (saved === null) {
                        // Use default value if not set
                        this[prop] = config.default;
                    } else if (config.type === 'boolean') {
                        this[prop] = saved === 'true';
                    } else if (config.type === 'number') {
                        const num = parseFloat(saved);
                        // Validate range if specified
                        if (!isNaN(num) && 
                            (config.min === undefined || num >= config.min) && 
                            (config.max === undefined || num <= config.max)) {
                            this[prop] = num;
                        } else {
                            this[prop] = config.default;
                        }
                    } else if (config.type === 'string') {
                        // Validate against allowed values if specified
                        if (!config.valid || config.valid.includes(saved)) {
                            this[prop] = saved;
                        } else {
                            this[prop] = config.default;
                        }
                    } else if (config.type === 'json') {
                        this[prop] = JSON.parse(saved);
                    }
                } catch (error) {
                    console.error(`Error loading setting ${prop}:`, error);
                    this[prop] = config.default;
                }
            }
            
            // Special case: favorites also needs to update the Set for O(1) lookups
            this.favoritesSet = new Set(this.favorites);
        },
        
        // Readable line length toggle (for preview max-width)
        toggleReadableLineLength() {
            this.readableLineLength = !this.readableLineLength;
            localStorage.setItem('readableLineLength', this.readableLineLength);
        },
        
        // Hide underscore folders toggle (sidebar tree and graph)
        toggleHideUnderscoreFolders() {
            this.hideUnderscoreFolders = !this.hideUnderscoreFolders;
            localStorage.setItem('hideUnderscoreFolders', this.hideUnderscoreFolders);
            if (this.showGraph) {
                this.initGraph();
            }
        },

        // Hide / show only the sidebar PANEL (files, search, outline, etc.); the icon rail
        // stays put so users can still switch panels with one click after re-expanding.
        // Width is animated via CSS; sidebarWidth itself is intentionally NOT touched, so a
        // user's custom drag-resized width is restored automatically on expand.
        toggleSidebarPanel() {
            this.sidebarPanelCollapsed = !this.sidebarPanelCollapsed;
            localStorage.setItem('sidebarPanelCollapsed', this.sidebarPanelCollapsed);
        },

        // Switch the active sidebar panel (Files / Search / Tags / Outline / Backlinks / Shared
        // / Settings) with smart toggle behaviour for the icon rail:
        //
        //   collapsed       + click any icon X  → expand + switch to X
        //   expanded, on Y  + click icon X      → switch to X (no collapse change)
        //   expanded, on X  + click icon X      → collapse (symmetric "click active to close")
        //
        // That third rule matches the VS Code / Cursor / JetBrains / Obsidian convention where
        // re-clicking the active sidebar icon hides the panel. Without it, the only way to
        // collapse would be the dedicated toggle button, which is fine but leaves an asymmetry.
        //
        // On mobile (≤768px) the desktop collapse is CSS-overridden, so the panel is always
        // visible; we deliberately skip toggling in that case so a one-off mobile tap doesn't
        // silently clear the user's persisted desktop preference.
        openSidebarPanel(panelName) {
            const isDesktop = window.innerWidth > 768;
            if (isDesktop && this.activePanel === panelName && !this.sidebarPanelCollapsed) {
                this.toggleSidebarPanel();
                return;
            }
            this.activePanel = panelName;
            if (isDesktop && this.sidebarPanelCollapsed) {
                this.toggleSidebarPanel();
            }
        },

        // Sort mode configuration
        sortModes: ['a-z', 'z-a', 'newest', 'oldest', 'largest', 'smallest'],
        sortModeIcons: {
            'a-z': 'A↓',
            'z-a': 'Z↓',
            'newest': '🕐↓',
            'oldest': '🕐↑',
            'largest': '📄↓',
            'smallest': '📄↑'
        },

        // Cycle through sort modes
        cycleSortMode() {
            const currentIndex = this.sortModes.indexOf(this.sortMode);
            const nextIndex = (currentIndex + 1) % this.sortModes.length;
            this.sortMode = this.sortModes[nextIndex];
            localStorage.setItem('sortMode', this.sortMode);
            // Rebuild tree to apply new sort order
            this.buildFolderTree();
        },

        // Get current sort icon
        getSortIcon() {
            return this.sortModeIcons[this.sortMode] || 'A↓';
        },

        // Get sort comparator based on current mode (for notes)
        getSortComparator() {
            switch (this.sortMode) {
                case 'z-a':
                    return (a, b) => b.name.toLowerCase().localeCompare(a.name.toLowerCase());
                case 'newest':
                    return (a, b) => (b.modified || '').localeCompare(a.modified || '');
                case 'oldest':
                    return (a, b) => (a.modified || '').localeCompare(b.modified || '');
                case 'largest':
                    return (a, b) => (b.size || 0) - (a.size || 0);
                case 'smallest':
                    return (a, b) => (a.size || 0) - (b.size || 0);
                case 'a-z':
                default:
                    return (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
            }
        },

        // Get sort comparator for folders (only A-Z/Z-A, others default to A-Z)
        getFolderSortComparator() {
            if (this.sortMode === 'z-a') {
                return (a, b) => b.name.toLowerCase().localeCompare(a.name.toLowerCase());
            }
            // Default: A-Z for all other modes
            return (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        },

        // Apply theme to document
        async applyTheme(themeId) {
            // Load theme CSS from file. The head preload may already have inserted
            // #dynamic-theme for this id; skip the second download and the CSS write
            // in that case. Highlight.js is still updated below, because the preload
            // does not touch #highlight-theme.
            try {
                const existing = document.getElementById('dynamic-theme');
                const alreadyLoaded = existing
                    && existing.textContent
                    && document.documentElement.getAttribute('data-theme') === themeId;

                if (!alreadyLoaded) {
                    const response = await fetch(`/api/themes/${themeId}`);
                    const data = await response.json();

                    let styleEl = existing;
                    if (!styleEl) {
                        styleEl = document.createElement('style');
                        styleEl.id = 'dynamic-theme';
                        document.head.appendChild(styleEl);
                    }
                    styleEl.textContent = data.css;

                    document.documentElement.setAttribute('data-theme', themeId);
                }
                
                // Load appropriate Highlight.js theme for code syntax highlighting
                const highlightTheme = document.getElementById('highlight-theme');
                if (highlightTheme) {
                    if (themeId === 'light') {
                        highlightTheme.href = '/static/vendor/highlight.js/styles/github.min.css';
                    } else {
                        // Use dark theme for dark/custom themes
                        highlightTheme.href = '/static/vendor/highlight.js/styles/github-dark.min.css';
                    }
                }
                
                // Small delay to allow theme CSS to load
                if (this.currentNote) setTimeout(() => noteEditor?.refreshRendered(['mermaidBlock']), 100);
                
                // Refresh graph if visible (longer delay to ensure CSS is applied)
                if (this.showGraph) {
                    setTimeout(() => this.initGraph(), 300);
                }
                
                // Update PWA theme-color meta tag to match current theme
                const themeColorMeta = document.querySelector('meta[name="theme-color"]');
                if (themeColorMeta) {
                    // Get the accent color from CSS variables
                    const accentColor = getComputedStyle(document.documentElement)
                        .getPropertyValue('--accent-primary').trim() || '#667eea';
                    themeColorMeta.setAttribute('content', accentColor);
                }
            } catch (error) {
                console.error('Failed to load theme:', error);
            }
        },
        
        // ==================== INTERNATIONALIZATION ====================
        
        // Translation function - get translated string by key
        t(key, params = {}) {
            const keys = key.split('.');
            let value = this.translations;
            
            for (const k of keys) {
                value = value?.[k];
            }
            
            // Fallback to key if translation not found (silently - default translations are inline)
            if (typeof value !== 'string') {
                return key;
            }
            
            // Replace {{param}} placeholders
            return value.replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? `{{${name}}}`);
        },
        
        /**
         * Non-blocking toast (replaces window.alert). Types map to theme CSS variables.
         * @param {string} message
         * @param {{ type?: 'error'|'warning'|'info'|'success', durationMs?: number }} [options]
         * @returns {number|undefined} toast id
         */
        toast(message, options = {}) {
            if (typeof message !== 'string' || !message) return;
            const type = ['error', 'warning', 'info', 'success'].includes(options.type)
                ? options.type
                : 'info';
            let durationMs = options.durationMs;
            if (durationMs == null || typeof durationMs !== 'number' || durationMs < 0) {
                durationMs = type === 'error' ? CONFIG.TOAST_DURATION_ERROR_MS
                    : type === 'warning' ? CONFIG.TOAST_DURATION_WARNING_MS
                        : type === 'success' ? CONFIG.TOAST_DURATION_SUCCESS_MS
                            : CONFIG.TOAST_DURATION_INFO_MS;
            }
            const id = ++this._toastIdSeq;
            const entry = { id, message, type, _tid: null };
            this.toasts.push(entry);
            while (this.toasts.length > CONFIG.TOAST_MAX_VISIBLE) {
                const first = this.toasts.shift();
                if (first && first._tid) clearTimeout(first._tid);
            }
            entry._tid = setTimeout(() => this.dismissToast(id), durationMs);
            return id;
        },
        
        dismissToast(id) {
            const idx = this.toasts.findIndex((t) => t.id === id);
            if (idx === -1) return;
            const entry = this.toasts[idx];
            if (entry._tid) {
                clearTimeout(entry._tid);
                entry._tid = null;
            }
            this.toasts.splice(idx, 1);
        },
        
        /**
         * Get localized error message from FilenameValidator result
         * @param {object} validation - The validation result from FilenameValidator
         * @param {string} type - 'note' or 'folder'
         * @returns {string} Localized error message
         */
        getValidationErrorMessage(validation, type = 'note') {
            switch (validation.error) {
                case 'empty':
                    return type === 'note' 
                        ? this.t('notes.empty_name') 
                        : this.t('folders.invalid_name');
                case 'forbidden_chars':
                    return this.t('validation.forbidden_chars', { 
                        chars: validation.forbiddenChars 
                    });
                case 'reserved_name':
                    return this.t('validation.reserved_name');
                case 'invalid_dot':
                    return this.t('validation.invalid_dot');
                case 'trailing_dot_space':
                    return this.t('validation.trailing_dot_space');
                default:
                    return type === 'note' 
                        ? this.t('notes.invalid_name') 
                        : this.t('folders.invalid_name');
            }
        },
        
        // Load available locales from backend
        async loadAvailableLocales() {
            try {
                const response = await fetch('/api/locales');
                const data = await response.json();
                this.availableLocales = data.locales || [];
            } catch (error) {
                console.error('Failed to load available locales:', error);
                this.availableLocales = [{ code: 'en-US', name: 'English', flag: '🇺🇸' }];
            }
        },
        
        // Load translations for a specific locale
        async loadLocale(localeCode = null) {
            const targetLocale = localeCode || localStorage.getItem('locale') || 'en-US';
            
            try {
                const response = await fetch(`/api/locales/${targetLocale}`);
                if (response.ok) {
                    this.translations = await response.json();
                    this.currentLocale = targetLocale;
                    localStorage.setItem('locale', targetLocale);
                } else if (targetLocale !== 'en-US') {
                    // Fallback to en-US if requested locale not found
                    await this.loadLocale('en-US');
                }
            } catch (error) {
                console.error('Failed to load locale:', error);
                // If en-US also fails, translations will be empty and t() will return keys
                if (targetLocale !== 'en-US') {
                    await this.loadLocale('en-US');
                }
            }
        },
        
        // Change locale and reload translations
        async changeLocale(localeCode) {
            await this.loadLocale(localeCode);
        },
        
        // ==================== END INTERNATIONALIZATION ====================
        
        // Load all notes. Pass {silent: true} from error-recovery paths so the
        // 800ms loading overlay never appears on background re-syncs.
        async loadNotes({ silent = false } = {}) {
            this.notesLoading = true;
            clearTimeout(this._notesLoadingOverlayTimer);
            if (!silent) {
                this._notesLoadingOverlayTimer = setTimeout(() => {
                    if (this.notesLoading && this.notes.length === 0 && this.allFolders.length === 0) {
                        this.notesLoadingShowOverlay = true;
                    }
                }, 800);
            }
            try {
                const response = await fetch('/api/notes');
                const data = await response.json();
                this.notes = data.notes;
                this.allFolders = data.folders || [];
                this.buildNoteLookupMaps();
                this.buildFolderTree();
                await this.loadTags();
            } catch (error) {
                ErrorHandler.handle('load notes', error);
            } finally {
                clearTimeout(this._notesLoadingOverlayTimer);
                this.notesLoading = false;
                this.notesLoadingShowOverlay = false;
            }
        },
        
        // Build lookup maps for O(1) wikilink resolution
        buildNoteLookupMaps() {
            // Clear existing maps
            this._noteLookup.byPath.clear();
            this._noteLookup.byPathLower.clear();
            this._noteLookup.byName.clear();
            this._noteLookup.byNameLower.clear();
            this._noteLookup.byEndPath.clear();
            this._mediaPaths.clear();
            this._noteNameCounts.clear();
            this.$nextTick(() => noteEditor?.refreshRendered(['wikilink', 'embed', 'image']));
            
            const setFirst = (map, key, value) => {
                if (!map.has(key)) map.set(key, value);
            };
            
            for (const note of this.notes) {
                const path = note.path;
                const pathLower = path.toLowerCase();
                const name = note.name;
                const nameLower = name.toLowerCase();
                
                // Media files are found by their exact path
                if (note.type !== 'note') {
                    this._mediaPaths.add(path);
                    continue;
                }
                
                // Notes only from here
                const nameWithoutMd = name.replace(/\.md$/i, '');
                const nameWithoutMdLower = nameWithoutMd.toLowerCase();
                const urlPath = path.replace(/\.md$/i, '');

                // Count notes per stem so autocomplete can insert a bare name when
                // unique and a folder-relative path when ambiguous.
                this._noteNameCounts.set(nameWithoutMdLower, (this._noteNameCounts.get(nameWithoutMdLower) || 0) + 1);
                
                // Store all variations for fast lookup. The value is the note's URL
                // path, so a wikilink can be resolved to a href and not just tested
                // for existence. Name keys collide when two folders hold the same
                // note name, so first match wins, the same rule the media map above
                // and the name lookup in handleInternalLink already use.
                setFirst(this._noteLookup.byPath, path, urlPath);
                setFirst(this._noteLookup.byPath, urlPath, urlPath);
                setFirst(this._noteLookup.byPathLower, pathLower, urlPath);
                setFirst(this._noteLookup.byPathLower, pathLower.replace(/\.md$/i, ''), urlPath);
                setFirst(this._noteLookup.byName, name, urlPath);
                setFirst(this._noteLookup.byName, nameWithoutMd, urlPath);
                setFirst(this._noteLookup.byNameLower, nameLower, urlPath);
                setFirst(this._noteLookup.byNameLower, nameWithoutMdLower, urlPath);
                
                // End path matching (for /folder/note style links)
                setFirst(this._noteLookup.byEndPath, '/' + nameWithoutMdLower, urlPath);
                setFirst(this._noteLookup.byEndPath, '/' + nameLower, urlPath);
            }
        },
        
        // Resolve a wikilink target to the target note's URL path (O(1) lookup)
        // Returns the path without its .md extension, or null when nothing matches
        resolveWikiLink(linkTarget) {
            const targetLower = linkTarget.toLowerCase();
            
            // Check all lookup maps
            return (
                this._noteLookup.byPath.get(linkTarget) ??
                this._noteLookup.byPath.get(linkTarget + '.md') ??
                this._noteLookup.byPathLower.get(targetLower) ??
                this._noteLookup.byPathLower.get(targetLower + '.md') ??
                this._noteLookup.byName.get(linkTarget) ??
                this._noteLookup.byNameLower.get(targetLower) ??
                this._noteLookup.byEndPath.get('/' + targetLower) ??
                this._noteLookup.byEndPath.get('/' + targetLower + '.md') ??
                null
            );
        },
        
        // Fast O(1) check if a wikilink target exists
        wikiLinkExists(linkTarget) {
            return this.resolveWikiLink(linkTarget) !== null;
        },
        
        // Resolve media wikilink to full path (O(1) lookup)
        // Returns the full path if found, null otherwise
        // An embed target is a path relative to the note holding it. Null if it climbs
        // out of the vault or nothing is there: a file is never matched by name.
        resolveMediaWikilink(target) {
            const parts = this.currentNote.split('/').slice(0, -1);
            for (const part of target.split('/')) {
                if (part === '..') {
                    if (parts.length === 0) return null;
                    parts.pop();
                } else if (part && part !== '.') {
                    parts.push(part);
                }
            }
            const path = parts.join('/');
            return this._mediaPaths.has(path) ? path : null;
        },
        
        // The embed target for a vault file, as seen from a note
        relativeMediaPath(notePath, mediaPath) {
            const from = notePath.split('/').slice(0, -1);
            const to = mediaPath.split('/');
            let shared = 0;
            while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
            return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/');
        },

        
        // ---- Wikilink / media autocomplete -------------------------------------
        // Triggered while typing inside [[ (notes) or ![[ (media). Suggestions are
        // computed client-side from the already-loaded notes list; no backend calls.

        // The editor reports the unfinished token, or null once it ends.
        wlUpdate(suggestion) {
            if (!suggestion) { this.wlClose(); return; }

            this.wikilinkAutocomplete.mode = suggestion.isSlash ? 'slash' : (suggestion.isMedia ? 'media' : 'note');
            this.wikilinkAutocomplete.inline = !!suggestion.inline;
            this.wikilinkAutocomplete.query = suggestion.query;
            this._wlClientRect = suggestion.clientRect;
            this.wlComputeItems();
            if (this.wikilinkAutocomplete.items.length === 0) { this.wlClose(); return; }
            this.wikilinkAutocomplete.activeIndex = 0;
            this.wikilinkAutocomplete.open = true;
            this.wlUpdatePosition();
            this._updateTablePopup(noteEditor?.tableAtCursor());
        },

        // Rebuild the suggestion list for the current query/mode.
        wlComputeItems() {
            const WL_LIMIT = 8;
            const q = this.wikilinkAutocomplete.query.trim().toLowerCase();
            if (this.wikilinkAutocomplete.mode === 'slash') {
                this.wikilinkAutocomplete.items = this._slashItems(q);
                return;
            }
            const isMedia = this.wikilinkAutocomplete.mode === 'media';
            const results = [];

            for (const note of this.notes) {
                if (isMedia ? note.type === 'note' : note.type !== 'note') continue;

                const path = note.path;
                const folder = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';

                let label, insert;
                if (isMedia) {
                    label = path.split('/').pop();   // filename with extension
                    insert = this.relativeMediaPath(this.currentNote, path);
                } else {
                    const stem = note.name.replace(/\.md$/i, '');
                    label = stem;
                    // Bare name when unique, else folder-relative path (no extension).
                    insert = (this._noteNameCounts.get(stem.toLowerCase()) || 0) > 1
                        ? path.replace(/\.md$/i, '')
                        : stem;
                }

                const labelLower = label.toLowerCase();
                const pathLower = path.toLowerCase();
                if (q && !labelLower.includes(q) && !pathLower.includes(q)) continue;

                results.push({
                    label,
                    secondary: folder,
                    insert,
                    kind: note.type,
                    prefix: q ? labelLower.startsWith(q) : false,
                    modified: note.modified || '',
                });
            }

            // Prefix matches first, then most-recently-modified, then alphabetical.
            // `modified` is an ISO timestamp, so lexical compare orders by time.
            results.sort((a, b) =>
                (b.prefix - a.prefix) || b.modified.localeCompare(a.modified) || a.label.localeCompare(b.label));
            this.wikilinkAutocomplete.items = results.slice(0, WL_LIMIT);
        },

        // Block commands matching `query`, by their translated name or English keywords
        _slashItems(query) {
            const { inline } = this.wikilinkAutocomplete;
            const commands = SLASH_COMMANDS.filter((command) => !inline || command.inline);
            const items = commands.map(({ type, group, label, hint, keywords }) => {
                const name = this.t(label);
                return {
                    label: name,
                    secondary: hint,
                    insert: type,
                    group: this.t(group),
                    search: `${name} ${keywords}`.toLowerCase(),
                    prefix: name.toLowerCase().startsWith(query),
                };
            });
            if (query) return items.filter((item) => item.search.includes(query)).sort((a, b) => b.prefix - a.prefix);
            return items.map((item, index) => ({ ...item, heading: item.group === items[index - 1]?.group ? '' : item.group }));
        },

        // Keyboard handling while the popup is open. True means the key was used,
        // so the editor leaves it alone. Stopped here too, or Escape would also leave Zen mode.
        wlOnKeydown(event) {
            const wa = this.wikilinkAutocomplete;
            if (!wa.open) return false;

            switch (event.key) {
                case 'ArrowDown':
                    this.wlMove(1);
                    break;
                case 'ArrowUp':
                    this.wlMove(-1);
                    break;
                case 'Enter':
                case 'Tab':
                    this.wlAccept(wa.items[wa.activeIndex]);
                    break;
                case 'Escape':
                    this.wlClose();
                    break;
                default:
                    return false;
            }
            event.stopPropagation();
            return true;
        },

        wlMove(delta) {
            const n = this.wikilinkAutocomplete.items.length;
            if (!n) return;
            this.wikilinkAutocomplete.activeIndex =
                (this.wikilinkAutocomplete.activeIndex + delta + n) % n;
            this.$nextTick(() => document.querySelector('.wikilink-autocomplete-item.active')?.scrollIntoView({ block: 'nearest' }));
        },

        wlAccept(item) {
            if (!item) return;
            const isSlash = this.wikilinkAutocomplete.mode === 'slash';
            if (isSlash) noteEditor?.acceptSlash();
            else noteEditor?.acceptSuggestion(item.insert);
            this.wlClose();
            if (isSlash) this.formatText(item.insert);
        },

        wlClose() {
            if (this.wikilinkAutocomplete.open) this.wikilinkAutocomplete.open = false;
            this._updateTablePopup(noteEditor?.tableAtCursor());
            if (this._slashFromAddButton) {
                this._slashFromAddButton = false;
                // Not while the editor is still reporting the change that closed the menu
                setTimeout(() => noteEditor?.removeAddedSlash());
            }
        },

        // The + button types the / itself, so the same menu opens
        openAddMenu() {
            this._slashFromAddButton = true;
            noteEditor?.typeSlash();
        },

        // Position the popup just below the caret, clamped to the viewport.
        wlUpdatePosition() {
            const rect = this._wlClientRect?.();
            if (!rect) return;

            const POPUP_W = 360;
            const popupHeight = Math.min(this.wikilinkAutocomplete.items.length * 30 + 8, 300); // rough row height, CSS cap
            const area = this._visibleArea();
            const roomBelow = area.bottom - rect.bottom;
            const caretTop = Math.min(rect.top, area.bottom); // The caret itself can be behind the keyboard
            const roomAbove = caretTop - area.top;
            let left = rect.left;
            if (left + POPUP_W > window.innerWidth) left = Math.max(4, window.innerWidth - POPUP_W - 4);
            // Above the caret the popup hangs from its bottom edge, so it stays
            // against the line whatever its real height is.
            const above = roomBelow < popupHeight && roomAbove > roomBelow;
            const maxHeight = Math.min(300, (above ? roomAbove : roomBelow) - 4);
            this.wikilinkAutocomplete.position = { top: above ? caretTop : rect.bottom, left, above, maxHeight };
        },

        // Resolve a Markdown image path to a vault-relative path (forward slashes).
        // Relative paths use the note file's directory as base (same rules as CommonMark / browsers).
        // A leading "/" (not "//") means vault-root-relative.
        resolveMarkdownMediaPathForNote(noteVaultPath, rawSrc) {
            const pathPart = rawSrc.split('#')[0].split('?')[0];
            if (!pathPart) return '';
            if (pathPart.startsWith('/') && !pathPart.startsWith('//')) {
                return pathPart.replace(/^\/+/, '');
            }
            if (!noteVaultPath) {
                return pathPart;
            }
            const dir = noteVaultPath.includes('/')
                ? noteVaultPath.slice(0, noteVaultPath.lastIndexOf('/'))
                : '';
            const base = `https://vn.invalid/${dir ? `${dir}/` : ''}`;
            try {
                const u = new URL(pathPart, base);
                let p = u.pathname;
                if (p.startsWith('/')) p = p.slice(1);
                return p.split('/').filter(seg => seg !== '').map(seg => {
                    try {
                        return decodeURIComponent(seg);
                    } catch (e) {
                        return seg;
                    }
                }).join('/');
            } catch (e) {
                return pathPart;
            }
        },
        
        // The address of a file on our own media endpoint, or null for anything else.
        // Parsed rather than prefix-matched, so /api/media/../x cannot pass and
        // javascript: resolves to a foreign origin.
        safeMediaApiSrc(src) {
            try {
                const url = new URL(src, window.location.origin);
                if (url.origin === window.location.origin && url.pathname.startsWith('/api/media/')) {
                    return url.pathname + url.search + url.hash;
                }
            } catch (e) {
                // Unparseable, so not one of ours
            }
            return null;
        },

        // Embed for local audio, video or PDF, or null if src is not local media.
        // Nothing sanitizes these
        // later: the values must go in through DOM properties, never through markup.
        buildMediaEmbed(mediaType, src, altText) {
            const safeSrc = this.safeMediaApiSrc(src);
            const kinds = {
                audio: { tag: 'audio', wrapperClass: 'media-audio' },
                video: { tag: 'video', wrapperClass: 'media-video' },
                document: { tag: 'iframe', wrapperClass: 'media-pdf' },
            };
            const kind = kinds[mediaType];
            if (!safeSrc || !kind) return null;

            const element = document.createElement(kind.tag);
            element.setAttribute('src', safeSrc);
            element.setAttribute('title', altText);
            if (mediaType !== 'document') {
                element.setAttribute('controls', '');
                element.setAttribute('preload', 'none');
            }

            const wrapper = document.createElement('div');
            wrapper.className = `media-embed ${kind.wrapperClass}`;
            wrapper.appendChild(element);
            if (mediaType === 'audio') {
                const caption = document.createElement('span');
                caption.className = 'media-caption';
                caption.textContent = altText;
                wrapper.appendChild(caption);
            }
            return wrapper;
        },

        encodeVaultRelativePathForMediaApi(vaultRelativePath) {
            if (!vaultRelativePath) return '';
            return vaultRelativePath.split('/').map(segment => {
                try {
                    return encodeURIComponent(decodeURIComponent(segment));
                } catch (e) {
                    return encodeURIComponent(segment);
                }
            }).join('/');
        },
        
        // Load all tags
        async loadTags() {
            try {
                const response = await fetch('/api/tags');
                const data = await response.json();
                this.allTags = data.tags || {};
            } catch (error) {
                ErrorHandler.handle('load tags', error, false); // Optional: no toast
            }
        },
        
        // Debounced tag reload (prevents excessive API calls during typing)
        loadTagsDebounced() {
            // Clear existing timeout
            if (this.tagReloadTimeout) {
                clearTimeout(this.tagReloadTimeout);
            }
            
            // Set new timeout - reload tags 2 seconds after last save
            this.tagReloadTimeout = setTimeout(() => {
                this.loadTags();
            }, 2000);
        },
        
        // Toggle tag selection for filtering
        toggleTag(tag) {
            const index = this.selectedTags.indexOf(tag);
            if (index > -1) {
                this.selectedTags.splice(index, 1);
            } else {
                this.selectedTags.push(tag);
            }
            
            // Apply unified filtering
            this.applyFilters();
        },
        
        // ========================================================================
        // Template Methods
        // ========================================================================
        
        // Load available templates from _templates folder
        async loadTemplates() {
            try {
                const response = await fetch('/api/templates');
                const data = await response.json();
                this.availableTemplates = data.templates || [];
            } catch (error) {
                ErrorHandler.handle('load templates', error, false); // Optional: no toast
            }
        },
        
        // Create a new note from a template
        async createNoteFromTemplate() {
            if (!this.selectedTemplate || !this.newTemplateNoteName.trim()) {
                return;
            }
            
            try {
                // Validate the note name
                const validation = FilenameValidator.validateFilename(this.newTemplateNoteName);
                if (!validation.valid) {
                    this.toast(this.getValidationErrorMessage(validation, 'note'), { type: 'warning' });
                    return;
                }
                
                // Determine the note path based on dropdown context
                let notePath = validation.sanitized;
                if (!notePath.endsWith('.md')) {
                    notePath += '.md';
                }
                
                const targetFolder = this.inferredNewItemTargetFolder();
                
                // If we have a target folder, create note in that folder
                if (targetFolder) {
                    notePath = `${targetFolder}/${notePath}`;
                }
                
                // CRITICAL: Check if note already exists
                if (this.notePathTaken(notePath)) {
                    this.toast(this.t('notes.already_exists', { name: validation.sanitized }), { type: 'warning' });
                    return;
                }
                
                // Optimistic stub: add empty entry so sidebar updates instantly.
                // Server rendering may inject content/tags; loadNote() fetches the
                // real body and tags are refreshed via loadTagsDebounced below.
                this._optimisticAddNote(notePath, { content: '' });
                const folderPart = notePath.includes('/') ? notePath.substring(0, notePath.lastIndexOf('/')) : '';
                if (folderPart) this.expandedFolders.add(folderPart);
                this._rebuildTreeAfterMutation();
                
                try {
                    const response = await fetch('/api/templates/create-note', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            templateName: this.selectedTemplate,
                            notePath: notePath
                        })
                    });
                    if (!response.ok) {
                        const error = await response.json();
                        throw new Error(error.detail || this.t('templates.create_failed'));
                    }
                    const data = await response.json();
                    
                    this.lastUsedTemplate = this.selectedTemplate;
                    try { localStorage.setItem('lastUsedTemplate', this.selectedTemplate); } catch (_) {}
                    
                    this.showTemplateModal = false;
                    this.selectedTemplate = '';
                    this.newTemplateNoteName = '';
                    
                    await this.loadNote(data.path);
                    this.focusEditorForNewNote();
                    this.loadTagsDebounced();
                } catch (err) {
                    this.toast(err.message || this.t('templates.create_failed'), { type: 'error' });
                    await this.loadNotes({ silent: true });
                }
            } catch (error) {
                ErrorHandler.handle('create note from template', error);
            }
        },
        
        // Clear all tag filters
        clearTagFilters() {
            this.selectedTags = [];
            
            // Apply unified filtering
            this.applyFilters();
        },
        
        // ========================================================================
        // Outline (TOC) Methods
        // ========================================================================
        
        // Extract headings from markdown content for the outline
        extractOutline(content) {
            if (!content) {
                this.outline = [];
                this.backlinks = [];
                return;
            }
            
            const headings = [];
            const lines = content.split('\n');
            const slugCounts = {}; // Track duplicate slugs
            
            // Skip frontmatter and code blocks
            let inFrontmatter = false;
            let inCodeBlock = false;
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                
                // Handle frontmatter
                if (i === 0 && line.trim() === '---') {
                    inFrontmatter = true;
                    continue;
                }
                if (inFrontmatter) {
                    if (line.trim() === '---') {
                        inFrontmatter = false;
                    }
                    continue;
                }
                
                // Handle fenced code blocks (``` or ~~~)
                if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
                    inCodeBlock = !inCodeBlock;
                    continue;
                }
                if (inCodeBlock) {
                    continue;
                }
                
                // Match heading lines (# to ######)
                const match = line.match(/^(#{1,6})\s+(.+)$/);
                if (match) {
                    const level = match[1].length;
                    const text = match[2].trim();
                    
                    // Generate slug (GitHub-style)
                    let slug = text
                        .toLowerCase()
                        .replace(/[^\w\s-]/g, '') // Remove special chars
                        .replace(/\s+/g, '-')     // Spaces to dashes
                        .replace(/-+/g, '-');     // Multiple dashes to single
                    
                    // Handle duplicate slugs
                    if (slugCounts[slug] !== undefined) {
                        slugCounts[slug]++;
                        slug = `${slug}-${slugCounts[slug]}`;
                    } else {
                        slugCounts[slug] = 0;
                    }
                    
                    headings.push({
                        level,
                        text,
                        slug,
                        line: i + 1 // 1-indexed line number
                    });
                }
            }
            
            this.outline = headings;
        },
        
        // Scroll to a heading in the editor
        scrollToHeading(heading) {
            noteEditor?.jumpToHeading(heading.text);
        },

        // Navigate to a backlink (note that links to current note)
        navigateToBacklink(backlinkPath) {
            this.loadNote(backlinkPath);
        },
        
        // Unified filtering logic combining tags and text search
        async applyFilters() {
            const hasTextSearch = this.isSearchable();
            const hasTagFilter = this.selectedTags.length > 0;
            
            // Case 1: No filters at all → show full folder tree
            if (!hasTextSearch && !hasTagFilter) {
                this.isSearching = false;
                this.searchResults = [];
                this.currentSearchHighlight = '';
                this.clearSearchHighlights();
                this.buildFolderTree();
                return;
            }
            
            // Case 2: Only tag filter → convert to flat list of matching notes
            if (hasTagFilter && !hasTextSearch) {
                this.isSearching = false;
                this.searchResults = this.notes.filter(note => 
                    note.type === 'note' && this.noteMatchesTags(note)
                );
                this.currentSearchHighlight = '';
                this.clearSearchHighlights();
                return;
            }
            
            // Case 3: Text search (with or without tag filter)
            if (hasTextSearch) {
                this.isSearching = true;
                try {
                    const response = await fetch(`/api/search?q=${encodeURIComponent(this.searchQuery)}`);
                    const data = await response.json();
                    
                    // Apply tag filtering to search results if tags are selected
                    let results = data.results;
                    if (hasTagFilter) {
                        results = results.filter(result => {
                            const note = this.notes.find(n => n.path === result.path);
                            return note ? this.noteMatchesTags(note) : false;
                        });
                    }
                    
                    this.searchResults = results;
                    
                    // Highlight search term in current note if open
                    if (this.currentNote && this.noteContent) {
                        this.currentSearchHighlight = this.searchQuery;
                        this.$nextTick(() => {
                            this.highlightSearchTerm(this.searchQuery);
                        });
                    }
                } catch (error) {
                    console.error('Search failed:', error);
                    this.searchResults = [];
                } finally {
                    this.isSearching = false;
                }
            }
        },
        
        // Check if a note matches selected tags (AND logic)
        noteMatchesTags(note) {
            if (this.selectedTags.length === 0) {
                return true; // No filter active
            }
            if (!note.tags || note.tags.length === 0) {
                return false; // Note has no tags but filter is active
            }
            // Check if note has ALL selected tags (AND logic)
            return this.selectedTags.every(tag => note.tags.includes(tag));
        },
        
        // Get all tags sorted by name
        get sortedTags() {
            return Object.entries(this.allTags).sort((a, b) => a[0].localeCompare(b[0]));
        },
        
        // Get tags for current note
        get currentNoteTags() {
            if (!this.currentNote) return [];
            const note = this.notes.find(n => n.path === this.currentNote);
            return note && note.tags ? note.tags : [];
        },
        
        // ==================== FAVORITES ====================
        
        // Save favorites to localStorage
        saveFavorites() {
            try {
                localStorage.setItem('noteFavorites', JSON.stringify(this.favorites));
            } catch (e) {
                console.warn('Could not save favorites to localStorage');
            }
        },
        
        // Check if a note is favorited (O(1) lookup)
        isFavorite(notePath) {
            return this.favoritesSet.has(notePath);
        },
        
        // Toggle favorite status for a note
        toggleFavorite(notePath = null) {
            const path = notePath || this.currentNote;
            if (!path) return;
            
            if (this.favoritesSet.has(path)) {
                // Remove from favorites
                this.favorites = this.favorites.filter(f => f !== path);
            } else {
                // Add to favorites
                this.favorites = [...this.favorites, path];
            }
            // Recreate Set from array for consistency
            this.favoritesSet = new Set(this.favorites);
            this.saveFavorites();
        },
        
        // Get favorite notes with full details (for display)
        get favoriteNotes() {
            return this.favorites
                .map(path => {
                    // Find note by exact path or case-insensitive match
                    let note = this.notes.find(n => n.path === path);
                    if (!note) {
                        note = this.notes.find(n => n.path.toLowerCase() === path.toLowerCase());
                    }
                    if (!note) return null;
                    return {
                        path: note.path, // Use actual path from notes (fixes case issues)
                        name: note.path.split('/').pop().replace('.md', ''),
                        folder: note.folder || ''
                    };
                })
                .filter(Boolean); // Remove nulls (deleted notes)
        },
        
        saveFavoritesExpanded() {
            try {
                localStorage.setItem('favoritesExpanded', this.favoritesExpanded.toString());
            } catch (e) {
                console.error('Error saving favorites expanded state:', e);
            }
        },
        
        // Get current note's last modified time as relative string
        get lastEditedText() {
            if (!this.currentNote) return '';
            const note = this.notes.find(n => n.path === this.currentNote);
            if (!note || !note.modified) return '';
            
            const modified = new Date(note.modified);
            const now = new Date();
            const diffMs = now - modified;
            const diffSecs = Math.floor(diffMs / 1000);
            const diffMins = Math.floor(diffSecs / 60);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);
            
            if (diffSecs < 60) return this.t('editor.just_now');
            if (diffMins < 60) return this.t('editor.minutes_ago', { count: diffMins });
            if (diffHours < 24) return this.t('editor.hours_ago', { count: diffHours });
            if (diffDays < 7) return this.t('editor.days_ago', { count: diffDays });
            
            // For older dates, show the date in selected locale
            return modified.toLocaleDateString(this.currentLocale, { month: 'short', day: 'numeric' });
        },
        
        // Parse tags from markdown content (matches backend logic)
        parseTagsFromContent(content) {
            if (!content || !content.trim().startsWith('---')) {
                return [];
            }
            
            try {
                const lines = content.split('\n');
                if (lines[0].trim() !== '---') return [];
                
                // Find closing ---
                let endIdx = -1;
                for (let i = 1; i < lines.length; i++) {
                    if (lines[i].trim() === '---') {
                        endIdx = i;
                        break;
                    }
                }
                
                if (endIdx === -1) return [];
                
                const frontmatterLines = lines.slice(1, endIdx);
                const tags = [];
                let inTagsList = false;
                
                for (const line of frontmatterLines) {
                    const stripped = line.trim();
                    
                    // Check for inline array: tags: [tag1, tag2]
                    if (stripped.startsWith('tags:')) {
                        const rest = stripped.substring(5).trim();
                        if (rest.startsWith('[') && rest.endsWith(']')) {
                            const tagsStr = rest.substring(1, rest.length - 1);
                            const rawTags = tagsStr.split(',').map(t => t.trim());
                            tags.push(...rawTags.filter(t => t).map(t => t.toLowerCase()));
                            break;
                        } else if (rest) {
                            tags.push(rest.toLowerCase());
                            break;
                        } else {
                            inTagsList = true;
                        }
                    } else if (inTagsList) {
                        if (stripped.startsWith('-')) {
                            const tag = stripped.substring(1).trim();
                            if (tag && !tag.startsWith('#')) {
                                tags.push(tag.toLowerCase());
                            }
                        } else if (stripped && !stripped.startsWith('#')) {
                            break;
                        }
                    }
                }
                
                return [...new Set(tags)].sort();
            } catch (e) {
                console.error('Error parsing tags:', e);
                return [];
            }
        },
        
        // Build folder tree structure
        buildFolderTree() {
            const tree = {};
            
            // A note's attachment folder belongs to the note and isn't listed
            const isAttachmentPath = (path) => path.split('/').some(part => part.endsWith('.attachments'));
            
            // Add ALL folders from backend (including empty ones)
            this.allFolders.forEach(folderPath => {
                if (isAttachmentPath(folderPath)) return;
                const parts = folderPath.split('/');
                let current = tree;
                
                parts.forEach((part, index) => {
                    const fullPath = parts.slice(0, index + 1).join('/');
                    
                    if (!current[part]) {
                        current[part] = {
                            name: part,
                            path: fullPath,
                            children: {},
                            notes: []
                        };
                    }
                    current = current[part].children;
                });
            });
            
            // Add ALL notes to their folders (no filtering - tree only shown when no filters active)
            this.notes.forEach(note => {
                if (isAttachmentPath(note.folder)) return;
                if (!note.folder) {
                    // Root level note
                    if (!tree['__root__']) {
                        tree['__root__'] = {
                            name: '',
                            path: '',
                            children: {},
                            notes: []
                        };
                    }
                    tree['__root__'].notes.push(note);
                } else {
                    // Navigate to the folder and add note
                    const parts = note.folder.split('/');
                    let current = tree;
                    
                    for (let i = 0; i < parts.length; i++) {
                        if (!current[parts[i]]) {
                            current[parts[i]] = {
                                name: parts[i],
                                path: parts.slice(0, i + 1).join('/'),
                                children: {},
                                notes: []
                            };
                        }
                        if (i === parts.length - 1) {
                            current[parts[i]].notes.push(note);
                        } else {
                            current = current[parts[i]].children;
                        }
                    }
                }
            });
            
            // Sort all notes arrays alphabetically (create new sorted arrays for reactivity)
            const sortNotes = (obj) => {
                if (obj.notes && obj.notes.length > 0) {
                    // Create a new sorted array instead of mutating for Alpine reactivity
                    obj.notes = [...obj.notes].sort(this.getSortComparator());
                }
                if (obj.children && Object.keys(obj.children).length > 0) {
                    Object.values(obj.children).forEach(child => sortNotes(child));
                }
            };
            
            // Sort notes in root (create new array for reactivity)
            if (tree['__root__'] && tree['__root__'].notes) {
                tree['__root__'].notes = [...tree['__root__'].notes].sort(this.getSortComparator());
            }
            
            // Sort notes in all folders
            Object.values(tree).forEach(folder => {
                if (folder.path !== undefined) { // Skip __root__ as it was already sorted
                    sortNotes(folder);
                }
            });
            
            // Calculate and cache note counts recursively (for performance)
            const calculateNoteCounts = (folderNode) => {
                const directNotes = folderNode.notes ? folderNode.notes.length : 0;
                
                if (!folderNode.children || Object.keys(folderNode.children).length === 0) {
                    folderNode.noteCount = directNotes;
                    return directNotes;
                }
                
                const childNotesCount = Object.values(folderNode.children).reduce(
                    (total, child) => total + calculateNoteCounts(child),
                    0
                );
                
                folderNode.noteCount = directNotes + childNotesCount;
                return folderNode.noteCount;
            };
            
            // Calculate note counts for all folders
            Object.values(tree).forEach(folder => {
                if (folder.path !== undefined || folder === tree['__root__']) {
                    calculateNoteCounts(folder);
                }
            });
            
            // Invalidate homepage cache when tree is rebuilt
            this._homepageCache = {
                folderPath: null,
                notes: null,
                folders: null,
                breadcrumb: null
            };
            
            // Assign new tree (Alpine will detect the change)
            this.folderTree = tree;
        },
        
        // =====================================================================
        // OPTIMISTIC MUTATION HELPERS
        // Mirror server-side index updates locally so file ops feel instant on
        // big vaults. Mutations apply the change to this.notes/this.allFolders
        // immediately, fire the request, and on error fall back to
        // loadNotes({silent: true}) to resync from disk.
        // =====================================================================
        
        _isoNow() {
            return new Date().toISOString();
        },
        
        _folderFromPath(path) {
            const i = path.lastIndexOf('/');
            return i === -1 ? '' : path.substring(0, i);
        },
        
        _filenameFromPath(path) {
            return path.split('/').pop();
        },

        // Windows and macOS store these as one file. Rename already used this
        // comparison; create and import must too, or `b` overwrites `B`.
        notePathTaken(path) {
            if (!path) return false;
            const lower = path.toLowerCase();
            return this.notes.some(n => n.path.toLowerCase() === lower);
        },

        folderPathTaken(path) {
            if (!path) return false;
            const lower = path.toLowerCase();
            return this.allFolders.some(folder => folder.toLowerCase() === lower);
        },
        
        _inferTypeFromPath(path) {
            const m = /\.([^./]+)$/.exec(path);
            const ext = m ? m[1].toLowerCase() : '';
            if (ext === 'md' || ext === '') return 'note';
            if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'image';
            if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio';
            if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) return 'video';
            if (ext === 'pdf') return 'document';
            return 'note';
        },
        
        // Refresh sidebar tree + wikilink lookup maps after any optimistic update.
        _rebuildTreeAfterMutation() {
            this.buildNoteLookupMaps();
            this.buildFolderTree();
        },
        
        // Add a note/media file to the local list. No-op if already present.
        _optimisticAddNote(path, { content = '', type = null, size = null } = {}) {
            if (this.notes.some(n => n.path === path)) return;
            const inferredType = type || this._inferTypeFromPath(path);
            const filename = this._filenameFromPath(path);
            const name = inferredType === 'note' ? filename.replace(/\.md$/i, '') : filename;
            this.notes.push({
                path,
                name,
                folder: this._folderFromPath(path),
                type: inferredType,
                size: size != null ? size : (content ? new Blob([content]).size : 0),
                modified: this._isoNow(),
                tags: (inferredType === 'note' && content) ? this.parseTagsFromContent(content) : [],
            });
        },
        
        _optimisticRemoveNote(path) {
            this.notes = this.notes.filter(n => n.path !== path);
        },
        
        // Used by single-note rename and move (path changes, identity preserved).
        _optimisticRenameNote(oldPath, newPath) {
            // A note's attachment folder moves with it
            if (oldPath.endsWith('.md')) {
                this._optimisticRenameFolderTree(
                    oldPath.replace(/\.md$/, '.attachments'),
                    newPath.replace(/\.md$/, '.attachments'),
                );
            }
            const note = this.notes.find(n => n.path === oldPath);
            if (!note) return;
            note.path = newPath;
            note.folder = this._folderFromPath(newPath);
            const filename = this._filenameFromPath(newPath);
            note.name = note.type === 'note' ? filename.replace(/\.md$/i, '') : filename;
        },
        
        _optimisticAddFolder(folderPath) {
            if (!folderPath) return;
            if (!this.allFolders.includes(folderPath)) {
                this.allFolders.push(folderPath);
            }
        },
        
        // Cascade: remove the folder, its descendant folders, and every note inside.
        _optimisticRemoveFolderTree(folderPath) {
            const prefix = folderPath + '/';
            this.allFolders = this.allFolders.filter(f => f !== folderPath && !f.startsWith(prefix));
            this.notes = this.notes.filter(n => !n.path.startsWith(prefix));
        },
        
        // Cascade: rename the folder, its descendant folders, and rewrite paths
        // of every note inside.
        _optimisticRenameFolderTree(oldPath, newPath) {
            if (oldPath === newPath) return;
            const oldPrefix = oldPath + '/';
            const newPrefix = newPath + '/';
            this.allFolders = this.allFolders.map(f => {
                if (f === oldPath) return newPath;
                if (f.startsWith(oldPrefix)) return newPrefix + f.substring(oldPrefix.length);
                return f;
            });
            this.notes.forEach(n => {
                if (n.path.startsWith(oldPrefix)) {
                    n.path = newPrefix + n.path.substring(oldPrefix.length);
                    n.folder = this._folderFromPath(n.path);
                }
            });
        },
        
        // =====================================================================
        // DATA-ATTRIBUTE BASED HANDLERS
        // These read path/name/type from data-* attributes, avoiding JS escaping issues
        // =====================================================================
        
        // Escape strings for HTML attributes (simpler than JS escaping)
        escapeHtmlAttr(str) {
            if (!str) return '';
            return str
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        },
        
        // Folder handlers - read from dataset
        handleFolderClick(el) {
            this.toggleFolder(el.dataset.path);
        },
        handleFolderDragOver(el, event) {
            event.preventDefault();
            this.dragOverFolder = el.dataset.path;
            el.classList.add('drag-over');
        },
        handleFolderDragLeave(el) {
            this.dragOverFolder = null;
            el.classList.remove('drag-over');
        },
        handleFolderDrop(el, event) {
            event.stopPropagation();
            el.classList.remove('drag-over');
            this.onFolderDrop(el.dataset.path);
        },
        handleNewItemClick(el, event) {
            event.stopPropagation();
            this.dropdownTargetFolder = el.dataset.path;
            this.toggleNewDropdown(event);
        },
        handleRenameFolderClick(el, event) {
            event.stopPropagation();
            this.renameFolder(el.dataset.path, el.dataset.name);
        },
        handleDeleteFolderClick(el, event) {
            event.stopPropagation();
            this.deleteFolder(el.dataset.path, el.dataset.name);
        },
        
        // Item (note/media) handlers - read from dataset
        handleItemClick(el) {
            this.openItem(el.dataset.path, el.dataset.type);
        },
        handleItemHover(el, isEnter) {
            const path = el.dataset.path;
            if (path !== this.currentNote && path !== this.currentMedia) {
                el.style.backgroundColor = isEnter ? 'var(--bg-hover)' : 'transparent';
            }
        },
        handleDeleteItemClick(el, event) {
            event.stopPropagation();
            if (el.dataset.type !== 'note') {
                this.deleteMedia(el.dataset.path);
            } else {
                this.deleteNote(el.dataset.path, el.dataset.name);
            }
        },
        
        // =====================================================================
        // FOLDER TREE RENDERING
        // =====================================================================
        
        // Render folder recursively (helper for deep nesting)
        // Uses data-* attributes to store path/name, avoiding JS string escaping issues
        renderFolderRecursive(folder, level = 0, isTopLevel = false) {
            if (!folder) return '';
            
            let html = '';
            const isExpanded = this.expandedFolders.has(folder.path);
            const esc = (s) => this.escapeHtmlAttr(s); // Shorthand for HTML escaping
            
            // Render this folder's header
            // Note: Using native event handlers with data-* attributes instead of Alpine directives
            // because x-html doesn't process Alpine directives in dynamically generated content
            html += `
                <div>
                    <div 
                        data-path="${esc(folder.path)}"
                        data-name="${esc(folder.name)}"
                        draggable="true"
                        ondragstart="window.$root.onItemDragStart(this.dataset.path, 'folder', event)"
                        ondragend="window.$root.onItemDragEnd()"
                        ondragover="window.$root.handleFolderDragOver(this, event)"
                        ondragenter="window.$root.handleFolderDragOver(this, event)"
                        ondragleave="window.$root.handleFolderDragLeave(this)"
                        ondrop="window.$root.handleFolderDrop(this, event)"
                        onclick="window.$root.handleFolderClick(this)"
                        class="folder-item hover-accent px-2 py-1 text-sm relative"
                        style="color: var(--text-primary); cursor: pointer;"
                    >
                        <div class="flex items-center gap-1">
                            <button 
                                class="flex-shrink-0 w-4 h-4 flex items-center justify-center"
                                style="color: var(--text-tertiary); cursor: pointer; transition: transform 0.2s; pointer-events: none; margin-left: -5px; ${isExpanded ? 'transform: rotate(90deg);' : ''}"
                            >
                                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                                    <path d="M6 4l4 4-4 4V4z"/>
                                </svg>
                            </button>
                            <span class="flex items-center gap-1 flex-1" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; pointer-events: none;" title="${esc(folder.name)}">
                                <span>${esc(folder.name)}</span>
                                ${folder.notes.length === 0 && (!folder.children || Object.keys(folder.children).length === 0) ? `<span class="text-xs" style="color: var(--text-tertiary); font-weight: 400;">(${this.t('folders.empty')})</span>` : ''}
                            </span>
                        </div>
                        <div class="hover-buttons flex gap-1 transition-opacity absolute right-2 top-1/2 transform -translate-y-1/2" style="opacity: 0; pointer-events: none; background: linear-gradient(to right, transparent, var(--bg-hover) 20%, var(--bg-hover)); padding-left: 20px;" onclick="event.stopPropagation()">
                            <button 
                                data-path="${esc(folder.path)}"
                                onclick="window.$root.handleNewItemClick(this, event)"
                                class="px-1.5 py-0.5 text-xs rounded hover:brightness-110"
                                style="background-color: var(--bg-tertiary); color: var(--text-secondary);"
                                title="${esc(this.t('sidebar.new_note'))}"
                            >+</button>
                            <button 
                                data-path="${esc(folder.path)}"
                                data-name="${esc(folder.name)}"
                                onclick="window.$root.handleRenameFolderClick(this, event)"
                                class="px-1.5 py-0.5 text-xs rounded hover:brightness-110"
                                style="background-color: var(--bg-tertiary); color: var(--text-secondary);"
                                title="${esc(this.t('sidebar.rename_folder'))}"
                            >✏️</button>
                            <button 
                                data-path="${esc(folder.path)}"
                                data-name="${esc(folder.name)}"
                                onclick="window.$root.handleDeleteFolderClick(this, event)"
                                class="px-1 py-0.5 text-xs rounded hover:brightness-110"
                                style="color: var(--error);"
                                title="${esc(this.t('sidebar.delete_folder'))}"
                            >
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                                </svg>
                            </button>
                        </div>
                    </div>
            `;
            
            // If expanded, render folder contents (child folders + notes)
            if (isExpanded) {
                html += `<div class="folder-contents" style="padding-left: 10px;">`;
                
                // First, render child folders (if any)
                if (folder.children && Object.keys(folder.children).length > 0) {
                    const children = Object.entries(folder.children)
                        .filter(([k, v]) => !this.hideUnderscoreFolders || !v.name.startsWith('_'))
                        .sort((a, b) => this.getFolderSortComparator()(a[1], b[1]));

                    children.forEach(([childKey, childFolder]) => {
                        html += this.renderFolderRecursive(childFolder, 0, false);
                    });
                }
                
                // Then, render notes and images in this folder (after subfolders)
                if (folder.notes && folder.notes.length > 0) {
                    folder.notes.forEach(note => {
                        html += this.renderNoteItem(note);
                    });
                }
                
                html += `</div>`; // Close folder-contents
            }
            
            html += `</div>`; // Close folder wrapper
            return html;
        },
        
        // Render a single note/media item (used by both folders and root level)
        renderNoteItem(note) {
            const esc = (s) => this.escapeHtmlAttr(s);
            const isMediaFile = note.type !== 'note';
            const isCurrentNote = this.currentNote === note.path;
            const isCurrentMedia = this.currentMedia === note.path;
            const isCurrent = isMediaFile ? isCurrentMedia : isCurrentNote;
            
            // Share icon for shared notes
            const isShared = !isMediaFile && this.isNoteShared(note.path);
            const shareIcon = isShared ? `<svg aria-hidden="true" style="display: inline-block; width: 12px; height: 12px; vertical-align: middle; margin-right: 2px; opacity: 0.7;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${SHARE_ICON_PATH}"></path></svg>` : '';
            const icon = this.getMediaIcon(note.type);
            const deleteTitle = !isMediaFile
                ? this.t('toolbar.delete_note')
                : note.type === 'drawing'
                    ? this.t('toolbar.delete_drawing')
                    : this.t('toolbar.delete_image');
            
            return `
                <div 
                    data-path="${esc(note.path)}"
                    data-name="${esc(note.name)}"
                    data-type="${note.type}"
                    draggable="true"
                    ondragstart="window.$root.onItemDragStart(this.dataset.path, this.dataset.type || 'note', event)"
                    ondragend="window.$root.onItemDragEnd()"
                    onclick="window.$root.handleItemClick(this)"
                    class="note-item px-2 py-1 text-sm relative"
                    style="${isCurrent ? 'background-color: var(--accent-light); color: var(--accent-primary);' : 'color: var(--text-primary);'} ${isMediaFile ? 'opacity: 0.85;' : ''} cursor: pointer;"
                    onmouseover="window.$root.handleItemHover(this, true)"
                    onmouseout="window.$root.handleItemHover(this, false)"
                >
                    <span class="truncate" style="display: block; padding-right: 30px;" title="${esc(note.name)}">${shareIcon}${icon}${icon ? ' ' : ''}${esc(note.name)}</span>
                    <button 
                        data-path="${esc(note.path)}"
                        data-name="${esc(note.name)}"
                        data-type="${note.type}"
                        onclick="window.$root.handleDeleteItemClick(this, event)"
                        class="note-delete-btn absolute right-2 top-1/2 transform -translate-y-1/2 px-1 py-0.5 text-xs rounded hover:brightness-110 transition-opacity"
                        style="opacity: 0; color: var(--error);"
                        title="${esc(deleteTitle)}"
                    >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                </div>
            `;
        },
        
        // Render root-level items (notes and media not in any folder)
        renderRootItems() {
            const root = this.folderTree['__root__'];
            if (!root || !root.notes || root.notes.length === 0) {
                return '';
            }
            return root.notes.map(note => this.renderNoteItem(note)).join('');
        },
        
        // Toggle folder expansion
        toggleFolder(folderPath) {
            if (this.expandedFolders.has(folderPath)) {
                this.expandedFolders.delete(folderPath);
            } else {
                this.expandedFolders.add(folderPath);
            }
            // Force Alpine reactivity by creating new Set reference
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Check if folder is expanded
        isFolderExpanded(folderPath) {
            return this.expandedFolders.has(folderPath);
        },
        
        // Expand all folders
        expandAllFolders() {
            this.allFolders.forEach(folder => {
                this.expandedFolders.add(folder);
            });
            // Force Alpine reactivity
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Collapse all folders
        collapseAllFolders() {
            this.expandedFolders.clear();
            // Force Alpine reactivity
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Expand folder tree to show a specific note
        expandFolderForNote(notePath) {
            const parts = notePath.split('/');
            
            // If note is in root, no folders to expand
            if (parts.length <= 1) return;
            
            // Remove the note name (last part)
            parts.pop();
            
            // Build and expand all parent folders
            let currentPath = '';
            parts.forEach((part, index) => {
                currentPath = index === 0 ? part : `${currentPath}/${part}`;
                this.expandedFolders.add(currentPath);
            });
            
            // Force Alpine reactivity
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Scroll note into view in the sidebar navigation
        scrollNoteIntoView(notePath) {
            // Find the note element in the sidebar
            // Use a slight delay to ensure DOM is fully rendered with Alpine bindings applied
            setTimeout(() => {
                const sidebar = document.querySelector('.flex-1.overflow-y-auto.custom-scrollbar');
                if (!sidebar) return;
                
                const noteElements = sidebar.querySelectorAll('.note-item');
                let targetElement = null;
                const noteName = notePath.split('/').pop().replace('.md', '');
                
                // Find the element that corresponds to this note
                noteElements.forEach(el => {
                    // Check if this is a note element (not folder) by checking if it has the note name
                    if (el.textContent.trim().startsWith(noteName) || el.textContent.includes(noteName)) {
                        // Check computed style to see if it's highlighted
                        const computedStyle = window.getComputedStyle(el);
                        const bgColor = computedStyle.backgroundColor;
                        
                        // Check if background has the accent color (not transparent or default)
                        if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent' && !bgColor.includes('255, 255, 255')) {
                            targetElement = el;
                        }
                    }
                });
                
                // If found, scroll it into view
                if (targetElement) {
                    targetElement.scrollIntoView({ 
                        behavior: 'smooth', 
                        block: 'center',
                        inline: 'nearest'
                    });
                }
            }, 200); // Increased delay to ensure Alpine has finished rendering
        },
        
        // Unified drag and drop handlers for notes, folders, and media
        onItemDragStart(itemPath, itemType, event) {
            // Set unified drag state
            this.draggedItem = { path: itemPath, type: itemType };
            
            // Make drag image semi-transparent
            if (event.target) {
                event.target.style.opacity = '0.5';
            }
            
            event.dataTransfer.effectAllowed = 'all';
        },
        
        onItemDragEnd() {
            this.draggedItem = null;
            this.dropTarget = null;
            this.dragOverFolder = null;
            // Reset opacity of all draggable items
            document.querySelectorAll('.note-item, .folder-header').forEach(el => el.style.opacity = '1');
            // Reset drag-over class
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        },
        
        
        // Handle dragover on editor to show cursor position
        onEditorDragOver(event) {
            // Two sources land here: sidebar items (draggedItem set) and OS files.
            const isFileDrag = event.dataTransfer?.types?.includes('Files');
            if (!this.draggedItem && !isFileDrag) return;
            
            event.preventDefault();
            this.dropTarget = 'editor';
            if (isFileDrag) this.externalDragActive = true;
            
        },
        
        // Handle dragenter on editor
        onEditorDragEnter(event) {
            const isFileDrag = event.dataTransfer?.types?.includes('Files');
            if (!this.draggedItem && !isFileDrag) return;
            event.preventDefault();
            this.dropTarget = 'editor';
            if (isFileDrag) this.externalDragActive = true;
        },
        
        // Handle dragleave on editor
        onEditorDragLeave(event) {
            // Only clear dropTarget if we're actually leaving the editor
            // (not just moving between child elements)
            if (!event.currentTarget.contains(event.relatedTarget)) {
                this.dropTarget = null;
                this.externalDragActive = false;
            }
        },
        
        // Handle drop into editor to create internal link or upload media
        async onEditorDrop(event) {
            if (this.viewMode !== 'edit') return;
            // Already handled by the editor itself
            if (event.defaultPrevented) return;
            event.preventDefault();
            this.dropTarget = null;
            this.externalDragActive = false;
            
            // Check if files are being dropped (media from file system)
            if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
                await this.handleMediaDrop(event);
                return;
            }
            
            // Otherwise, handle note/media link drop from sidebar
            if (!this.draggedItem) return;
            
            const notePath = this.draggedItem.path;
            const isMediaFile = this.draggedItem.type !== 'note';
            
            let link;
            if (isMediaFile) {
                // For media files (images, audio, video, PDF), use wiki-style embed link
                link = `![[${this.relativeMediaPath(this.currentNote, notePath)}]]`;
            } else {
                // For notes, insert note link
                const noteName = notePath.split('/').pop().replace('.md', '');
                const encodedPath = notePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
                link = `[${noteName}](${encodedPath})`;
            }
            
            noteEditor?.insertMarkdown(link, this._editorDropPosition(event));
            
            this.draggedItem = null;
        },
        
        // With no note open, uploads go straight into the folder being viewed
        uploadFolder() {
            if (this.currentMedia) return this._folderFromPath(this.currentMedia);
            return this.selectedHomepageFolder || '';
        },
        
        // Handle media files dropped into editor
        async handleMediaDrop(event) {
            const position = this.currentNote ? this._editorDropPosition(event) : null;
            await this.uploadFiles(Array.from(event.dataTransfer.files), position);
        },
        
        // Open the file picker for the toolbar button and the / menu
        openAttachPicker() {
            if (this.currentNote) this.$refs.attachInput.click();
        },
        
        // Files chosen in the picker go in at the cursor
        async onAttachPicked(event) {
            const files = Array.from(event.target.files);
            event.target.value = '';  // or picking the same file again fires no change
            await this.uploadFiles(files, null);
        },
        
        // Upload media and import Markdown files, embedding each at `position`
        async uploadFiles(files, position) {
            // Filter for allowed media types
            const mediaFiles = files.filter(file => MEDIA_UPLOAD_TYPES.includes(file.type.toLowerCase()));
            // By extension: MIME for .md varies across browsers (text/markdown,
            // text/plain, or empty), so the name is the only reliable signal.
            const markdownFiles = files.filter(file => /\.md$/i.test(file.name || ''));
            
            if (mediaFiles.length === 0 && markdownFiles.length === 0) {
                this.toast(this.t('media.no_valid_files', { formats: MEDIA_FORMATS_DISPLAY }), { type: 'warning' });
                return;
            }
            
            const notePath = this.currentNote;
            
            for (const file of mediaFiles) {
                try {
                    const mediaPath = await this.uploadMedia(file, notePath);
                    // The note may have been switched during the upload
                    if (mediaPath && notePath && this.currentNote === notePath) {
                        await this.insertMediaMarkdown(mediaPath, file.name, position);
                    }
                } catch (error) {
                    ErrorHandler.handle(`upload file ${file.name}`, error);
                }
            }
            // uploadMedia already injects the file into this.notes optimistically.
            
            // Needs an open note: the target folder is derived from it.
            if (markdownFiles.length > 0 && this.currentNote) {
                for (const file of markdownFiles) {
                    try {
                        await this.importMarkdownFile(file, position);
                    } catch (error) {
                        ErrorHandler.handle(`import markdown ${file.name}`, error);
                    }
                }
            }
        },
        
        /**
         * Import a dropped .md file as a new note in the current note's folder, then insert
         * a `[Name](path)` link at position (same shape as sidebar note drops). Filename
         * collisions get a yyyymmddHHmmss suffix. Size cap comes from UPLOAD_MAX_NOTE_MB —
         * file.text() would otherwise OOM the browser on a huge drop.
         */
        async importMarkdownFile(file, position) {
            if (!this.currentNote) return;
            
            const maxBytes = this.uploadMaxNoteMb * 1024 * 1024;
            if (file.size > maxBytes) {
                console.warn(`Rejected markdown drop: ${file.name} is ${(file.size / 1024 / 1024).toFixed(2)}MB, limit is ${this.uploadMaxNoteMb}MB (UPLOAD_MAX_NOTE_MB).`);
                this.toast(this.t('media.upload_failed'), { type: 'warning' });
                return;
            }
            
            const rawStem = (file.name || '').replace(/\.md$/i, '').trim();
            const validation = FilenameValidator.validateFilename(rawStem);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'note'), { type: 'warning' });
                return;
            }
            const stem = validation.sanitized;
            
            const currentFolder = this.currentNote.includes('/')
                ? this.currentNote.substring(0, this.currentNote.lastIndexOf('/'))
                : '';
            
            const joinPath = (folder, filename) => folder ? `${folder}/${filename}` : filename;
            let targetPath = joinPath(currentFolder, `${stem}.md`);
            if (this.notePathTaken(targetPath)) {
                const ts = this._autoTitleTimestamp();
                targetPath = joinPath(currentFolder, `${stem}-${ts}.md`);
            }
            
            const content = await file.text();
            
            this._optimisticAddNote(targetPath, { content });
            if (currentFolder) this.expandedFolders.add(currentFolder);
            this._rebuildTreeAfterMutation();
            
            try {
                const response = await fetch(`/api/notes/${encodeVaultPath(targetPath)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content })
                });
                if (!response.ok) throw new Error('Server returned error');
            } catch (error) {
                this._optimisticRemoveNote(targetPath);
                this._rebuildTreeAfterMutation();
                throw error;
            }
            
            const noteName = targetPath.split('/').pop().replace(/\.md$/i, '');
            const encodedPath = targetPath.split('/').map(seg => encodeURIComponent(seg)).join('/');
            const link = `[${noteName}](${encodedPath})`;
            
            noteEditor?.insertMarkdown(link, position);
        },
        
        // Upload a media file (image, audio, video, PDF)
        // Use options.nextToNotes + options.contentFolder to save a new drawing PNG next to .md files (not in the note's attachment folder).
        async uploadMedia(file, notePath, options = {}) {
            const { nextToNotes, contentFolder } = options;
            const formData = new FormData();
            formData.append('file', file);
            if (nextToNotes) {
                formData.append('next_to_notes', '1');
                formData.append('content_folder', contentFolder != null ? contentFolder : '');
                formData.append('note_path', '');
            } else {
                formData.append('note_path', notePath || '');
                if (!notePath) formData.append('content_folder', this.uploadFolder());
            }
            
            const response = await fetch('/api/upload-media', {
                method: 'POST',
                body: formData
            });
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Upload failed');
            }
            const data = await response.json();
            // Drop the new file into the local note list so the wikilink
            // resolver finds it without a full /api/notes refresh.
            if (data.path) {
                this._optimisticAddNote(data.path, { size: file.size });
                this._rebuildTreeAfterMutation();
            }
            return data.path;
        },
        
        // Insert media markdown at cursor position using wiki-style syntax, with a
        // path relative to the note. The uploaded file is already in this.notes
        // thanks to uploadMedia()'s optimistic add.
        async insertMediaMarkdown(mediaPath, altText, position = null) {
            const filename = mediaPath.split('/').pop();
            const filenameWithoutExt = filename.replace(/\.[^/.]+$/, '');
            const altWithoutExt = altText.replace(/\.[^/.]+$/, '');
            const target = this.relativeMediaPath(this.currentNote, mediaPath);
            const markdown = (altWithoutExt && altWithoutExt !== filenameWithoutExt && !altWithoutExt.startsWith('pasted-image'))
                ? `![[${target}|${altWithoutExt}]]`
                : `![[${target}]]`;
            
            noteEditor?.insertMarkdown(markdown, position);
        },
        
        // Upload an image pasted into the editor and embed it at the cursor
        async pasteImage(blob) {
            if (!this.currentNote || !blob) return;
            
            try {
                // Create a simple filename - backend will add timestamp to prevent collisions
                const ext = blob.type.split('/')[1] || 'png';
                const filename = `pasted-image.${ext}`;
                
                // Create a File from the blob
                const file = new File([blob], filename, { type: blob.type });
                
                const mediaPath = await this.uploadMedia(file, this.currentNote);
                if (mediaPath) {
                    await this.insertMediaMarkdown(mediaPath, filename);
                }
            } catch (error) {
                ErrorHandler.handle('paste media', error);
            }
        },
        
        // Media type detection based on file extension (and drawing-*.png convention)
        getMediaType(filename) {
            if (!filename) return null;
            const base = filename.split('/').pop().toLowerCase();
            if (base.startsWith('drawing-') && base.endsWith('.png')) {
                return 'drawing';
            }
            const ext = filename.split('.').pop().toLowerCase();
            const mediaTypes = {
                image: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
                audio: ['mp3', 'wav', 'ogg', 'm4a'],
                video: ['mp4', 'webm', 'mov', 'avi'],
                document: ['pdf'],
            };
            for (const [type, extensions] of Object.entries(mediaTypes)) {
                if (extensions.includes(ext)) return type;
            }
            return null;
        },
        
        // Get icon for media type
        getMediaIcon(type) {
            const icons = {
                image: '🖼️',
                drawing: '✏️',
                audio: '🎵',
                video: '🎬',
                document: '📄',
            };
            return icons[type] || '';
        },
        
        // Open a note or media file (unified handler for sidebar/homepage clicks)
        openItem(path, type = 'note', searchHighlight = '') {
            this.showGraph = false;
            // Check if it's a media file by type or extension
            const mediaType = type !== 'note' ? type : this.getMediaType(path);
            if (mediaType && mediaType !== 'note') {
                this.viewMedia(path, mediaType);
            } else {
                this.loadNote(path, true, searchHighlight);
            }
        },
        
        // Tear down the media viewer. Every path that clears currentMedia goes through
        // here: currentMediaType drives the shared toolbar's undo/redo, so a leftover
        // 'drawing' would wire a note's undo button to drawingUndo().
        closeMediaViewer() {
            if (this.currentMediaType === 'drawing') {
                this._drawingDisconnectResizeObserver();
            }
            this.currentMedia = '';
            this.currentMediaType = 'image';
        },
        
        // View a media file (image, audio, video, PDF) in the main pane
        viewMedia(mediaPath, mediaType = null, updateHistory = true) {
            if (this.currentMediaType === 'drawing') {
                this._drawingDisconnectResizeObserver();
                this._drawingCancelAutosave();
            }
            this._commitPendingEdits();
            // Close mobile sidebar when a media file is selected, same as loadNote
            this.mobileSidebarOpen = false;
            this.showGraph = false; // Ensure graph is closed
            this.currentNote = '';
            this.currentNoteName = '';
            this.noteContent = '';
            this.currentMedia = mediaPath; // Reuse currentMedia for all media
            this.currentMediaType = mediaType || this.getMediaType(mediaPath) || 'image';
            this.shareInfo = null; // Reset share info
            
            // Update browser tab title
            const fileName = mediaPath.split('/').pop();
            document.title = `${fileName} - ${this.appName}`;
            
            // Expand folder tree to show the media file
            this.expandFolderForNote(mediaPath);
            
            // Update browser URL
            if (updateHistory) {
                // Encode each path segment to handle special characters
                const encodedPath = mediaPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
                window.history.pushState(
                    { mediaPath: mediaPath },
                    '',
                    `/${encodedPath}`
                );
            }
            
            // Drawing: Alpine x-init on the canvas runs only on first mount; switching from one drawing
            // to another keeps currentMediaType === 'drawing', so we must reload the PNG here.
            if (this.currentMediaType === 'drawing') {
                this.$nextTick(() => {
                    this.initDrawingViewer();
                });
            }
        },
        
        // Backward compatibility alias
        viewImage(mediaPath, updateHistory = true) {
            this.viewMedia(mediaPath, 'image', updateHistory);
        },
        
        // Delete a media file (image, audio, video, PDF)
        async deleteMedia(mediaPath) {
            const filename = mediaPath.split('/').pop();
            const ok = await this.confirmModalAsk({
                message: this.t('media.confirm_delete', { name: filename }),
            });
            if (!ok) return;
            
            this._optimisticRemoveNote(mediaPath);
            this._rebuildTreeAfterMutation();
            if (this.currentMedia === mediaPath) this.currentMedia = '';
            
            try {
                const response = await fetch(`/api/notes/${encodeURIComponent(mediaPath)}`, {
                    method: 'DELETE'
                });
                if (!response.ok) throw new Error('Failed to delete media file');
                this.loadTrash();
            } catch (error) {
                ErrorHandler.handle('delete media', error);
                await this.loadNotes({ silent: true });
            }
        },
        
        /**
         * Create a blank drawing PNG and open it for editing. Target folder matches
         * "New note" / "New folder" from the same + menu.
         * @param {{docW?: number, docH?: number}} [opts] Intrinsic size in document px.
         */
        async createNewDrawing(opts = {}) {
            const targetFolder = this.inferredNewItemTargetFolder();
            this.closeDropdown();
            const w = this._drawingClampDim(opts.docW, CONFIG.DRAWING_DEFAULT_DOC_W);
            const h = this._drawingClampDim(opts.docH, CONFIG.DRAWING_DEFAULT_DOC_H);
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = CONFIG.DRAWING_BACKGROUND;
            ctx.fillRect(0, 0, w, h);
            let blob;
            try {
                blob = await new Promise((resolve, reject) => {
                    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
                });
            } catch (e) {
                ErrorHandler.handle('create drawing', e);
                return;
            }
            const file = new File([blob], 'drawing.png', { type: 'image/png' });
            try {
                const path = await this.uploadMedia(file, '', {
                    nextToNotes: true,
                    contentFolder: targetFolder,
                });
                // Server returns the final upload path (may differ from
                // 'drawing.png' if it added a timestamp suffix).
                this._optimisticAddNote(path, { type: 'image', size: blob.size });
                this._rebuildTreeAfterMutation();
                this.viewMedia(path, 'drawing');
            } catch (error) {
                ErrorHandler.handle('create drawing', error);
                await this.loadNotes({ silent: true });
            }
        },
        
        _drawingEncodeMediaPath() {
            return this.currentMedia.split('/').map((s) => encodeURIComponent(s)).join('/');
        },

        /**
         * Clamp a dimension to the [MIN, MAX] document-px range. Falls back to `fallback`
         * when value is missing, non-finite or non-positive. Always returns an integer.
         */
        _drawingClampDim(value, fallback) {
            const n = Number(value);
            if (!Number.isFinite(n) || n <= 0) return Math.round(fallback);
            const clamped = Math.min(
                CONFIG.DRAWING_MAX_DOC_DIM,
                Math.max(CONFIG.DRAWING_MIN_DOC_DIM, n)
            );
            return Math.round(clamped);
        },

        /**
         * Convert a pointer event to DOCUMENT-space coordinates (0..drawingDocW, 0..drawingDocH).
         * The mapping is independent of CSS size, DPR and zoom — strokes stored from this
         * function render identically on any device and round-trip cleanly through PNG export.
         */
        _drawingCanvasCoords(event) {
            const canvas = this._drawingCanvasEl;
            if (!canvas) return { x: 0, y: 0 };
            const rect = canvas.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
            return {
                x: ((event.clientX - rect.left) / rect.width)  * this.drawingDocW,
                y: ((event.clientY - rect.top)  / rect.height) * this.drawingDocH,
            };
        },
        
        _drawingDrawOp(ctx, op) {
            if (!op) return;
            if (op.type === 'fill') {
                if (op.bitmap) {
                    ctx.drawImage(op.bitmap, op.x, op.y);
                }
                return;
            }
            if (op.type === 'text') {
                const text = op.text;
                if (typeof text !== 'string' || text === '') return;
                ctx.save();
                ctx.fillStyle = op.color;
                ctx.font = `${op.fontSize}px sans-serif`;
                ctx.textBaseline = 'top';
                ctx.fillText(text, op.x, op.y);
                ctx.restore();
                return;
            }
            if (op.type === 'stroke') {
                const pts = op.points;
                if (!pts || pts.length < 2) return;
                ctx.save();
                ctx.strokeStyle = op.color;
                ctx.lineWidth = op.lineWidth;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.beginPath();
                ctx.moveTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length; i++) {
                    ctx.lineTo(pts[i][0], pts[i][1]);
                }
                ctx.stroke();
                ctx.restore();
                return;
            }
            ctx.save();
            ctx.strokeStyle = op.color;
            ctx.lineWidth = op.lineWidth;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            if (op.type === 'line') {
                ctx.beginPath();
                ctx.moveTo(op.x1, op.y1);
                ctx.lineTo(op.x2, op.y2);
                ctx.stroke();
            } else if (op.type === 'rect') {
                const nx = op.w < 0 ? op.x + op.w : op.x;
                const ny = op.h < 0 ? op.y + op.h : op.y;
                ctx.strokeRect(nx, ny, Math.abs(op.w), Math.abs(op.h));
            } else if (op.type === 'ellipse') {
                const nx = op.w < 0 ? op.x + op.w : op.x;
                const ny = op.h < 0 ? op.y + op.h : op.y;
                const rw = Math.abs(op.w) / 2;
                const rh = Math.abs(op.h) / 2;
                const cx = nx + rw;
                const cy = ny + rh;
                ctx.beginPath();
                ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.restore();
        },
        
        /**
         * Repaint the visible canvas. All drawing math runs in DOCUMENT space; a single
         * setTransform call maps (docW, docH) → device pixels by combining the doc→display
         * scale with the device pixel ratio. _drawingDrawOp itself is space-agnostic.
         */
        drawingRedraw() {
            const canvas = this._drawingCanvasEl;
            const ctx = this._drawingCtx;
            if (!canvas || !ctx) return;
            const docW = this.drawingDocW;
            const docH = this.drawingDocH;
            const cssW = this._drawingCssW;
            const cssH = this._drawingCssH;
            const dpr = this._drawingDpr || 1;
            if (!docW || !docH || !cssW || !cssH) return;
            const sx = (cssW / docW) * dpr;
            const sy = (cssH / docH) * dpr;
            ctx.setTransform(sx, 0, 0, sy, 0, 0);
            ctx.clearRect(0, 0, docW, docH);
            ctx.fillStyle = CONFIG.DRAWING_BACKGROUND;
            ctx.fillRect(0, 0, docW, docH);
            if (this._drawingBaseImage && this._drawingBaseImage.complete) {
                ctx.drawImage(this._drawingBaseImage, 0, 0, docW, docH);
            }
            for (const op of this.drawingOps) {
                this._drawingDrawOp(ctx, op);
            }
            if (this.drawingDraft) {
                this._drawingDrawOp(ctx, this.drawingDraft);
            }
        },
        
        _drawingScheduleRedraw() {
            if (this._drawingRaf) return;
            this._drawingRaf = requestAnimationFrame(() => {
                this._drawingRaf = null;
                this.drawingRedraw();
            });
        },

        /**
         * Render current drawing state (background + base image + committed ops) to a fresh
         * off-screen canvas at the given doc size. Used by drawingSave() for a
         * device-independent PNG and by drawingFill() to sample at full resolution.
         * Returns the canvas, or null if no 2D context is available.
         */
        _drawingRenderToOffscreen(docW, docH) {
            const off = document.createElement('canvas');
            off.width = docW;
            off.height = docH;
            const ctx = off.getContext('2d');
            if (!ctx) return null;
            ctx.fillStyle = CONFIG.DRAWING_BACKGROUND;
            ctx.fillRect(0, 0, docW, docH);
            if (this._drawingBaseImage && this._drawingBaseImage.complete) {
                ctx.drawImage(this._drawingBaseImage, 0, 0, docW, docH);
            }
            for (const op of this.drawingOps) {
                this._drawingDrawOp(ctx, op);
            }
            return off;
        },
        
        _drawingDisconnectResizeObserver() {
            if (this._drawingResizeObserver) {
                try {
                    this._drawingResizeObserver.disconnect();
                } catch (_) {
                    /* ignore */
                }
                this._drawingResizeObserver = null;
            }
        },
        
        _drawingCancelAutosave() {
            if (this._drawingAutosaveTimeout) {
                clearTimeout(this._drawingAutosaveTimeout);
                this._drawingAutosaveTimeout = null;
            }
        },
        
        /**
         * Debounced PNG save (same delay as notes). Never runs while the primary button is held
         * (active stroke/shape); pending timers are cleared when a new stroke starts.
         */
        _drawingScheduleAutosave() {
            if (this.currentMediaType !== 'drawing' || !this.currentMedia) return;
            if (this._drawingAutosaveTimeout) {
                clearTimeout(this._drawingAutosaveTimeout);
                this._drawingAutosaveTimeout = null;
            }
            const path = this.currentMedia;
            const pollMs = 150;
            const attemptSave = () => {
                if (this.currentMedia !== path || this.currentMediaType !== 'drawing') {
                    this._drawingAutosaveTimeout = null;
                    return;
                }
                if (this.drawingIsPointerDown) {
                    this._drawingAutosaveTimeout = setTimeout(attemptSave, pollMs);
                    return;
                }
                this._drawingAutosaveTimeout = null;
                this.drawingSave();
            };
            this._drawingAutosaveTimeout = setTimeout(attemptSave, this.autosaveDelayMs);
        },
        
        /**
         * Letterbox (drawingDocW × drawingDocH) inside the available wrap, preserving aspect
         * ratio. Document space stays fixed; only the on-screen viewport scales, so a canvas
         * smaller than the wrap on narrow viewports is intentional.
         */
        _drawingLayoutCanvas() {
            const wrap = this.$refs.drawingCanvasWrap;
            const canvas = this.$refs.drawingCanvas;
            if (!wrap || !canvas || this.currentMediaType !== 'drawing') return;

            // Available area (with sane fallbacks for the brief moment before layout settles).
            let availW = wrap.clientWidth;
            let availH = wrap.clientHeight;
            if (availW < 32) {
                availW = Math.max(320, wrap.parentElement ? wrap.parentElement.clientWidth : 320);
            }
            if (availH < 32) {
                const col = wrap.closest('.flex-1.flex.flex-col') || wrap.closest('.flex-1');
                const h = col ? col.clientHeight : 0;
                availH = h > 64 ? h : Math.max(240, Math.floor((availW || 400) * 0.5));
            }

            // Letterbox the document into the available area.
            const docW = this.drawingDocW;
            const docH = this.drawingDocH;
            const docAspect = docW / docH;
            const wrapAspect = availW / availH;
            let cssW;
            let cssH;
            if (wrapAspect > docAspect) {
                cssH = availH;
                cssW = cssH * docAspect;
            } else {
                cssW = availW;
                cssH = cssW / docAspect;
            }

            const dpr = window.devicePixelRatio || 1;
            canvas.style.width  = `${cssW}px`;
            canvas.style.height = `${cssH}px`;
            // Backing store in device pixels — capped above by availW/availH * dpr, so this
            // never allocates more than the viewport could ever show. Cheap on every device.
            canvas.width  = Math.max(1, Math.round(cssW * dpr));
            canvas.height = Math.max(1, Math.round(cssH * dpr));

            this._drawingCanvasEl = canvas;
            this._drawingCssW = cssW;
            this._drawingCssH = cssH;
            this._drawingDpr = dpr;
            if (!this._drawingCtx) {
                this._drawingCtx = canvas.getContext('2d');
            }
            this.drawingRedraw();
        },
        
        async initDrawingViewer() {
            if (this.currentMediaType !== 'drawing' || !this.currentMedia) return;
            this._drawingDisconnectResizeObserver();
            await this.$nextTick();
            if (this._drawingObjectURL) {
                URL.revokeObjectURL(this._drawingObjectURL);
                this._drawingObjectURL = null;
            }
            const canvas = this.$refs.drawingCanvas;
            const wrap = this.$refs.drawingCanvasWrap;
            if (!canvas || !wrap) return;
            this._drawingCtx = canvas.getContext('2d');
            this._drawingDisposeOps(this.drawingOps);
            this._drawingDisposeOps(this.drawingRedoStack);
            this.drawingOps = [];
            this.drawingRedoStack = [];
            this.drawingDraft = null;
            this.drawingIsPointerDown = false;
            this.drawingTextActive = false;
            this.drawingTextValue = '';
            this._drawingBaseImage = null;
            this.drawingHasRasterFromFile = false;
            // Reset to defaults; replaced by the loaded PNG's natural size below.
            // For drawings created via createNewDrawing() the file already matches the defaults
            // (or the size requested by a future "new drawing" dialog).
            this.drawingDocW = CONFIG.DRAWING_DEFAULT_DOC_W;
            this.drawingDocH = CONFIG.DRAWING_DEFAULT_DOC_H;
            this._drawingLoadToken = Symbol();
            const token = this._drawingLoadToken;
            
            this._drawingResizeObserver = new ResizeObserver(() => {
                if (this.currentMediaType !== 'drawing' || !this.currentMedia) return;
                this._drawingLayoutCanvas();
            });
            this._drawingResizeObserver.observe(wrap);
            
            requestAnimationFrame(() => {
                if (token !== this._drawingLoadToken) return;
                this._drawingLayoutCanvas();
                requestAnimationFrame(() => {
                    if (token !== this._drawingLoadToken) return;
                    this._drawingLayoutCanvas();
                });
            });
            
            try {
                const enc = this._drawingEncodeMediaPath();
                const res = await fetch(`/api/media/${enc}`, { credentials: 'same-origin' });
                if (!res.ok) throw new Error('Failed to load drawing');
                const blob = await res.blob();
                if (token !== this._drawingLoadToken) return;
                const url = URL.createObjectURL(blob);
                this._drawingObjectURL = url;
                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = url;
                });
                if (token !== this._drawingLoadToken) return;
                this._drawingBaseImage = img;
                this.drawingHasRasterFromFile = true;
                // Adopt the PNG's intrinsic size as the document size for this drawing.
                // The PNG itself is the source of truth — no sidecar metadata required.
                this.drawingDocW = this._drawingClampDim(img.naturalWidth, CONFIG.DRAWING_DEFAULT_DOC_W);
                this.drawingDocH = this._drawingClampDim(img.naturalHeight, CONFIG.DRAWING_DEFAULT_DOC_H);
                this._drawingLayoutCanvas();
            } catch (e) {
                if (token !== this._drawingLoadToken) return;
                ErrorHandler.handle('load drawing', e);
                this.drawingHasRasterFromFile = false;
                this._drawingLayoutCanvas();
            }
        },
        
        _drawingRgbToHex(r, g, b) {
            const h = (n) => {
                const s = n.toString(16);
                return s.length === 1 ? `0${s}` : s;
            };
            return `#${h(r)}${h(g)}${h(b)}`;
        },

        _drawingHexToRgb(hex) {
            const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
            if (!m) return { r: 0, g: 0, b: 0 };
            return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
        },

        /**
         * Release the native bitmap memory backing any 'fill' ops in `ops`. Safe to call on a
         * mixed list (vector ops are skipped). Caller is responsible for clearing the array
         * itself afterwards if needed.
         */
        _drawingDisposeOps(ops) {
            if (!ops) return;
            for (const op of ops) {
                if (op && op.type === 'fill' && op.bitmap && typeof op.bitmap.close === 'function') {
                    try { op.bitmap.close(); } catch (_) { /* ignore */ }
                }
            }
        },

        /**
         * Iterative scanline flood fill on an ImageData buffer. Marks pixels connected to
         * (sx, sy) matching the seed color exactly (4-way). Returns the filled region's
         * bounding box, or null if the seed already equals the fill color so the caller can
         * skip a no-op undo entry. Stack-based, never recurses. If fills ever feel slow:
         * add tolerance, push run-starts only, and use a flat Int32Array stack.
         */
        _drawingFlood(imgData, sx, sy, fillRGB) {
            const { data, width: W, height: H } = imgData;
            if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
            const seedIdx = (sy * W + sx) * 4;
            const tR = data[seedIdx];
            const tG = data[seedIdx + 1];
            const tB = data[seedIdx + 2];
            const tA = data[seedIdx + 3];
            if (tR === fillRGB.r && tG === fillRGB.g && tB === fillRGB.b && tA === 255) {
                return null;
            }
            const mask = new Uint8Array(W * H);
            let minX = sx, minY = sy, maxX = sx, maxY = sy;
            const matches = (px, py) => {
                if (mask[py * W + px]) return false;
                const i = (py * W + px) * 4;
                return (
                    data[i] === tR &&
                    data[i + 1] === tG &&
                    data[i + 2] === tB &&
                    data[i + 3] === tA
                );
            };
            const stack = [[sx, sy]];
            while (stack.length) {
                const [x, y] = stack.pop();
                if (!matches(x, y)) continue;
                let lx = x;
                while (lx > 0 && matches(lx - 1, y)) lx--;
                let rx = x;
                while (rx < W - 1 && matches(rx + 1, y)) rx++;
                for (let i = lx; i <= rx; i++) {
                    mask[y * W + i] = 1;
                }
                if (lx < minX) minX = lx;
                if (rx > maxX) maxX = rx;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                if (y > 0) {
                    for (let i = lx; i <= rx; i++) {
                        if (matches(i, y - 1)) stack.push([i, y - 1]);
                    }
                }
                if (y < H - 1) {
                    for (let i = lx; i <= rx; i++) {
                        if (matches(i, y + 1)) stack.push([i, y + 1]);
                    }
                }
            }
            return { mask, minX, minY, maxX, maxY };
        },

        /**
         * Sample visible canvas color under the pointer; sets drawingColor.
         * Pointer coords come in document space; we map to device pixels via the canvas's
         * actual backing store (which already includes both the doc→display scale and DPR).
         */
        drawingSampleColor(e) {
            const canvas = this._drawingCanvasEl;
            const ctx = this._drawingCtx;
            if (!canvas || !ctx) return;
            const docW = this.drawingDocW;
            const docH = this.drawingDocH;
            if (!docW || !docH) return;
            const { x, y } = this._drawingCanvasCoords(e);
            this.drawingRedraw();
            let ix = Math.floor((x / docW) * canvas.width);
            let iy = Math.floor((y / docH) * canvas.height);
            ix = Math.max(0, Math.min(ix, canvas.width - 1));
            iy = Math.max(0, Math.min(iy, canvas.height - 1));
            const pix = ctx.getImageData(ix, iy, 1, 1).data;
            this.drawingColor = this._drawingRgbToHex(pix[0], pix[1], pix[2]);
        },

        /**
         * Paint-bucket flood fill at the click point. Renders current state to an off-screen
         * canvas at doc resolution, flood-fills from the clicked pixel, and stores only the
         * cropped delta as a 'fill' op so existing undo/redo works unchanged. Cropping keeps
         * memory proportional to filled area, not canvas area.
         */
        async drawingFill(e) {
            if (this.currentMediaType !== 'drawing' || !this.currentMedia) return;
            const docW = this._drawingClampDim(this.drawingDocW, CONFIG.DRAWING_DEFAULT_DOC_W);
            const docH = this._drawingClampDim(this.drawingDocH, CONFIG.DRAWING_DEFAULT_DOC_H);
            if (!docW || !docH) return;
            const { x, y } = this._drawingCanvasCoords(e);
            const sx = Math.floor(x);
            const sy = Math.floor(y);
            if (sx < 0 || sy < 0 || sx >= docW || sy >= docH) return;
            const off = this._drawingRenderToOffscreen(docW, docH);
            if (!off) return;
            const offCtx = off.getContext('2d');
            if (!offCtx) return;
            const imgData = offCtx.getImageData(0, 0, docW, docH);
            const fillRGB = this._drawingHexToRgb(this.drawingColor);
            const result = this._drawingFlood(imgData, sx, sy, fillRGB);
            // Clicked on a pixel that's already the fill color (or out of bounds): no-op.
            if (!result) return;
            const w = result.maxX - result.minX + 1;
            const h = result.maxY - result.minY + 1;
            const overlay = new ImageData(w, h);
            const ovData = overlay.data;
            const { mask } = result;
            for (let py = 0; py < h; py++) {
                const srcRow = (result.minY + py) * docW + result.minX;
                const dstRow = py * w * 4;
                for (let px = 0; px < w; px++) {
                    if (mask[srcRow + px]) {
                        const di = dstRow + px * 4;
                        ovData[di] = fillRGB.r;
                        ovData[di + 1] = fillRGB.g;
                        ovData[di + 2] = fillRGB.b;
                        ovData[di + 3] = 255;
                    }
                }
            }
            let bitmap;
            try {
                bitmap = await createImageBitmap(overlay);
            } catch (err) {
                ErrorHandler.handle('drawing fill', err);
                return;
            }
            // Drawing may have closed (navigation, clear) while createImageBitmap awaited.
            if (this.currentMediaType !== 'drawing' || !this.currentMedia) {
                try { bitmap.close(); } catch (_) { /* ignore */ }
                return;
            }
            this._drawingCancelAutosave();
            this._drawingDisposeOps(this.drawingRedoStack);
            this.drawingRedoStack = [];
            this.drawingOps.push({
                type: 'fill',
                x: result.minX,
                y: result.minY,
                bitmap,
            });
            this.drawingRedraw();
            this._drawingScheduleAutosave();
        },

        /** True when there is a loaded bitmap and/or session strokes to clear away. */
        drawingClearEnabled() {
            if (this.currentMediaType !== 'drawing') return false;
            return !!(this.drawingHasRasterFromFile || (this.drawingOps && this.drawingOps.length > 0));
        },

        /**
         * Replace the in-memory drawing with a blank canvas and schedule save so the file on disk
         * becomes a fresh white PNG (same dimensions as the viewer). Drops the loaded raster.
         */
        async drawingClear() {
            if (this.currentMediaType !== 'drawing' || !this.currentMedia) return;
            if (!this._drawingBaseImage && this.drawingOps.length === 0) return;
            const ok = await this.confirmModalAsk({
                title: this.t('drawing.clear_title'),
                message: this.t('drawing.clear_confirm'),
                danger: true,
                confirmLabel: this.t('drawing.clear'),
            });
            if (!ok) return;
            this._drawingCancelAutosave();
            if (this._drawingObjectURL) {
                try {
                    URL.revokeObjectURL(this._drawingObjectURL);
                } catch (_) {
                    /* ignore */
                }
                this._drawingObjectURL = null;
            }
            this._drawingBaseImage = null;
            this.drawingHasRasterFromFile = false;
            this.drawingDraft = null;
            this.drawingIsPointerDown = false;
            this._drawingDisposeOps(this.drawingOps);
            this._drawingDisposeOps(this.drawingRedoStack);
            this.drawingOps = [];
            this.drawingRedoStack = [];
            this.drawingTextActive = false;
            this.drawingTextValue = '';
            this.drawingRedraw();
            this._drawingScheduleAutosave();
        },

        drawingPointerDown(e) {
            if (this.currentMediaType !== 'drawing' || e.button !== 0) return;
            const canvas = this._drawingCanvasEl;
            if (!canvas) return;
            const tool = this.drawingTool;
            if (tool === 'eyedropper') {
                e.preventDefault();
                this.drawingSampleColor(e);
                return;
            }
            if (tool === 'fill') {
                e.preventDefault();
                this.drawingFill(e);
                return;
            }
            if (tool === 'text') {
                e.preventDefault();
                this.drawingTextStart(e);
                return;
            }
            this._drawingCancelAutosave();
            canvas.setPointerCapture(e.pointerId);
            this._drawingPointerId = e.pointerId;
            const { x, y } = this._drawingCanvasCoords(e);
            this.drawingIsPointerDown = true;
            this._drawingDisposeOps(this.drawingRedoStack);
            this.drawingRedoStack = [];
            const lw = this.drawingLineWidth;
            const color = tool === 'eraser' ? CONFIG.DRAWING_BACKGROUND : this.drawingColor;
            if (tool === 'freehand' || tool === 'eraser') {
                this.drawingDraft = { type: 'stroke', color, lineWidth: lw, points: [[x, y]] };
            } else if (tool === 'line') {
                this.drawingDraft = { type: 'line', color, lineWidth: lw, x1: x, y1: y, x2: x, y2: y };
            } else if (tool === 'rect') {
                this.drawingDraft = { type: 'rect', color, lineWidth: lw, x, y, w: 0, h: 0 };
            } else if (tool === 'ellipse') {
                this.drawingDraft = { type: 'ellipse', color, lineWidth: lw, x, y, w: 0, h: 0 };
            }
            this.drawingRedraw();
        },
        
        drawingPointerMove(e) {
            if (!this.drawingIsPointerDown || this.currentMediaType !== 'drawing') return;
            const { x, y } = this._drawingCanvasCoords(e);
            const d = this.drawingDraft;
            if (!d) return;
            if (d.type === 'stroke') {
                const pts = d.points;
                const last = pts[pts.length - 1];
                const dx = x - last[0];
                const dy = y - last[1];
                if (dx * dx + dy * dy < 1) return;
                pts.push([x, y]);
                this._drawingScheduleRedraw();
                return;
            }
            if (d.type === 'line') {
                d.x2 = x;
                d.y2 = y;
            } else if (d.type === 'rect' || d.type === 'ellipse') {
                d.w = x - d.x;
                d.h = y - d.y;
            }
            this._drawingScheduleRedraw();
        },
        
        drawingPointerUp(e) {
            if (!this.drawingIsPointerDown || this.currentMediaType !== 'drawing') return;
            const canvas = this._drawingCanvasEl;
            if (canvas && this._drawingPointerId === e.pointerId) {
                try {
                    canvas.releasePointerCapture(e.pointerId);
                } catch (_) {
                    /* ignore */
                }
            }
            this._drawingPointerId = null;
            this.drawingIsPointerDown = false;
            const d = this.drawingDraft;
            this.drawingDraft = null;
            if (!d) {
                this.drawingRedraw();
                return;
            }
            if (d.type === 'stroke') {
                if (!d.points || d.points.length < 2) {
                    this.drawingRedraw();
                    return;
                }
                this.drawingOps.push({
                    type: 'stroke',
                    color: d.color,
                    lineWidth: d.lineWidth,
                    points: d.points.slice(),
                });
            } else if (d.type === 'line') {
                const dx = d.x2 - d.x1;
                const dy = d.y2 - d.y1;
                if (dx * dx + dy * dy < 4) {
                    this.drawingRedraw();
                    return;
                }
                this.drawingOps.push({
                    type: 'line',
                    color: d.color,
                    lineWidth: d.lineWidth,
                    x1: d.x1,
                    y1: d.y1,
                    x2: d.x2,
                    y2: d.y2,
                });
            } else if (d.type === 'rect' || d.type === 'ellipse') {
                if (Math.abs(d.w) < 2 && Math.abs(d.h) < 2) {
                    this.drawingRedraw();
                    return;
                }
                this.drawingOps.push({
                    type: d.type,
                    color: d.color,
                    lineWidth: d.lineWidth,
                    x: d.x,
                    y: d.y,
                    w: d.w,
                    h: d.h,
                });
            }
            this.drawingRedraw();
            this._drawingScheduleAutosave();
        },
        
        drawingUndo() {
            if (this.drawingOps.length === 0) return;
            this.drawingRedoStack.push(this.drawingOps.pop());
            this.drawingRedraw();
            this._drawingScheduleAutosave();
        },
        
        drawingRedo() {
            if (this.drawingRedoStack.length === 0) return;
            this.drawingOps.push(this.drawingRedoStack.pop());
            this.drawingRedraw();
            this._drawingScheduleAutosave();
        },
        
        /**
         * Text tool — single-line, commit-once. Clicking spawns a floating input at the click
         * point; Enter or blur rasterizes it into a 'text' op (drawn in DOC space via
         * ctx.fillText so it scales with the canvas). Esc cancels. One op per commit, so
         * undo/redo needs no special handling.
         */
        drawingTextStart(e) {
            const canvas = this._drawingCanvasEl;
            if (!canvas) return;
            // If a previous input was still open (e.g. mobile pointerdown before blur fires),
            // commit it first so we never lose typed text.
            if (this.drawingTextActive) {
                this.drawingTextCommit();
            }
            // CSS coords are stored relative to the WRAP (the input's offset parent), not the
            // canvas: the wrap is a flex container that centers the canvas, so when the canvas
            // is narrower than the wrap there are gutters on either side that would otherwise
            // shift the floating input away from the click point.
            const wrap = this.$refs.drawingCanvasWrap || canvas.parentElement;
            const wrapRect = wrap.getBoundingClientRect();
            const { x: docX, y: docY } = this._drawingCanvasCoords(e);
            this.drawingTextDocX = docX;
            this.drawingTextDocY = docY;
            this.drawingTextCssX = e.clientX - wrapRect.left;
            this.drawingTextCssY = e.clientY - wrapRect.top;
            this.drawingTextDocFontSize = Math.max(14, this.drawingLineWidth * 6);
            this.drawingTextValue = '';
            this.drawingTextActive = true;
            this.drawingDraft = null;
            this.$nextTick(() => {
                const el = document.getElementById('drawing-text-input');
                if (!el) return;
                // Wipe any leftover text from a previous session before focusing — contenteditable
                // doesn't auto-clear from setting drawingTextValue alone.
                el.textContent = '';
                el.focus();
            });
        },
        
        /**
         * Normalize text-tool input: ctx.fillText renders line breaks as tofu, and Firefox
         * treats contenteditable="plaintext-only" as "true" so pasted newlines sneak into
         * textContent. Length is clamped so a giant paste can't bloat the op.
         */
        _drawingTextSanitize(s) {
            if (typeof s !== 'string' || s.length === 0) return '';
            const collapsed = s.replace(/[\r\n\t\v\f]+/g, ' ');
            return collapsed.length > 1024 ? collapsed.slice(0, 1024) : collapsed;
        },
        
        /**
         * Live preview for the text tool. The contenteditable div is transparent, so what the
         * user sees is drawingRedraw painting from drawingDraft — routing in-progress text
         * through the same ctx.fillText path as the commit guarantees zero pixel drift.
         */
        drawingTextOnInput(e) {
            if (!this.drawingTextActive) return;
            const text = this._drawingTextSanitize(e.target.textContent || '');
            this.drawingTextValue = text;
            if (text.length === 0) {
                this.drawingDraft = null;
            } else {
                this.drawingDraft = {
                    type: 'text',
                    color: this.drawingColor,
                    x: this.drawingTextDocX,
                    y: this.drawingTextDocY,
                    text,
                    fontSize: this.drawingTextDocFontSize,
                };
            }
            this._drawingScheduleRedraw();
        },
        
        drawingTextCommit() {
            if (!this.drawingTextActive) return;
            // Read straight from the DOM so we capture the very last keystroke even if the
            // @input event hasn't fired yet (it usually has, but Enter can race it).
            const el = document.getElementById('drawing-text-input');
            const raw = el ? (el.textContent || '') : (this.drawingTextValue || '');
            const text = this._drawingTextSanitize(raw).trim();
            const docX = this.drawingTextDocX;
            const docY = this.drawingTextDocY;
            const fontSize = this.drawingTextDocFontSize;
            const color = this.drawingColor;
            this.drawingTextActive = false;
            this.drawingTextValue = '';
            this.drawingDraft = null;
            if (el) el.textContent = '';
            if (!text) {
                this.drawingRedraw();
                return;
            }
            this._drawingDisposeOps(this.drawingRedoStack);
            this.drawingRedoStack = [];
            this.drawingOps.push({
                type: 'text',
                color,
                x: docX,
                y: docY,
                text,
                fontSize,
            });
            this.drawingRedraw();
            this._drawingScheduleAutosave();
        },
        
        drawingTextCancel() {
            if (!this.drawingTextActive) return;
            this.drawingTextActive = false;
            this.drawingTextValue = '';
            this.drawingDraft = null;
            const el = document.getElementById('drawing-text-input');
            if (el) el.textContent = '';
            this.drawingRedraw();
        },
        
        /**
         * Persist the flattened canvas to disk (Ctrl+S, autosave). Same feedback as saveNote:
         * header "Saved" only — never clears stroke undo/redo or reloads the image; stacks reset when
         * opening another drawing via initDrawingViewer().
         */
        async drawingSave() {
            if (!this.currentMedia || this.currentMediaType !== 'drawing') return;
            // Commit any in-progress text BEFORE the in-flight guard so the typed value
            // makes it into drawingOps before the next line wipes drawingDraft. Otherwise
            // Ctrl+S (or autosave) mid-typing would silently drop whatever the user just
            // typed from the saved PNG. drawingTextCommit will trigger another autosave,
            // but that's harmless — the next save just re-uploads the same bytes.
            if (this.drawingTextActive) {
                this.drawingTextCommit();
            }
            if (this._drawingSaveInFlight) {
                this._drawingSaveQueued = true;
                return;
            }
            this._drawingSaveInFlight = true;
            try {
                this._drawingCancelAutosave();
                this.drawingDraft = null;
                this.drawingIsPointerDown = false;
                // Render onto an off-screen canvas at the exact document size. This makes the
                // exported PNG byte-deterministic across devices: same ops, same dimensions →
                // identical bytes regardless of DPR, window size, or zoom level. The off-screen
                // canvas is allocated per save (microseconds for 1600×1000) so dimension changes
                // from a future "resize drawing" feature can never leak between saves.
                const docW = this._drawingClampDim(this.drawingDocW, CONFIG.DRAWING_DEFAULT_DOC_W);
                const docH = this._drawingClampDim(this.drawingDocH, CONFIG.DRAWING_DEFAULT_DOC_H);
                const off = this._drawingRenderToOffscreen(docW, docH);
                if (!off) return;
                // Keep the visible canvas in sync (cosmetic; UI doesn't have to wait for the upload).
                this.drawingRedraw();
                const blob = await new Promise((resolve, reject) => {
                    off.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
                });
                this.isSaving = true;
                try {
                    const enc = this._drawingEncodeMediaPath();
                    const res = await fetch(`/api/media/${enc}`, {
                        method: 'PUT',
                        body: blob,
                        headers: { 'Content-Type': 'image/png' },
                        credentials: 'same-origin',
                    });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        let detail = err.detail;
                        if (Array.isArray(detail)) {
                            detail = detail.map((d) => d.msg || d).join(', ');
                        }
                        throw new Error(detail || res.statusText);
                    }
                    // Drawing file already in this.notes — only metadata changed
                    // (size/mtime). Bump locally instead of a full /api/notes scan.
                    const rec = this.notes.find(n => n.path === this.currentMedia);
                    if (rec) {
                        rec.size = blob.size;
                        rec.modified = this._isoNow();
                    }
                    this.lastSaved = true;
                    setTimeout(() => {
                        this.lastSaved = false;
                    }, CONFIG.SAVE_INDICATOR_DURATION);
                } catch (error) {
                    ErrorHandler.handle('save drawing', error);
                } finally {
                    this.isSaving = false;
                }
            } finally {
                this._drawingSaveInFlight = false;
                if (this._drawingSaveQueued) {
                    this._drawingSaveQueued = false;
                    queueMicrotask(() => {
                        if (this.currentMedia && this.currentMediaType === 'drawing') {
                            this.drawingSave();
                        }
                    });
                }
            }
        },
        
        // Check if it's an external link or API path (media files, etc.)
        // Safe external protocols: http, https, mailto, tel, ssh, ftp, sftp, and app deep links
        _isExternalHref(href) {
            const externalProtocols = ['http://', 'https://', '//', 'mailto:', 'tel:', 'ssh:', 'ftp:', 'sftp:', 'slack:', 'discord:', 'teams:', 'vscode:', 'zoom:', 'whatsapp:', 'telegram:', 'signal:', 'spotify:', 'steam:', 'magnet:', '/api/'];
            return externalProtocols.some(p => href.startsWith(p));
        },
        
        // Open the note an internal href points to, offering to create it if missing
        _openInternalHref(href) {
            // Parse href into note path and anchor (e.g., "note.md#section" -> notePath="note.md", anchor="section")
            const decodedHref = decodeURIComponent(href);
            const hashIndex = decodedHref.indexOf('#');
            const rawPath = hashIndex !== -1 ? decodedHref.substring(0, hashIndex) : decodedHref;
            const anchor = hashIndex !== -1 ? decodedHref.substring(hashIndex + 1) : null;

            // Root-relative hrefs like /folder/note are vault paths with a slash bolted
            // on, and vault paths carry none. Protocol-relative //host already returned
            // above as external, so nothing here can be a host.
            const notePath = rawPath.replace(/^\/+/, '');
            
            // If it's just an anchor link (#heading), scroll within current note
            if (!notePath && anchor) {
                this.scrollToAnchor(anchor);
                return;
            }
            
            // Skip if no path
            if (!notePath) return;
            
            // Find the note by path (try exact match first, then with .md extension)
            let targetNote = this.notes.find(n => 
                n.path === notePath || 
                n.path === notePath + '.md'
            );
            
            if (!targetNote && this.currentNote) {
                // Resolve href relative to the current note's folder (standard
                // markdown behavior). Fixes `[X](sibling.md)` inside a subfolder
                // note — the vault-root exact match above misses it. Issue #262.
                const resolved = this.resolveMarkdownMediaPathForNote(this.currentNote, notePath);
                if (resolved && resolved !== notePath) {
                    const resolvedLower = resolved.toLowerCase();
                    targetNote = this.notes.find(n =>
                        n.path === resolved ||
                        n.path === resolved + '.md' ||
                        n.path.toLowerCase() === resolvedLower ||
                        n.path.toLowerCase() === resolvedLower + '.md'
                    );
                }
            }
            
            if (!targetNote) {
                // Try to find by name (in case link uses just the note name without path).
                // n.name stores the stem (no .md), so also compare against notePath
                // with any .md suffix stripped — otherwise `[X](FILE.md)` never
                // matches the "FILE" name. Issue #262.
                const notePathStem = notePath.replace(/\.md$/i, '');
                const notePathStemLower = notePathStem.toLowerCase();
                targetNote = this.notes.find(n => 
                    n.name === notePath || 
                    n.name === notePathStem ||
                    n.name.toLowerCase() === notePath.toLowerCase() ||
                    n.name.toLowerCase() === notePathStemLower
                );
            }
            
            if (!targetNote) {
                // Last resort: case-insensitive path matching
                targetNote = this.notes.find(n => 
                    n.path.toLowerCase() === notePath.toLowerCase() ||
                    n.path.toLowerCase() === (notePath + '.md').toLowerCase()
                );
            }
            
            if (targetNote) {
                // Load the note, then scroll to anchor if present
                this.loadNote(targetNote.path).then(() => {
                    if (anchor) {
                        // Small delay to ensure content is rendered
                        setTimeout(() => this.scrollToAnchor(anchor), 100);
                    }
                });
            } else {
                this.confirmModalAsk({
                    message: this.t('notes.create_from_link', { path: notePath }),
                    danger: false,
                    title: this.t('sidebar.new_note'),
                    confirmLabel: this.t('common.create'),
                }).then((ok) => {
                    if (ok) this.createNote(null, notePath);
                });
            }
        },
        
        // Scroll to an anchor (heading) by slug - reuses outline data
        scrollToAnchor(anchor) {
            // Normalize the anchor (GitHub-style slug)
            const targetSlug = anchor
                .toLowerCase()
                .replace(/[^\w\s-]/g, '')
                .replace(/\s+/g, '-')
                .replace(/-+/g, '-');
            
            // Find matching heading in outline
            const heading = this.outline.find(h => h.slug === targetSlug);
            
            if (heading) {
                this.scrollToHeading(heading);
            } else {
                // Fallback: try to find heading by exact text match
                const headingByText = this.outline.find(h => 
                    h.text.toLowerCase().replace(/\s+/g, '-') === anchor.toLowerCase()
                );
                if (headingByText) {
                    this.scrollToHeading(headingByText);
                }
            }
        },
        
        
        cancelDrag() {
            // Cancel any active drag operation (triggered by ESC key)
            this.draggedItem = null;
            this.dropTarget = null;
            this.dragOverFolder = null;
            // Reset styles - only query elements with drag-over class (more efficient)
            document.querySelectorAll('.folder-item').forEach(el => el.style.opacity = '1');
            document.querySelectorAll('.note-item').forEach(el => el.style.opacity = '1');
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        },
        
        async onFolderDrop(targetFolderPath) {
            // Ignore if we're dropping into the editor
            if (this.dropTarget === 'editor') {
                return;
            }
            
            // Capture dragged item info immediately (ondragend may clear it)
            if (!this.draggedItem) return;
            const { path: draggedPath, type: draggedType } = this.draggedItem;
            
            // Determine item category for endpoint selection
            const isFolder = draggedType === 'folder';
            const isNote = draggedType === 'note';
            const isMedia = !isFolder && !isNote; // image, audio, video, document
            
            // Handle folder drop
            if (isFolder) {
                // Prevent dropping folder into itself or its subfolders
                if (targetFolderPath === draggedPath || 
                    targetFolderPath.startsWith(draggedPath + '/')) {
                    this.toast(this.t('folders.cannot_move_into_self'), { type: 'warning' });
                    return;
                }
                
                const folderName = draggedPath.split('/').pop();
                const newPath = targetFolderPath ? `${targetFolderPath}/${folderName}` : folderName;
                
                if (newPath === draggedPath) return;
                
                const oldPrefix = draggedPath + '/';
                const newPrefix = newPath + '/';
                const wasExpanded = this.expandedFolders.has(draggedPath);
                
                this._optimisticRenameFolderTree(draggedPath, newPath);
                this._rebuildTreeAfterMutation();
                
                const favoritesInFolder = this.favorites.filter(f => f.startsWith(oldPrefix));
                if (favoritesInFolder.length > 0) {
                    const newFavorites = this.favorites.map(f =>
                        f.startsWith(oldPrefix) ? newPrefix + f.substring(oldPrefix.length) : f
                    );
                    this.favorites = newFavorites;
                    this.favoritesSet = new Set(newFavorites);
                    this.saveFavorites();
                }
                if (wasExpanded) {
                    this.expandedFolders.delete(draggedPath);
                    this.expandedFolders.add(newPath);
                    this.saveExpandedFolders();
                }
                if (this.currentNote && this.currentNote.startsWith(oldPrefix)) {
                    this.currentNote = newPrefix + this.currentNote.substring(oldPrefix.length);
                }
                
                try {
                    const response = await fetch('/api/folders/move', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ oldPath: draggedPath, newPath })
                    });
                    if (!response.ok) {
                        const errorData = await response.json().catch(() => ({}));
                        throw new Error(errorData.detail || this.t('move.failed_folder'));
                    }
                    await this.loadSharedNotePaths();
                } catch (error) {
                    console.error('Failed to move folder:', error);
                    this.toast(error.message || this.t('move.failed_folder'), { type: 'error' });
                    await this.loadNotes({ silent: true });
                }
                return;
            }
            
            // Handle note or media drop into folder
            const item = this.notes.find(n => n.path === draggedPath);
            if (!item) return;
            
            const filename = draggedPath.split('/').pop();
            const newPath = targetFolderPath ? `${targetFolderPath}/${filename}` : filename;
            
            if (newPath === draggedPath) return;
            
            const wasFavorited = isNote && this.favoritesSet.has(draggedPath);
            const wasCurrentNote = this.currentNote === draggedPath;
            const wasCurrentMedia = this.currentMedia === draggedPath;
            
            this._optimisticRenameNote(draggedPath, newPath);
            this._rebuildTreeAfterMutation();
            
            if (wasFavorited) {
                this.favorites = this.favorites.map(f => f === draggedPath ? newPath : f);
                this.favoritesSet = new Set(this.favorites);
                this.saveFavorites();
            }
            if (wasCurrentNote) this.currentNote = newPath;
            if (wasCurrentMedia) this.currentMedia = newPath;
            
            try {
                const endpoint = isMedia ? '/api/media/move' : '/api/notes/move';
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ oldPath: draggedPath, newPath })
                });
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const errorKey = isMedia ? 'move.failed_media' : 'move.failed_note';
                    throw new Error(errorData.detail || this.t(errorKey));
                }
                if (wasCurrentNote) noteEditor?.refreshRendered(['embed', 'image']);
                if (isNote) await this.loadSharedNotePaths();
            } catch (error) {
                console.error(`Failed to move ${isMedia ? 'media' : 'note'}:`, error);
                this.toast(error.message || this.t(isMedia ? 'move.failed_media' : 'move.failed_note'), { type: 'error' });
                await this.loadNotes({ silent: true });
            }
        },
        
        
        // Load a specific note
        async loadNote(notePath, updateHistory = true, searchQuery = '') {
            try {
                await this._commitPendingEdits();
                
                // Close mobile sidebar when a note is selected
                this.mobileSidebarOpen = false;

                const response = await fetch(`/api/notes/${encodeVaultPath(notePath)}`);
                
                // Check if note exists
                if (!response.ok) {
                    if (response.status === 404) {
                        // Note not found - silently redirect to home
                        window.history.replaceState({ homepageFolder: this.selectedHomepageFolder || '' }, '', '/');
                        this.currentNote = '';
                        this.noteContent = '';
                        this.noteBaseHash = null;
                        this.closeMediaViewer();
                        document.title = this.appName;
                        return;
                    }
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const data = await response.json();

                this.currentNote = notePath;
                this._scrollRestorePending = true;
                this.noteContent = data.content;
                this._showInEditor(data.content, { resetHistory: true });
                this.noteBaseHash = data.hash || null;
                // Note: scroll restoration happens later in the post-$nextTick block below
                // (where the existing scrollToTop call used to live), via _restoreNoteScroll().
                // Doing it there means a single, unified restore path instead of two racing
                // ones. See the post-$nextTick block for the full timing rationale.
                this.currentNoteName = notePath.split('/').pop().replace('.md', '');
                this.closeMediaViewer(); // Clear image viewer when loading a note
                this.shareInfo = null; // Reset share info for new note
                
                // Update browser tab title
                document.title = `${this.currentNoteName} - ${this.appName}`;
                this.lastSaved = false;
                
                // Extract outline for TOC panel
                this.extractOutline(data.content);

                // Store backlinks from API response
                this.backlinks = data.backlinks || [];

                // Update browser URL and history
                if (updateHistory) {
                    // Encode the path properly (spaces become %20, etc.)
                    const pathWithoutExtension = notePath.replace('.md', '');
                    // Encode each path segment to handle special characters
                    const encodedPath = pathWithoutExtension.split('/').map(segment => encodeURIComponent(segment)).join('/');
                    let url = `/${encodedPath}`;
                    // Add search query parameter if present
                    if (searchQuery) {
                        url += `?search=${encodeURIComponent(searchQuery)}`;
                    }
                    window.history.pushState(
                        { 
                            notePath: notePath, 
                            searchQuery: searchQuery,
                            homepageFolder: this.selectedHomepageFolder || '' // Save current folder state
                        },
                        '',
                        url
                    );
                }
                
                // Calculate stats if plugin enabled
                if (this.statsPluginEnabled) {
                    this.calculateStats();
                }
                
                // Parse frontmatter metadata
                this.parseMetadata();
                
                // Store search query for highlighting
                if (searchQuery) {
                    this.currentSearchHighlight = searchQuery;
                } else {
                    // Clear highlights if no search query
                    this.currentSearchHighlight = '';
                }
                
                // Expand folder tree to show the loaded note
                this.expandFolderForNote(notePath);
                
                // Use $nextTick twice to ensure Alpine.js has time to:
                // 1. First tick: expand folders and update DOM
                // 2. Second tick: highlight the note and setup everything else
                this.$nextTick(() => {
                    this.$nextTick(() => {
                        this.refreshDOMCache();
                        // On a later frame, once the note has laid out
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                this._restoreNoteScroll();
                                this._scrollRestorePending = false;
                            });
                        });

                        // Apply or clear search highlighting
                        if (searchQuery) {
                            this.highlightSearchTerm(searchQuery);
                        } else {
                            this.clearSearchHighlights();
                        }
                        
                        // Scroll note into view in sidebar if needed
                        this.scrollNoteIntoView(notePath);
                    });
                });
                
            } catch (error) {
                ErrorHandler.handle('load note', error);
            }
        },
        
        // Load item (note or media) from URL path
        loadItemFromURL() {
            // Get path from URL (e.g., /folder/note or /folder/image.png)
            let path = window.location.pathname;
            
            // Strip .md extension if present (for MKdocs/Zensical integration)
            if (path.toLowerCase().endsWith('.md')) {
                path = path.slice(0, -3);
                // Update URL bar to show clean path without .md
                window.history.replaceState(null, '', path);
            }
            
            // Skip if root path or static assets
            if (path === '/' || path.startsWith('/static/') || path.startsWith('/api/')) {
                return;
            }
            
            // Remove leading slash and decode URL encoding (e.g., %20 -> space)
            const decodedPath = decodeURIComponent(path.substring(1));
            
            // Check if this is a media file (image, audio, video, PDF)
            const matchedItem = this.notes.find(n => n.path === decodedPath);
            
            if (matchedItem && matchedItem.type !== 'note') {
                // It's a media file, view it
                this.viewMedia(decodedPath, matchedItem.type, false); // false = don't update history
            } else {
                // It's a note, add .md extension and load it
                const notePath = decodedPath + '.md';
                
                // Parse query string for search parameter
                const urlParams = new URLSearchParams(window.location.search);
                const searchParam = urlParams.get('search');
                
                // Try to load the note directly - the backend will handle 404 if it doesn't exist
                // This is more robust than checking the frontend notes list
                this.loadNote(notePath, false, searchParam || '');
                
                // If there's a search parameter, populate the search box and trigger search
                if (searchParam) {
                    this.searchQuery = searchParam;
                    // Trigger search to populate results list
                    this.searchNotes();
                }
            }
        },
        
        // Highlight search term in editor and preview
        highlightSearchTerm(query) {
            if (!query || !query.trim()) {
                this.clearSearchHighlights();
                return;
            }
            
            const searchTerm = query.trim();
            
            this.totalMatches = noteEditor?.highlight(
                (text) => this.findFoldedMatches(text, searchTerm)
            ) ?? 0;
            this.currentMatchIndex = this.totalMatches > 0 ? 0 : -1;
        },
        
        // Fold text the way the backend search does (case and accents ignored),
        // so a note found with "esparragos" also highlights "Espárragos".
        // ς and ß follow Python's casefold(), which the backend uses.
        foldForSearch(text) {
            return text.toLowerCase()
                .replace(/ς/g, 'σ')
                .replace(/ß/g, 'ss')
                .normalize('NFD')
                .replace(/\p{Mn}/gu, '');
        },
        
        // Find the term in the folded text and return [start, end] spans in the
        // original text, so the highlight covers the text as written. Folding can
        // change the length ("ß" becomes "ss", a combining accent disappears), so
        // each folded character remembers where it came from.
        findFoldedMatches(text, term, limit = Infinity) {
            const foldedTerm = this.foldForSearch(term);
            if (!foldedTerm) return [];
            
            let folded;
            let start = null;
            let end = null;
            if (/^[\x00-\x7f]*$/.test(text)) {
                folded = text.toLowerCase();
            } else {
                const parts = [];
                start = [];
                end = [];
                let i = 0;
                for (const ch of text) {
                    const foldedCh = this.foldForSearch(ch);
                    parts.push(foldedCh);
                    for (let k = 0; k < foldedCh.length; k++) {
                        start.push(i);
                        end.push(i + ch.length);
                    }
                    i += ch.length;
                }
                folded = parts.join('');
            }
            
            const spans = [];
            let pos = folded.indexOf(foldedTerm);
            while (pos !== -1 && spans.length < limit) {
                const matchEnd = pos + foldedTerm.length;
                if (start === null) {
                    spans.push([pos, matchEnd]);
                } else {
                    let stop = end[matchEnd - 1];
                    // Keep a combining accent with the letter it belongs to
                    while (stop < text.length && /\p{Mn}/u.test(text[stop])) {
                        stop++;
                    }
                    spans.push([start[pos], stop]);
                }
                pos = folded.indexOf(foldedTerm, matchEnd);
            }
            return spans;
        },
        
        // Navigate to next search match
        nextMatch() {
            if (this.totalMatches === 0) return;
            
            this.currentMatchIndex = (this.currentMatchIndex + 1) % this.totalMatches;
            noteEditor?.gotoMatch(this.currentMatchIndex);
        },
        
        // Navigate to previous search match
        previousMatch() {
            if (this.totalMatches === 0) return;
            
            this.currentMatchIndex = (this.currentMatchIndex - 1 + this.totalMatches) % this.totalMatches;
            noteEditor?.gotoMatch(this.currentMatchIndex);
        },
        
        // Clear search highlights
        clearSearchHighlights() {
            noteEditor?.highlight(null);
            this.totalMatches = 0;
            this.currentMatchIndex = -1;
        },
        
        // =====================================================
        // DROPDOWN MENU SYSTEM
        // =====================================================
        
        // Shift+click always forces the chooser regardless of newButtonAction.
        toggleNewDropdown(event) {
            const wantsChooser =
                (event && event.shiftKey) ||
                !this.newButtonAction ||
                this.newButtonAction === 'chooser';
            
            if (wantsChooser) {
                this._openNewDropdownChooser(event);
                return;
            }
            
            switch (this.newButtonAction) {
                case 'note':     this.createNote();         break;
                case 'folder':   this.createFolder();       break;
                case 'template': this.openTemplateModal();  break;
                case 'drawing':  this.createNewDrawing();   break;
                default:         this._openNewDropdownChooser(event);
            }
        },
        
        _openNewDropdownChooser(event) {
            this.showNewDropdown = true;
            
            if (event && event.target) {
                const rect = event.target.getBoundingClientRect();
                let top = rect.bottom + 4;
                let left = rect.left;
                
                const dropdownWidth = 200;
                const dropdownHeight = 150;
                if (left + dropdownWidth > window.innerWidth) {
                    left = rect.right - dropdownWidth;
                }
                if (top + dropdownHeight > window.innerHeight) {
                    top = rect.top - dropdownHeight - 4;
                }
                
                this.dropdownPosition = { top, left };
            }
        },
        
        openTemplateModal() {
            this.showNewDropdown = false;
            this.mobileSidebarOpen = false;
            const hasLastUsed = !!this.lastUsedTemplate &&
                this.availableTemplates.some(t => t.name === this.lastUsedTemplate);
            this.selectedTemplate = hasLastUsed ? this.lastUsedTemplate : '';
            this.newTemplateNoteName = this.autoFillNoteTitle ? this._autoTitleTimestamp() : '';
            this.showTemplateModal = true;
            // Only steal focus when the modal is one-Enter-away from submission.
            if (hasLastUsed) {
                this.$nextTick(() => {
                    const el = document.getElementById('template-note-name-input');
                    if (el) {
                        el.focus();
                        el.select();
                    }
                });
            }
        },
        
        closeDropdown() {
            this.showNewDropdown = false;
            this.dropdownTargetFolder = null; // Reset folder context
        },
        
        /**
         * Parent folder for new note/folder/drawing from the + menu when no explicit path is passed.
         * Same rules as the create-name modal: '' = vault root; otherwise a folder path (e.g. folder1/sub).
         */
        inferredNewItemTargetFolder() {
            if (this.dropdownTargetFolder !== null && this.dropdownTargetFolder !== undefined) {
                return this.dropdownTargetFolder;
            }
            return this.selectedHomepageFolder || '';
        },
        
        // =====================================================
        // UNIFIED CREATION FUNCTIONS (reusable from anywhere)
        // =====================================================
        
        // A new note is there to be written in, so leave read mode for it
        focusEditorForNewNote() {
            this.viewMode = 'edit';
            this.$nextTick(() => noteEditor?.focus());
        },
        
        async createNote(folderPath = null, directPath = null) {
            if (directPath) {
                const notePath = directPath.endsWith('.md') ? directPath : `${directPath}.md`;
                if (this.notePathTaken(notePath)) {
                    this.toast(this.t('notes.already_exists', { name: notePath }), { type: 'warning' });
                    return;
                }
                await this._finalizeCreateNote(notePath);
                return;
            }
            const explicitTarget = folderPath !== null && folderPath !== undefined ? folderPath : undefined;
            this.openCreateNameModal('note', explicitTarget);
        },
        
        /**
         * @param {'note'|'folder'} kind
         * @param {string|undefined} explicitTargetFolder - if set, use as parent folder context ("" = root)
         */
        openCreateNameModal(kind, explicitTargetFolder = undefined) {
            const targetFolder =
                explicitTargetFolder !== undefined ? explicitTargetFolder : this.inferredNewItemTargetFolder();
            this.closeDropdown();
            this.mobileSidebarOpen = false;
            this.createNameModalKind = kind;
            this.createNameModalTargetFolder = targetFolder;
            this.createNameModalInput =
                (kind === 'note' && this.autoFillNoteTitle) ? this._autoTitleTimestamp() : '';
            this.showCreateNameModal = true;
            this.$nextTick(() => {
                const el = document.getElementById('create-name-modal-input');
                if (el) {
                    el.focus();
                    el.select();
                }
            });
        },
        
        // Zettelkasten-style yyyymmddHHMMSS in local time.
        _autoTitleTimestamp() {
            const d = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
                   `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        },
        
        closeCreateNameModal() {
            this.showCreateNameModal = false;
            this.createNameModalInput = '';
        },
        
        cancelCreateNameModal() {
            this.closeCreateNameModal();
        },
        
        createNameModalHelpText() {
            const tf = this.createNameModalTargetFolder;
            if (this.createNameModalKind === 'note') {
                return tf
                    ? this.t('notes.prompt_name_in_folder', { folder: tf })
                    : this.t('notes.prompt_name_with_path');
            }
            return tf
                ? this.t('folders.prompt_name_in_folder', { folder: tf })
                : this.t('folders.prompt_name_with_path');
        },
        
        createNameModalTitle() {
            return this.createNameModalKind === 'note'
                ? this.t('sidebar.new_note')
                : this.t('sidebar.new_folder');
        },
        
        createNameModalLabel() {
            return this.createNameModalKind === 'note'
                ? this.t('notes.prompt_name')
                : this.t('folders.prompt_name');
        },
        
        async submitCreateNameModal() {
            const rawName = (this.createNameModalInput || '').trim();
            if (!rawName) {
                this.closeCreateNameModal();
                return;
            }
            const targetFolder = this.createNameModalTargetFolder;
            const kind = this.createNameModalKind;
            
            if (kind === 'note') {
                const validation = targetFolder
                    ? FilenameValidator.validateFilename(rawName)
                    : FilenameValidator.validatePath(rawName);
                if (!validation.valid) {
                    this.toast(this.getValidationErrorMessage(validation, 'note'), { type: 'warning' });
                    return;
                }
                const validatedName = validation.sanitized;
                const notePath = targetFolder
                    ? `${targetFolder}/${validatedName}.md`
                    : (validatedName.endsWith('.md') ? validatedName : `${validatedName}.md`);
                if (this.notePathTaken(notePath)) {
                    this.toast(this.t('notes.already_exists', { name: notePath }), { type: 'warning' });
                    return;
                }
                const ok = await this._finalizeCreateNote(notePath);
                if (ok) this.closeCreateNameModal();
                return;
            }
            
            const validation = targetFolder
                ? FilenameValidator.validateFilename(rawName)
                : FilenameValidator.validatePath(rawName);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'folder'), { type: 'warning' });
                return;
            }
            const validatedName = validation.sanitized;
            const folderPath = targetFolder ? `${targetFolder}/${validatedName}` : validatedName;
            const existingFolder = this.allFolders.find(folder => folder.toLowerCase() === folderPath.toLowerCase());
            if (existingFolder) {
                this.toast(this.t('folders.already_exists', { name: validatedName }), { type: 'warning' });
                return;
            }
            const ok = await this._finalizeCreateFolder(folderPath, targetFolder);
            if (ok) this.closeCreateNameModal();
        },
        
        async _finalizeCreateNote(notePath) {
            // Optimistic add — sidebar reflects the new note instantly. Server
            // confirms; on failure we resync silently.
            this._optimisticAddNote(notePath, { content: '' });
            const folderPart = notePath.includes('/') ? notePath.substring(0, notePath.lastIndexOf('/')) : '';
            if (folderPart) this.expandedFolders.add(folderPart);
            this._rebuildTreeAfterMutation();
            
            try {
                const response = await fetch(`/api/notes/${encodeVaultPath(notePath)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: '' })
                });
                if (!response.ok) throw new Error('Server returned error');
                await this.loadNote(notePath);
                this.focusEditorForNewNote();
                return true;
            } catch (error) {
                ErrorHandler.handle('create note', error);
                await this.loadNotes({ silent: true });
                return false;
            }
        },
        
        async _finalizeCreateFolder(folderPath, targetFolder) {
            this._optimisticAddFolder(folderPath);
            if (targetFolder) this.expandedFolders.add(targetFolder);
            this.expandedFolders.add(folderPath);
            this._rebuildTreeAfterMutation();
            
            try {
                const response = await fetch('/api/folders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: folderPath })
                });
                if (!response.ok) throw new Error('Server returned error');
                this.goToHomepageFolder(folderPath);
                return true;
            } catch (error) {
                ErrorHandler.handle('create folder', error);
                await this.loadNotes({ silent: true });
                return false;
            }
        },
        
        async createFolder(parentPath = null) {
            const explicitTarget = parentPath !== null && parentPath !== undefined ? parentPath : undefined;
            this.openCreateNameModal('folder', explicitTarget);
        },
        
        renameFolder(folderPath, currentName) {
            this.renameFolderPath = folderPath;
            this.renameFolderOldName = currentName;
            this.renameFolderInput = currentName;
            this.showRenameFolderModal = true;
            this.mobileSidebarOpen = false;
            this.$nextTick(() => {
                const el = document.getElementById('rename-folder-modal-input');
                if (el) {
                    el.focus();
                    el.select();
                }
            });
        },
        
        closeRenameFolderModal() {
            this.showRenameFolderModal = false;
            this.renameFolderPath = '';
            this.renameFolderOldName = '';
            this.renameFolderInput = '';
        },
        
        cancelRenameFolderModal() {
            this.closeRenameFolderModal();
        },
        
        /**
         * Theme-styled confirm dialog (replaces window.confirm).
         * @param {{ message: string, title?: string, danger?: boolean, confirmLabel?: string, cancelLabel?: string }} options
         * @returns {Promise<boolean>}
         */
        confirmModalAsk(options = {}) {
            const { message, title, danger = true, confirmLabel, cancelLabel } = options;
            return new Promise((resolve) => {
                this.confirmModalTitle = title || this.t('common.confirm_title');
                this.confirmModalMessage = message || '';
                this.confirmModalDanger = danger;
                this.confirmModalConfirmLabel = confirmLabel
                    || (danger ? this.t('common.delete') : this.t('common.ok'));
                this.confirmModalCancelLabel = cancelLabel || this.t('common.cancel');
                this._confirmModalResolve = resolve;
                this.showConfirmModal = true;
                this.mobileSidebarOpen = false;
            });
        },
        
        confirmModalConfirm() {
            this._confirmModalFinish(true);
        },
        
        confirmModalCancel() {
            this._confirmModalFinish(false);
        },
        
        _confirmModalFinish(ok) {
            if (!this._confirmModalResolve) return;
            this.showConfirmModal = false;
            const fn = this._confirmModalResolve;
            this._confirmModalResolve = null;
            fn(!!ok);
        },
        
        async submitRenameFolderModal() {
            const folderPath = this.renameFolderPath;
            const currentName = this.renameFolderOldName;
            const newName = (this.renameFolderInput || '').trim();
            if (!newName || newName === currentName) {
                this.closeRenameFolderModal();
                return;
            }
            
            const validation = FilenameValidator.validateFilename(newName);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'folder'), { type: 'warning' });
                return;
            }
            
            const validatedName = validation.sanitized;
            const pathParts = folderPath.split('/');
            pathParts[pathParts.length - 1] = validatedName;
            const newPath = pathParts.join('/');
            if (newPath !== folderPath && this.folderPathTaken(newPath)) {
                this.toast(this.t('folders.already_exists', { name: validatedName }), { type: 'warning' });
                return;
            }
            
            const ok = await this._finalizeRenameFolder(folderPath, newPath);
            if (ok) this.closeRenameFolderModal();
        },
        
        async _finalizeRenameFolder(folderPath, newPath) {
            const folderPrefix = folderPath + '/';
            const newFolderPrefix = newPath + '/';
            
            // Optimistic cascade: rewrite folder + every nested folder + every
            // note path. Sidebar reflects the rename instantly.
            this._optimisticRenameFolderTree(folderPath, newPath);
            this._rebuildTreeAfterMutation();
            
            if (this.expandedFolders.has(folderPath)) {
                this.expandedFolders.delete(folderPath);
                this.expandedFolders.add(newPath);
            }
            const newFavorites = this.favorites.map(f =>
                f.startsWith(folderPrefix) ? newFolderPrefix + f.substring(folderPrefix.length) : f
            );
            if (JSON.stringify(newFavorites) !== JSON.stringify(this.favorites)) {
                this.favorites = newFavorites;
                this.favoritesSet = new Set(newFavorites);
                this.saveFavorites();
            }
            if (this.currentNote && this.currentNote.startsWith(folderPrefix)) {
                this.currentNote = newFolderPrefix + this.currentNote.substring(folderPrefix.length);
            }
            
            try {
                const response = await fetch('/api/folders/rename', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ oldPath: folderPath, newPath: newPath })
                });
                if (!response.ok) throw new Error('Server returned error');
                await this.loadSharedNotePaths();
                return true;
            } catch (error) {
                ErrorHandler.handle('rename folder', error);
                await this.loadNotes({ silent: true });
                await this.loadSharedNotePaths();
                return false;
            }
        },
        
        // Delete folder (cascade: every nested folder + note)
        async deleteFolder(folderPath, folderName) {
            const ok = await this.confirmModalAsk({
                message: this.t('folders.confirm_delete', { name: folderName }),
            });
            if (!ok) return;
            
            const folderPrefix = folderPath + '/';
            
            this._optimisticRemoveFolderTree(folderPath);
            this._rebuildTreeAfterMutation();
            
            this.expandedFolders.delete(folderPath);
            const newFavorites = this.favorites.filter(f => !f.startsWith(folderPrefix));
            if (newFavorites.length !== this.favorites.length) {
                this.favorites = newFavorites;
                this.favoritesSet = new Set(newFavorites);
                this.saveFavorites();
            }
            if (this.currentNote && this.currentNote.startsWith(folderPrefix)) {
                this.currentNote = '';
                this.noteContent = '';
                document.title = this.appName;
            }
            
            try {
                const response = await fetch(`/api/folders/${encodeURIComponent(folderPath)}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' }
                });
                if (!response.ok) throw new Error('Server returned error');
                this.loadTagsDebounced();
                this.loadTrash();
            } catch (error) {
                ErrorHandler.handle('delete folder', error);
                await this.loadNotes({ silent: true });
            }
        },
        
        // Auto-save with debounce
        autoSave() {
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
            }
            
            this.lastSaved = false;
            
            // Calculate stats in real-time if plugin enabled
            if (this.statsPluginEnabled) {
                this.calculateStats();
            }
            
            // Parse metadata in real-time
            this.parseMetadata();
            
            // Update outline (TOC) in real-time
            this.extractOutline(this.noteContent);
            
            this.saveTimeout = setTimeout(() => {
                this.saveTimeout = null;
                this.saveNote();
            }, this.autosaveDelayMs);
        },
        
        // Create the editor. The mount lives inside an x-if, so this runs each time it appears.
        mountNoteEditor(element) {
            noteEditor?.destroy();
            this._editorMarkdown = this.noteContent;
            noteEditor = NoteEditor.create({
                element,
                markdown: this.noteContent,
                placeholder: () => this.t('editor.placeholder'),
                resolveImageSrc: (src) => this._editorImageSrc(src),
                onChange: (value) => this._onEditorChange(value),
                drawNode: (name, target, attrs) => this._drawNode(name, target, attrs),
                decorateCode: (pre) => this.addCopyButtonToCodeBlock(pre),
                onStateChange: ({ canUndo, canRedo, table, emptyLine, item, selection }) => {
                    this.canUndo = canUndo;
                    this.canRedo = canRedo;
                    this._updateItemPopup(item);
                    this._updateSelectionBubble(selection);
                    this._updateTablePopup(table);
                    this._updateAddButton(emptyLine);
                },
                onOpenLink: (event) => this.openEditorLink(event),
                onOpenWikilink: ({ target }) => this._openInternalHref(this._wikilinkHref(target)),
                onItemKey: (item, action) => {
                    const actions = this._itemPopupContent(item)?.actions;
                    (action === 'open' ? actions?.at(-1) : actions?.[0])?.run();
                },
                onInsertSource: () => this.openSourcePrompt(noteEditor?.itemAtSelection(), { isNew: true }),
                onTasksSet: ({ checked, changed, total }) => {
                    if (!changed) return;
                    this.toast(this.t(checked ? 'editor.tasks_all_checked' : 'editor.tasks_all_unchecked', { changed, total }));
                },
                onSuggest: (suggestion) => this.wlUpdate(suggestion),
                onSuggestKey: (event) => this.wlOnKeydown(event),
                onPasteImage: (file) => this.pasteImage(file),
                onDrop: (event) => {
                    if (!this.draggedItem && !event.dataTransfer?.files?.length) return false;
                    this.onEditorDrop(event);
                    return true;
                },
            });
            noteEditor.setEditable(this.viewMode === 'edit');
            const placePopups = () => {
                if (this.wikilinkAutocomplete.open) this.wlUpdatePosition();
                if (this.itemPopup.open || this._itemOutOfView) this._updateItemPopup(noteEditor?.itemAtSelection());
                this._updateSelectionBubble(noteEditor?.textSelection());
                this._updateTablePopup(noteEditor?.tableAtCursor());
                this._updateAddButton(noteEditor?.emptyLineAtCursor());
                if (this.turnIntoMenu.open) this._placeTurnIntoMenu();
            };
            element.addEventListener('scroll', () => {
                placePopups();
                this._rememberNoteScroll(element);
            });
            window.visualViewport?.addEventListener('resize', placePopups);
            window.visualViewport?.addEventListener('scroll', placePopups);
        },
        
        _onEditorChange(value) {
            this._editorMarkdown = value;
            if (value === this.noteContent) return;
            this.noteContent = value;
            this.autoSave();
        },
        
        _showInEditor(value, options) {
            this._editorMarkdown = value;
            noteEditor?.setMarkdown(value, options);
        },
        
        // Same mapping as the preview: local paths are served by /api/media/
        _editorImageSrc(src) {
            if (!src || /^(https?:)?\/\//.test(src) || src.startsWith('data:') || src.startsWith('/api/media/')) return src;
            const vaultRelative = this.currentNote
                ? this.resolveMarkdownMediaPathForNote(this.currentNote, src)
                : src.split('#')[0].split('?')[0];
            return `/api/media/${this.encodeVaultRelativePathForMediaApi(vaultRelative)}`;
        },
        
        _editorDropPosition(event) {
            return noteEditor?.positionAt(event.clientX, event.clientY) ?? null;
        },
        
        // Write out everything typed so far. Call before leaving a note: a timer that
        // fires afterwards would save the next note's content instead.
        async _commitPendingEdits() {
            noteEditor?.flush();
            if (this.saveTimeout) await this.saveNote();
            while (this.isSaving) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        },
        
        undo() {
            if (this.currentNote && this.viewMode === 'edit') noteEditor?.undo();
        },
        
        redo() {
            if (this.currentNote && this.viewMode === 'edit') noteEditor?.redo();
        },
        
        // Toolbar buttons and shortcuts
        formatText(type) {
            if (type === 'link') {
                this.openLinkPrompt(type);
                return;
            }
            if (type === 'attach') {
                this.openAttachPicker();
                return;
            }
            noteEditor?.format(type);
        },
        
        // The part of the page in view. An on-screen keyboard only shrinks the visual
        // viewport, so window.innerHeight still counts the space behind it.
        _visibleArea() {
            const viewport = window.visualViewport;
            const top = viewport?.offsetTop ?? 0;
            return { top, bottom: top + (viewport?.height ?? window.innerHeight) };
        },
        
        // Just below `rect`, or just above it when there's no room. Above, the popup hangs
        // from its bottom edge, so its real height only matters for fitting it at all.
        _popupPosition(rect, height = 46) {
            const WIDTH = 340;
            const GAP = 6;
            const left = Math.max(4, Math.min(rect.left, window.innerWidth - WIDTH - 4));
            const area = this._visibleArea();
            if (rect.bottom + GAP + height <= area.bottom) return { top: rect.bottom + GAP, left, above: false };
            if (rect.top - GAP - height >= area.top) return { top: rect.top - GAP, left, above: true };
            return { top: Math.max(area.top + 4, area.bottom - height - 4), left, above: false };
        },
        
        _updateItemPopup(item) {
            const surface = document.getElementById('note-editor')?.getBoundingClientRect();
            // The item can scroll out of the editor while the popup is open
            const visible = item && surface && item.rect.bottom > surface.top && item.rect.top < surface.bottom;
            const content = visible ? this._itemPopupContent(item) : null;
            this._itemOutOfView = !!item && !visible;
            if (!content) {
                this.itemPopup.open = false;
                return;
            }
            this.itemPopup = { open: true, ...content, position: this._popupPosition(this._visibleRect(item.rect, surface)) };
        },
        
        // Above the selection, so it doesn't cover the lines being read next
        _updateSelectionBubble(selection) {
            const surface = document.getElementById('note-editor')?.getBoundingClientRect();
            const visible = selection && surface && selection.rect.bottom > surface.top && selection.rect.top < surface.bottom;
            if (this.turnIntoMenu.open && (!visible || selection.key !== this.turnIntoMenu.key)) this.turnIntoMenu.open = false;
            if (!visible) {
                if (this.selectionBubble.open) this.selectionBubble.open = false;
                return;
            }
            const { active, block, codeOnly, inTable } = selection;
            const HEIGHT = 40;
            const GAP = 6;
            // Phones show their own menu by the selection, which can't be turned off or moved
            if (window.matchMedia('(pointer: coarse)').matches) {
                const top = Math.min(this._visibleArea().bottom, surface.bottom) - GAP;
                this.selectionBubble = { open: true, active, block, codeOnly, inTable, position: { top, left: surface.left + GAP, above: true } };
                return;
            }
            const rect = this._visibleRect(selection.rect, surface);
            const position = rect.top - GAP - HEIGHT >= this._visibleArea().top
                ? { ...this._popupPosition(rect), top: rect.top - GAP, above: true }
                : this._popupPosition(rect, HEIGHT);
            this.selectionBubble = { open: true, active, block, codeOnly, inTable, position };
        },
        
        toggleTurnIntoMenu() {
            if (this.turnIntoMenu.open) {
                this.turnIntoMenu.open = false;
                return;
            }
            this.turnIntoMenu.key = noteEditor?.textSelection()?.key ?? '';
            this.turnIntoMenu.open = true;
            this._placeTurnIntoMenu();
        },
        
        _placeTurnIntoMenu() {
            const anchor = this.$refs.selectionBubble.getBoundingClientRect();
            const area = this._visibleArea();
            const maxHeight = Math.min(320, area.bottom - area.top - 8);
            this.turnIntoMenu.maxHeight = maxHeight;
            this.turnIntoMenu.position = this._popupPosition(anchor, maxHeight);
        },
        
        turnInto(type) {
            this.turnIntoMenu.open = false;
            noteEditor?.turnInto(type);
        },
        
        // Above the table when there's room there, otherwise next to the current cell.
        // One popup at a time, and never off screen, even with an on-screen keyboard up.
        _updateTablePopup(table) {
            const surface = document.getElementById('note-editor')?.getBoundingClientRect();
            const taken = this.selectionBubble.open || this.itemPopup.open || this.wikilinkAutocomplete.open;
            const visible = table && surface && table.rect.bottom > surface.top && table.rect.top < surface.bottom;
            if (taken || !visible) {
                if (this.tablePopup.open) this.tablePopup.open = false;
                return;
            }
            const WIDTH = 190;
            const HEIGHT = 40;
            const GAP = 6;
            const area = this._visibleArea();
            const minTop = Math.max(area.top, 0) + 4;
            const maxTop = area.bottom - HEIGHT - 4;
            const hasRoom = table.rect.top - GAP - HEIGHT >= Math.max(surface.top, minTop) && table.rect.top <= maxTop;
            let top = table.rect.top - GAP - HEIGHT;
            if (!hasRoom) {
                const position = this._popupPosition(table.cellRect, HEIGHT);
                top = position.above ? position.top - HEIGHT : position.top;
            }
            const anchor = hasRoom ? table.rect : table.cellRect;
            this.tablePopup = {
                open: true,
                top: Math.max(minTop, Math.min(top, maxTop)),
                left: Math.max(4, Math.min(anchor.left, window.innerWidth - WIDTH - 4)),
            };
        },
        
        // Left of the empty line, or at its right end when there's no margin for it
        _updateAddButton(rect) {
            const surface = document.getElementById('note-editor')?.getBoundingClientRect();
            const visible = rect && surface && rect.bottom > surface.top && rect.top < surface.bottom;
            if (!visible) {
                if (this.addButton.open) this.addButton.open = false;
                return;
            }
            const SIZE = window.matchMedia('(pointer: coarse)').matches ? 36 : 26;
            const GAP = 6;
            const hasMargin = rect.left - SIZE - GAP >= surface.left;
            this.addButton = {
                open: true,
                top: (rect.top + rect.bottom - SIZE) / 2,
                left: hasMargin ? rect.left - SIZE - GAP : surface.right - SIZE - GAP,
            };
        },
        
        // A tall item can be bigger than the editor, so only its visible part counts
        _visibleRect(rect, surface) {
            return {
                top: Math.max(rect.top, surface.top),
                bottom: Math.min(rect.bottom, surface.bottom),
                left: rect.left,
            };
        },
        
        // What the popup says about `item`, or null if there's nothing to offer
        _itemPopupContent(item) {
            const editable = this.viewMode === 'edit';
            const edit = (run) => (editable ? [{ label: this.t('editor.mode_edit'), run }] : []);
            const open = (run) => ({ label: this.t('format.open_link'), run });
            const { kind, attrs } = item;
            if (kind === 'link') {
                return {
                    label: attrs.href,
                    actions: [...edit(() => this.openLinkPrompt('link')), open(() => this.openLinkAddress(attrs.href))],
                };
            }
            if (kind === 'wikilink') {
                return {
                    label: attrs.target,
                    actions: [
                        ...edit(() => this.openWikilinkPrompt(item)),
                        open(() => this._openInternalHref(this._wikilinkHref(attrs.target))),
                    ],
                };
            }
            if (kind === 'embed' || kind === 'image') {
                const media = this._mediaInfo(kind, attrs);
                const actions = media ? this._mediaActions(media) : [];
                return actions.length ? { label: media.name, actions } : null;
            }
            const actions = edit(() => this.openSourcePrompt(noteEditor?.itemAtSelection()));
            return actions.length ? { label: this._sourceLabel(kind), actions } : null;
        },
        
        _sourceLabel(kind) {
            return this.t(kind === 'mermaidBlock' ? 'embed.diagram' : 'embed.formula');
        },
        
        _mediaActions(media) {
            const actions = [];
            if (media.local) {
                actions.push({ label: this.t('embed.download'), run: () => this._downloadMedia(media) });
            }
            if (media.local || /^(https?:)?\/\//.test(media.url)) {
                actions.push({ label: this.t('embed.open_new_tab'), run: () => window.open(media.url, '_blank', 'noopener') });
            }
            return actions;
        },
        
        _downloadMedia({ url, name }) {
            const link = document.createElement('a');
            link.href = url;
            link.download = name;
            document.body.appendChild(link);
            link.click();
            link.remove();
        },
        
        // Where a media item lives and how to show it, or null for a file that isn't there
        _mediaInfo(kind, attrs) {
            let url;
            let name;
            let spec;
            if (kind === 'embed') {
                const mediaPath = this.resolveMediaWikilink(attrs.target.trim());
                if (!mediaPath) return null;
                url = `/api/media/${this.encodeVaultRelativePathForMediaApi(mediaPath)}`;
                name = attrs.target.trim().split('/').pop();
                spec = parseImageSizeSpec(attrs.alias || '', { allowSolo: true });
            } else {
                url = this._editorImageSrc(attrs.src);
                if (!url) return null;
                spec = parseImageSizeSpec(attrs.alt || '');
                name = url.startsWith('data:') ? (spec.alt || 'image') : this._fileNameOfUrl(url);
            }
            return {
                ...spec,
                url,
                name,
                alt: spec.alt || name.replace(/\.[^/.]+$/, ''),
                type: url.startsWith('data:') ? 'image' : (this.getMediaType(url.split(/[?#]/)[0]) || 'image'),
                local: this.safeMediaApiSrc(url) !== null,
            };
        },
        
        _fileNameOfUrl(url) {
            const last = url.split(/[?#]/)[0].split('/').pop();
            try {
                return decodeURIComponent(last);
            } catch (e) {
                return last;
            }
        },
        
        // Same href the wikilink would have as a link: absolute, because it names a note
        // rather than a location. Left as written if missing: that's what gets offered for creation.
        _wikilinkHref(target) {
            const hashIndex = target.indexOf('#');
            const base = hashIndex === -1 ? target : target.slice(0, hashIndex);
            const anchor = hashIndex === -1 ? '' : target.slice(hashIndex);
            const resolved = base ? this.resolveWikiLink(base.trim()) : null;
            return encodeURI(resolved !== null ? `/${resolved}${anchor}` : target);
        },
        
        // ---- Drawing the items the editor can't render itself ----
        // Each may run again on the same element when the item changes.
        
        _drawNode(name, element, attrs) {
            if (name === 'wikilink') this._drawWikilink(element, attrs);
            else if (name === 'mathInline') this._drawMath(element, attrs.source, false);
            else if (name === 'mathBlock') this._drawMath(element, attrs.source, true);
            else if (name === 'mermaidBlock') this._drawMermaid(element, attrs.source);
            else this._drawMedia(element, name, attrs);
        },
        
        _drawWikilink(element, { target, alias }) {
            const base = target.split('#')[0].trim();
            element.textContent = alias || target;
            element.classList.toggle('wikilink-broken', !!base && this.resolveWikiLink(base) === null);
        },
        
        _drawMath(element, source, display) {
            if (!source) {
                element.textContent = this.t('embed.formula');
                return;
            }
            // Only ever this element: a page-wide pass would rewrite $ in the note's text.
            element.textContent = display ? `\\[${source}\\]` : `\\(${source}\\)`;
            mathQueue = mathQueue
                .then(() => MathJax.typesetPromise([element]))
                .then(() => {
                    // Unbalanced braces hide the closing delimiter, so MathJax leaves the text alone
                    if (!element.querySelector('mjx-container')) element.textContent = source;
                })
                .catch((error) => console.error('MathJax typesetting failed:', error));
        },
        
        async _drawMermaid(element, source) {
            element.dataset.drawing = source;
            if (!source) {
                element.textContent = this.t('embed.diagram');
                return;
            }
            const mermaid = await this._mermaidForTheme();
            if (!mermaid) {
                element.textContent = source;
                return;
            }
            const id = `mermaid-diagram-${++this._mermaidCount}`;
            try {
                const { svg } = await mermaid.render(id, source);
                if (element.dataset.drawing !== source) return; // Changed while rendering
                const container = document.createElement('div');
                container.className = 'mermaid-rendered';
                container.innerHTML = svg; // Built by Mermaid under securityLevel: 'strict'
                element.replaceChildren(container);
            } catch (error) {
                console.error('Mermaid rendering error:', error);
                document.getElementById(`d${id}`)?.remove(); // Mermaid leaves this behind on failure
                if (element.dataset.drawing !== source) return;
                const code = document.createElement('pre');
                code.textContent = source;
                const message = document.createElement('div');
                message.className = 'note-render-error';
                message.textContent = `⚠️ Mermaid diagram error: ${error.message}`;
                element.replaceChildren(code, message);
            }
        },
        
        // Mermaid, set up for the current theme, or null if it failed to load
        async _mermaidForTheme() {
            if (!(await this.loadMermaid())) return null;
            const theme = this.getThemeType() === 'light' ? 'default' : 'dark';
            // Only reinitialize if theme changed (performance optimization)
            if (this.lastMermaidTheme !== theme) {
                window.mermaid.initialize({
                    startOnLoad: false,
                    theme,
                    securityLevel: 'strict', // Use strict for better security
                    fontFamily: 'inherit',
                    // v11 changed useMaxWidth defaults - restore responsive behavior
                    flowchart: { useMaxWidth: true },
                    sequence: { useMaxWidth: true },
                    gantt: { useMaxWidth: true },
                    journey: { useMaxWidth: true },
                    timeline: { useMaxWidth: true },
                    class: { useMaxWidth: true },
                    state: { useMaxWidth: true },
                    er: { useMaxWidth: true },
                    pie: { useMaxWidth: true },
                    quadrantChart: { useMaxWidth: true },
                    requirement: { useMaxWidth: true },
                    mindmap: { useMaxWidth: true },
                    gitGraph: { useMaxWidth: true }
                });
                this.lastMermaidTheme = theme;
            }
            return window.mermaid;
        },
        
        _drawMedia(element, kind, attrs) {
            const media = this._mediaInfo(kind, attrs);
            // Redrawn whenever the file list reloads, which must not restart a playing video
            const key = media ? `${media.url}|${media.alt}|${media.width}|${media.height}` : `missing|${attrs.target}`;
            if (element.dataset.drawn === key) return;
            element.dataset.drawn = key;
            element.replaceChildren();
            
            if (!media) {
                const name = attrs.target || attrs.src || '';
                const type = this.getMediaType(name);
                const icon = { audio: '🎵', video: '🎬', document: '📄' }[type] || '🖼️';
                element.className = 'note-chip wikilink-broken';
                element.textContent = `${icon} ${name}`;
                return;
            }
            if (media.type === 'image' || media.type === 'drawing') {
                element.className = 'note-media';
                const image = document.createElement('img');
                image.setAttribute('src', media.url);
                image.setAttribute('alt', media.alt);
                image.setAttribute('title', media.alt);
                if (media.width) image.style.width = `${media.width}px`;
                if (media.height) image.style.height = `${media.height}px`;
                element.appendChild(image);
                return;
            }
            const embed = this.buildMediaEmbed(media.type, media.url, media.alt);
            if (!embed) {
                // External audio, video and PDFs are never embedded
                element.className = 'note-chip';
                element.textContent = `${media.type === 'document' ? '📄' : '🔗'} ${media.name}`;
                return;
            }
            element.className = 'note-media note-media-block';
            if (media.type === 'video') embed.querySelector('video').preload = 'metadata';
            if (media.type === 'document') {
                // Clicks inside the PDF never reach the page, so it needs something to click
                const bar = document.createElement('span');
                bar.className = 'note-media-bar';
                bar.textContent = `📄 ${media.name}`;
                element.appendChild(bar);
            }
            element.appendChild(embed);
        },
        
        // Ask for the source of a formula or diagram
        openSourcePrompt(item, { isNew = false } = {}) {
            if (!item) return;
            const surface = document.getElementById('note-editor')?.getBoundingClientRect();
            this.sourcePrompt = {
                open: true,
                label: this._sourceLabel(item.kind),
                value: item.attrs.source || '',
                isNew,
                position: this._popupPosition(surface ? this._visibleRect(item.rect, surface) : item.rect, 190),
            };
            this.$nextTick(() => document.getElementById('source-prompt-input')?.focus());
        },
        
        applySourcePrompt() {
            const source = this.sourcePrompt.value.trim();
            this.sourcePrompt.open = false;
            if (source) noteEditor?.updateSelectedNode({ source });
            else noteEditor?.deleteSelectedNode();
        },
        
        closeSourcePrompt() {
            this.sourcePrompt.open = false;
            if (this.sourcePrompt.isNew) noteEditor?.deleteSelectedNode();
            else noteEditor?.focus();
        },
        
        openWikilinkPrompt(item) {
            this.linkPrompt = {
                open: true,
                type: 'wikilink',
                href: item.attrs.target,
                canRemove: true,
                position: this._popupPosition(item.rect),
            };
            this._focusLinkPrompt();
        },
        
        // Ask for an address at the cursor, starting from the link already there
        openLinkPrompt(type) {
            if (!noteEditor) return;
            const { href, rect } = noteEditor.linkAtSelection();
            const existing = type === 'link' ? href : '';
            this.linkPrompt = {
                open: true,
                type,
                href: existing,
                canRemove: !!existing,
                position: this._popupPosition(rect),
            };
            this._focusLinkPrompt();
        },
        
        _focusLinkPrompt() {
            this.$nextTick(() => {
                const input = document.getElementById('link-prompt-input');
                input?.focus();
                input?.select();
            });
        },
        
        applyLinkPrompt() {
            const address = this.linkPrompt.href.trim();
            if (!address) {
                this.closeLinkPrompt();
                return;
            }
            const apply = {
                link: () => noteEditor?.setLink(address),
                // Anything else would change what the [[...]] means when it's read back
                wikilink: () => !/[[\]|\n]/.test(address) && noteEditor?.updateSelectedNode({ target: address }),
            };
            const applied = apply[this.linkPrompt.type]();
            if (!applied) {
                this.toast(this.t('format.invalid_link'), { type: 'warning' });
                return;
            }
            this.linkPrompt.open = false;
        },
        
        removeLinkFromPrompt() {
            if (this.linkPrompt.type === 'wikilink') noteEditor?.deleteSelectedNode();
            else noteEditor?.removeLink();
            this.linkPrompt.open = false;
        },
        
        closeLinkPrompt() {
            this.linkPrompt.open = false;
            noteEditor?.focus();
        },
        
        // Ctrl/Cmd+click on a link, or any click in read mode: otherwise it only places the cursor
        openEditorLink(event) {
            this.openLinkAddress(event.target.closest('a')?.getAttribute('href'));
        },
        
        openLinkAddress(href) {
            if (!href) return;
            if (this._isExternalHref(href)) window.open(href, '_blank', 'noopener');
            else this._openInternalHref(href);
        },
        
        // Save current note
        async saveNote({ keepalive = false } = {}) {
            if (!this.currentNote) return;
            // Pick up the last keystrokes. This save covers their autosave, so cancel it.
            noteEditor?.flush();
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }
            // The "changed elsewhere" prompt is open: nothing is written until the user chooses.
            if (this._saveConflictOpen) return;
            // One save at a time. A second request sent before the first returns would
            // carry a stale base_hash and trip the conflict check against our own write.
            if (this.isSaving) {
                this._saveQueued = true;
                return;
            }

            this.isSaving = true;
            const notePath = this.currentNote;

            try {
                // base_hash lets the server refuse (409) a write over a file that
                // changed on disk since we read it.
                const body = JSON.stringify({ content: this.noteContent, base_hash: this.noteBaseHash });
                const response = await fetch(`/api/notes/${encodeVaultPath(notePath)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                    // Outlives the page, but browsers refuse keepalive bodies over 64 KiB.
                    keepalive: keepalive && new Blob([body]).size < 60000
                });

                if (response.status === 409) {
                    const detail = await response.json();
                    if (notePath !== this.currentNote) {
                        // The user already moved to another note: its base hash is not ours to touch.
                        const name = notePath.split('/').pop().replace('.md', '');
                        this.toast(this.t('notes.save_conflict_unsaved', { name }), { type: 'warning' });
                        return;
                    }
                    // Nothing is in flight while the user decides.
                    this.isSaving = false;
                    if (await this._askSaveConflict(notePath)) {
                        // Overwrite: take the disk version as the base, re-send ours.
                        this.noteBaseHash = detail.hash || null;
                        this._saveQueued = true;
                    } else {
                        // Reload: drop the pending autosave and show the version on disk.
                        if (this.saveTimeout) {
                            clearTimeout(this.saveTimeout);
                            this.saveTimeout = null;
                        }
                        this._saveQueued = false;
                        await this.loadNote(notePath, false);
                    }
                    return;
                }

                if (response.ok) {
                    const result = await response.json();
                    if (notePath === this.currentNote) {
                        this.noteBaseHash = result.hash || null;
                    }
                    this.lastSaved = true;
                    
                    // Update only the modified timestamp for the current note (no full reload needed)
                    const note = this.notes.find(n => n.path === this.currentNote);
                    if (note) {
                        note.modified = new Date().toISOString();
                        note.size = new Blob([this.noteContent]).size;
                        
                        // Parse tags from content
                        note.tags = this.parseTagsFromContent(this.noteContent);
                    }
                    
                    // Reload tags to update sidebar counts (debounced to prevent spam)
                    this.loadTagsDebounced();
                    
                    // Rebuild folder tree if tag filters are active
                    if (this.selectedTags.length > 0) {
                        this.buildFolderTree();
                    }
                    
                    // Hide "saved" indicator
                    setTimeout(() => {
                        this.lastSaved = false;
                    }, CONFIG.SAVE_INDICATOR_DURATION);
                } else {
                    ErrorHandler.handle('save note', new Error('Server returned error'));
                }
            } catch (error) {
                ErrorHandler.handle('save note', error);
            } finally {
                this.isSaving = false;
                if (this._saveQueued) {
                    this._saveQueued = false;
                    this.saveNote();
                }
            }
        },

        // Ask what to do when the server refused a save because the file changed on disk.
        // Resolves true to overwrite. Escape, a click outside or "Reload" keep the disk version.
        async _askSaveConflict(notePath) {
            this._saveConflictOpen = true;
            try {
                const name = notePath.split('/').pop().replace('.md', '');
                return await this.confirmModalAsk({
                    title: this.t('notes.save_conflict_title'),
                    message: this.t('notes.save_conflict_message', { name }),
                    danger: true,
                    confirmLabel: this.t('notes.save_conflict_overwrite'),
                    cancelLabel: this.t('notes.save_conflict_reload')
                });
            } finally {
                this._saveConflictOpen = false;
            }
        },

        // Rename current note
        async renameNote() {
            if (!this.currentNote) return;
            
            const oldPath = this.currentNote;
            const newName = this.currentNoteName.trim();
            
            if (!newName) {
                this.toast(this.t('notes.empty_name'), { type: 'warning' });
                return;
            }
            
            // Validate the new name (single segment, no path separators)
            const validation = FilenameValidator.validateFilename(newName);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'note'), { type: 'warning' });
                // Reset the name in the UI
                this.currentNoteName = oldPath.split('/').pop().replace('.md', '');
                return;
            }
            
            const validatedName = validation.sanitized;
            const folder = oldPath.split('/').slice(0, -1).join('/');
            const newPath = folder ? `${folder}/${validatedName}.md` : `${validatedName}.md`;
            
            if (oldPath === newPath) return;
            
            // Check if a note with the new name already exists
            const existingNote = this.notePathTaken(newPath) ? { path: newPath } : null;
            if (existingNote) {
                this.toast(this.t('notes.already_exists', { name: validatedName }), { type: 'warning' });
                // Reset the name in the UI
                this.currentNoteName = oldPath.split('/').pop().replace('.md', '');
                return;
            }
            
            // The server rewrites the note's links to its attachment folder, so the
            // file must hold the latest text before the move: writing the editor
            // buffer afterwards would bring the old links back.
            noteEditor?.flush();
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }
            const resetName = () => {
                this.currentNoteName = oldPath.split('/').pop().replace('.md', '');
            };
            try {
                const saveResponse = await fetch(`/api/notes/${encodeVaultPath(oldPath)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: this.noteContent, base_hash: this.noteBaseHash })
                });
                if (saveResponse.status === 409) {
                    // Changed elsewhere: the regular save asks what to do.
                    resetName();
                    this.saveNote();
                    return;
                }
                if (!saveResponse.ok) throw new Error('Server returned error');
                this.noteBaseHash = (await saveResponse.json()).hash || null;
            } catch (error) {
                resetName();
                ErrorHandler.handle('rename note', error);
                return;
            }
            
            // Optimistic rename: rewrite local path now + favorites + current
            // note pointer. The file itself moves through /api/notes/move so a
            // share token follows it. POST-then-DELETE revoked the link, because
            // delete means the note is gone.
            this._optimisticRenameNote(oldPath, newPath);
            this._rebuildTreeAfterMutation();
            
            const wasFavorite = this.favoritesSet.has(oldPath);
            const setFavorite = (from, to) => {
                this.favorites = this.favorites.map(f => f === from ? to : f);
                this.favoritesSet = new Set(this.favorites);
                this.saveFavorites();
            };
            if (wasFavorite) setFavorite(oldPath, newPath);
            this.currentNote = newPath;

            // A pending autosave targets currentNote, which is already the new
            // path. Let it fire and it would create the destination before the
            // move, and the move would refuse to overwrite that file.
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }
            
            try {
                const response = await fetch('/api/notes/move', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ oldPath, newPath })
                });
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    throw new Error(errorData.detail || 'Server returned error');
                }
                const moved = await response.json();
                if (moved.content != null && newPath === this.currentNote) {
                    // Undo would bring the old links back, so the history goes too
                    this.noteContent = moved.content;
                    this.noteBaseHash = moved.hash || null;
                    this._showInEditor(moved.content, { resetHistory: true });
                }
                await this.loadSharedNotePaths();
            } catch (error) {
                ErrorHandler.handle('rename note', error);
                if (wasFavorite) setFavorite(newPath, oldPath);
                if (this.currentNote === newPath) {
                    this.currentNote = oldPath;
                    resetName();
                }
                await this.loadNotes({ silent: true });
                await this.loadSharedNotePaths();
            }
        },
        
        // Delete current note
        async deleteCurrentNote() {
            if (!this.currentNote) return;
            
            // Just call deleteNote with current note details
            await this.deleteNote(this.currentNote, this.currentNoteName);
        },
        
        // Delete any note from sidebar
        async deleteNote(notePath, noteName) {
            const ok = await this.confirmModalAsk({
                message: this.t('notes.confirm_delete', { name: noteName }),
            });
            if (!ok) return;
            
            // Optimistic: remove locally + clear current note + drop favorite
            // before the network round-trip. Sidebar refreshes in <1ms on any
            // vault size. On error we resync silently from disk.
            this._optimisticRemoveNote(notePath);
            this._rebuildTreeAfterMutation();
            
            if (this.favoritesSet.has(notePath)) {
                this.favorites = this.favorites.filter(f => f !== notePath);
                this.favoritesSet = new Set(this.favorites);
                this.saveFavorites();
            }
            
            if (this.currentNote === notePath) {
                this.currentNote = '';
                this.noteContent = '';
                this.currentNoteName = '';
                document.title = this.appName;
                window.history.replaceState({}, '', '/');
            }
            
            try {
                const response = await fetch(`/api/notes/${encodeVaultPath(notePath)}`, { method: 'DELETE' });
                if (!response.ok) throw new Error('Server returned error');
                this.loadTagsDebounced();
                this.loadTrash();
            } catch (error) {
                ErrorHandler.handle('delete note', error);
                await this.loadNotes({ silent: true });
            }
        },
        
        async loadTrash() {
            try {
                const response = await fetch('/api/trash');
                if (!response.ok) throw new Error('Server returned error');
                this.trashItems = (await response.json()).items;
            } catch (error) {
                ErrorHandler.handle('load trash', error);
            }
        },
        
        async restoreTrashItem(item) {
            try {
                const response = await fetch(`/api/trash/${item.id}/restore`, { method: 'POST' });
                if (!response.ok) throw new Error('Server returned error');
                const { path } = await response.json();
                await Promise.all([this.loadNotes({ silent: true }), this.loadTrash()]);
                this.loadTagsDebounced();
                const name = path.split('/').pop().replace(/\.md$/, '');
                const message = path === item.path ? 'trash.restored' : 'trash.restored_as';
                this.toast(this.t(message, { name }), { type: 'success' });
            } catch (error) {
                ErrorHandler.handle('restore from trash', error);
            }
        },
        
        async deleteTrashItem(item) {
            const ok = await this.confirmModalAsk({
                message: this.t('trash.confirm_delete', { name: item.name }),
            });
            if (!ok) return;
            
            try {
                const response = await fetch(`/api/trash/${item.id}`, { method: 'DELETE' });
                if (!response.ok) throw new Error('Server returned error');
            } catch (error) {
                ErrorHandler.handle('delete from trash', error);
            }
            await this.loadTrash();
        },
        
        async emptyTrash() {
            const ok = await this.confirmModalAsk({ message: this.t('trash.confirm_empty') });
            if (!ok) return;
            
            try {
                const response = await fetch('/api/trash', { method: 'DELETE' });
                if (!response.ok) throw new Error('Server returned error');
            } catch (error) {
                ErrorHandler.handle('empty trash', error);
            }
            await this.loadTrash();
        },
        
        // Search notes
        // Whether the query is worth sending. A single character matches most of
        // a vault and can't use the search index, so it reads every note to
        // answer something nobody wants — the sidebar shows its hint instead.
        isSearchable() {
            return this.searchQuery.trim().length >= CONFIG.SEARCH_MIN_QUERY_LENGTH;
        },

        debouncedSearchNotes() {
            if (this.searchDebounceTimeout) {
                clearTimeout(this.searchDebounceTimeout);
            }

            const hasTextSearch = this.isSearchable();
            if (!hasTextSearch) {
                this.isSearching = false;
                this.searchNotes();
                return;
            }

            this.isSearching = true;
            this.searchResults = [];

            this.searchDebounceTimeout = setTimeout(() => {
                this.searchNotes();
            }, CONFIG.SEARCH_DEBOUNCE_DELAY);
        },

        // Search notes by text (calls unified filter logic)
        async searchNotes() {
            await this.applyFilters();
        },
        
        /**
         * Mermaid's core is ~650 KB across two dozen chunks, so it is fetched on first
         * use rather than at page load: most notes contain no diagrams. Diagram types
         * then load on demand from ./chunks/ next to the module.
         */
        loadMermaid() {
            if (!window.mermaidReady) {
                window.mermaidReady = import('/static/vendor/mermaid/mermaid.esm.min.mjs')
                    .then((module) => (window.mermaid = module.default))
                    .catch((error) => {
                        console.error('Mermaid failed to load:', error);
                        window.mermaidReady = null; // let the next diagram retry
                        return null;
                    });
            }
            return window.mermaidReady;
        },
        
        // Get current theme type (light or dark)
        // Returns: 'light' or 'dark'
        // Used by features that need to adapt to theme brightness (e.g., Mermaid diagrams, Chart.js)
        getThemeType() {
            // Handle system theme
            if (this.currentTheme === 'system') {
                const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                return isDark ? 'dark' : 'light';
            }
            
            // Try to get theme type from loaded theme metadata
            const currentThemeData = this.availableThemes.find(t => t.id === this.currentTheme);
            if (currentThemeData && currentThemeData.type) {
                // Use metadata from theme file (light or dark)
                return currentThemeData.type; // Already 'light' or 'dark'
            }
            
            // Backward compatibility: fallback to hardcoded map if metadata not available
            const fallbackMap = {
                'light': 'light',
                'vs-blue': 'light'
            };
            
            return fallbackMap[this.currentTheme] || 'dark';
        },
        
        
        // Refresh DOM element cache
        refreshDOMCache() {
            this._domCache.editor = document.getElementById('note-editor');
        },
        
        // Add copy button to code block
        addCopyButtonToCodeBlock(preElement) {
            // Extract language from code element class (e.g., "language-toml" -> "TOML")
            const codeElement = preElement.querySelector('code');
            let language = '';
            if (codeElement && codeElement.className) {
                const match = codeElement.className.match(/language-(\w+)/);
                if (match) {
                    const langMap = {
                        'js': 'JavaScript', 'ts': 'TypeScript', 'py': 'Python',
                        'rb': 'Ruby', 'cs': 'C#', 'cpp': 'C++', 'sh': 'Shell',
                        'bash': 'Bash', 'zsh': 'Zsh', 'yml': 'YAML', 'md': 'Markdown'
                    };
                    const rawLang = match[1].toLowerCase();
                    language = langMap[rawLang] || match[1].toUpperCase();
                }
            }
            
            // Create copy button with language label
            const button = document.createElement('button');
            button.className = 'copy-code-button';
            const displayText = language || this.t('common.copy_to_clipboard').split(' ')[0]; // Use first word as fallback
            button.innerHTML = `<span>${displayText}</span>`;
            button.dataset.originalText = displayText; // Store for restore after copy
            button.title = this.t('common.copy_to_clipboard');
            
            // Style the button
            button.style.position = 'absolute';
            button.style.top = '8px';
            button.style.right = '8px';
            button.style.padding = '4px 10px';
            button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
            button.style.border = 'none';
            button.style.borderRadius = '4px';
            button.style.cursor = 'pointer';
            button.style.opacity = '0';
            button.style.transition = 'opacity 0.2s, background-color 0.2s';
            button.style.color = 'white';
            button.style.display = 'flex';
            button.style.alignItems = 'center';
            button.style.justifyContent = 'center';
            button.style.zIndex = '10';
            button.style.fontSize = '11px';
            button.style.fontWeight = '600';
            button.style.fontFamily = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
            button.style.textTransform = 'uppercase';
            button.style.letterSpacing = '0.5px';
            
            // Style the pre element to be relative
            preElement.style.position = 'relative';
            
            // Show button on hover
            preElement.addEventListener('mouseenter', () => {
                button.style.opacity = '1';
            });
            
            preElement.addEventListener('mouseleave', () => {
                button.style.opacity = '0';
            });
            
            // Copy to clipboard on click
            button.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const codeElement = preElement.querySelector('code');
                if (!codeElement) return;
                
                const code = codeElement.textContent;
                
                const originalText = button.dataset.originalText;
                const copiedText = this.t('common.copied');
                const copyTitle = this.t('common.copy_to_clipboard');
                
                try {
                    await navigator.clipboard.writeText(code);
                    
                    // Visual feedback - show localized "Copied!"
                    button.innerHTML = `<span>${copiedText}</span>`;
                    button.style.backgroundColor = 'rgba(34, 197, 94, 0.8)';
                    button.title = copiedText;
                    
                    // Reset after 2 seconds
                    setTimeout(() => {
                        button.innerHTML = `<span>${originalText}</span>`;
                        button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
                        button.title = copyTitle;
                    }, 2000);
                } catch (err) {
                    console.error('Failed to copy code:', err);
                    
                    // Fallback for older browsers
                    const textArea = document.createElement('textarea');
                    textArea.value = code;
                    textArea.style.position = 'fixed';
                    textArea.style.left = '-999999px';
                    document.body.appendChild(textArea);
                    textArea.select();
                    
                    try {
                        document.execCommand('copy');
                        button.innerHTML = `<span>${copiedText}</span>`;
                        button.style.backgroundColor = 'rgba(34, 197, 94, 0.8)';
                        setTimeout(() => {
                            button.innerHTML = `<span>${originalText}</span>`;
                            button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
                        }, 2000);
                    } catch (fallbackErr) {
                        console.error('Fallback copy failed:', fallbackErr);
                    }
                    
                    document.body.removeChild(textArea);
                }
            });
            
            // Add button to pre element
            preElement.appendChild(button);
        },
        
        /**
         * Source line of every task item, in document order. Frontmatter and fenced
         * code are skipped since neither renders a checkbox. Callers pair these with the
         * rendered boxes only when the counts match, which is safe as long as this can
         * over-count but never under-count: a miss here could cancel out a spare and
         * pass that check with everything shifted by one.
         */
        _scanTaskLines(source) {
            if (typeof source !== 'string' || !source) return [];
            const lines = source.split('\n');
            const taskLines = [];
            let startIdx = 0;

            if (lines[0] && lines[0].trim() === '---') {
                for (let i = 1; i < lines.length; i++) {
                    if (lines[i].trim() === '---') {
                        startIdx = i + 1;
                        break;
                    }
                }
            }

            // Indented fences count here: one nested in a list item still hides tasks.
            const FENCE = /^\s*(`{3,}|~{3,})/;
            let openFence = null;

            for (let i = startIdx; i < lines.length; i++) {
                const fence = lines[i].match(FENCE);
                if (openFence) {
                    if (fence && fence[1][0] === openFence[0] && fence[1].length >= openFence.length) {
                        openFence = null;
                    }
                    continue;
                }
                if (fence) {
                    openFence = fence[1];
                    continue;
                }
                if (TASK_ITEM_RE.test(lines[i])) taskLines.push(i);
            }

            return taskLines;
        },

        // Check if stats plugin is enabled
        async checkStatsPlugin() {
            try {
                const response = await fetch('/api/plugins');
                const data = await response.json();
                const statsPlugin = data.plugins.find(p => p.id === 'note_stats');
                this.statsPluginEnabled = statsPlugin && statsPlugin.enabled;
                
                // Calculate stats for current note if enabled
                if (this.statsPluginEnabled && this.noteContent) {
                    this.calculateStats();
                }
            } catch (error) {
                console.error('Failed to check stats plugin:', error);
                this.statsPluginEnabled = false;
            }
        },
        
        // Calculate note statistics (client-side)
        calculateStats() {
            if (!this.statsPluginEnabled || !this.noteContent) {
                this.noteStats = null;
                return;
            }
            
            const content = this.noteContent;
            
            // Word count
            const words = (content.match(/\S+/g) || []).length;
            
            // Character count
            const chars = content.replace(/\s/g, '').length;
            const totalChars = content.length;
            
            // Reading time (200 words per minute)
            const readingTime = Math.max(1, Math.round(words / 200));
            
            // Line count
            const lines = content.split('\n').length;
            
            // Paragraph count
            const paragraphs = content.split('\n\n').filter(p => p.trim()).length;
            
            // Sentences: punctuation [.!?]+ followed by space or end-of-string
            const sentences = (content.match(/[.!?]+(?:\s|$)/g) || []).length;
            
            // List items: lines starting with -, *, + or a number (e.g. 1., 10.), excluding tasks [-]
            const listItems = (content.match(/^\s*(?:[-*+]|\d+\.)\s+(?!\[)/gm) || []).length;
            
            // Tables: markdown table separator rows (| --- | --- |)
            const tables = (content.match(/^\s*\|(?:\s*:?-+:?\s*\|){1,}\s*$/gm) || []).length;
            
            // Link count (standard markdown links)
            const markdownLinkMatches = content.match(/\[([^\]]+)\]\(([^\)]+)\)/g) || [];
            const markdownLinks = markdownLinkMatches.length;
            // Test the target, not the whole link: a label mentioning ".md" is not an internal link.
            const markdownInternalLinks = markdownLinkMatches.filter(l => /\]\([^)]+\.md(?:#[^)]*)?\)$/.test(l)).length;
            
            // Wikilink count ([[note]] or [[note|display text]] format)
            const wikilinks = (content.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g) || []).length;
            
            // Total links (markdown + wikilinks)
            const links = markdownLinks + wikilinks;
            const internalLinks = markdownInternalLinks + wikilinks; // All wikilinks are internal
            
            // Code blocks
            const codeBlocks = (content.match(/```[\s\S]*?```/g) || []).length;
            // Fences come out first: the ``` pairs around a block otherwise match
            // the inline pattern and each block counts as an inline span as well.
            const inlineCode = (content.replace(/```[\s\S]*?```/g, '').match(/`[^`]+`/g) || []).length;
            
            // Headings
            const h1 = (content.match(/^# /gm) || []).length;
            const h2 = (content.match(/^## /gm) || []).length;
            const h3 = (content.match(/^### /gm) || []).length;
            
            // Tasks: found the same way the preview's clickable checkboxes are, so the
            // panel counts exactly the boxes you can see and tick. A plain `- [x]` search
            // would instead count examples inside code fences and frontmatter while
            // missing every task on a *, + or numbered marker.
            const contentLines = content.split('\n');
            const taskLines = this._scanTaskLines(content);
            const totalTasks = taskLines.length;
            const completedTasks = taskLines.filter((i) => {
                const state = contentLines[i].match(TASK_ITEM_RE);
                return state && state[2] !== ' ';
            }).length;
            const pendingTasks = totalTasks - completedTasks;
            const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
            
            // Images
            const images = (content.match(/!\[([^\]]*)\]\(([^\)]+)\)/g) || []).length;
            
            // Blockquotes
            const blockquotes = (content.match(/^> /gm) || []).length;
            
            this.noteStats = {
                words,
                sentences,
                characters: chars,
                total_characters: totalChars,
                reading_time_minutes: readingTime,
                lines,
                paragraphs,
                list_items: listItems,
                tables,
                links,
                internal_links: internalLinks,
                external_links: links - internalLinks,
                wikilinks,
                code_blocks: codeBlocks,
                inline_code: inlineCode,
                headings: {
                    h1,
                    h2,
                    h3,
                    total: h1 + h2 + h3
                },
                tasks: {
                    total: totalTasks,
                    completed: completedTasks,
                    pending: pendingTasks,
                    completion_rate: completionRate
                },
                images,
                blockquotes
            };
        },
        
        // Parse YAML frontmatter metadata from note content
        parseMetadata() {
            if (!this.noteContent) {
                this.noteMetadata = null;
                this._lastFrontmatter = null;
                return;
            }
            
            const content = this.noteContent;
            
            // Check if content starts with frontmatter
            if (!content.trim().startsWith('---')) {
                this.noteMetadata = null;
                this._lastFrontmatter = null;
                return;
            }
            
            try {
                const lines = content.split('\n');
                if (lines[0].trim() !== '---') {
                    this.noteMetadata = null;
                    this._lastFrontmatter = null;
                    return;
                }
                
                // Find closing ---
                let endIdx = -1;
                for (let i = 1; i < lines.length; i++) {
                    if (lines[i].trim() === '---') {
                        endIdx = i;
                        break;
                    }
                }
                
                if (endIdx === -1) {
                    this.noteMetadata = null;
                    this._lastFrontmatter = null;
                    return;
                }
                
                // Performance optimization: skip parsing if frontmatter unchanged
                const frontmatterRaw = lines.slice(0, endIdx + 1).join('\n');
                if (frontmatterRaw === this._lastFrontmatter) {
                    return; // No change, keep existing metadata
                }
                this._lastFrontmatter = frontmatterRaw;
                
                const frontmatterLines = lines.slice(1, endIdx);
                const metadata = {};
                let currentKey = null;
                let currentValue = [];
                
                for (const line of frontmatterLines) {
                    // Check for new key: value pair (supports keys with hyphens/underscores)
                    const keyMatch = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
                    
                    if (keyMatch) {
                        // Save previous key if exists
                        if (currentKey) {
                            metadata[currentKey] = this.parseYamlValue(currentValue.join('\n'));
                        }
                        
                        currentKey = keyMatch[1];
                        const value = keyMatch[2].trim();
                        currentValue = [value];
                    } else if (line.match(/^\s+-\s+/) && currentKey) {
                        // List item continuation (e.g., "  - item")
                        currentValue.push(line);
                    } else if (line.startsWith('  ') && currentKey) {
                        // Indented content (multiline value)
                        currentValue.push(line);
                    }
                }
                
                // Save last key
                if (currentKey) {
                    metadata[currentKey] = this.parseYamlValue(currentValue.join('\n'));
                }
                
                this.noteMetadata = Object.keys(metadata).length > 0 ? metadata : null;
                
            } catch (error) {
                console.error('Failed to parse frontmatter:', error);
                this.noteMetadata = null;
                this._lastFrontmatter = null;
            }
        },
        
        // Parse a YAML value (handles arrays, strings, numbers, booleans)
        parseYamlValue(value) {
            if (!value || value.trim() === '') return null;
            
            value = value.trim();
            
            // Check for inline array: [item1, item2]
            if (value.startsWith('[') && value.endsWith(']')) {
                const inner = value.slice(1, -1);
                return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(s => s);
            }
            
            // Check for YAML list format (multiple lines starting with -)
            if (value.includes('\n  -') || value.startsWith('  -')) {
                const items = [];
                const lines = value.split('\n');
                for (const line of lines) {
                    const match = line.match(/^\s*-\s*(.+)$/);
                    if (match) {
                        items.push(match[1].trim().replace(/^["']|["']$/g, ''));
                    }
                }
                return items.length > 0 ? items : value;
            }
            
            // Check for boolean
            if (value.toLowerCase() === 'true') return true;
            if (value.toLowerCase() === 'false') return false;
            
            // Check for number
            if (/^-?\d+(\.\d+)?$/.test(value)) {
                return parseFloat(value);
            }
            
            // Return as string (remove quotes if present)
            return value.replace(/^["']|["']$/g, '');
        },
        
        // Check if a string is a URL
        isUrl(str) {
            if (typeof str !== 'string') return false;
            return /^https?:\/\/\S+$/i.test(str.trim());
        },
        
        // Escape HTML to prevent XSS
        escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        },
        
        // Format metadata value for display
        formatMetadataValue(key, value) {
            if (value === null || value === undefined) return '';
            
            // Arrays are handled separately in the template
            if (Array.isArray(value)) return value;
            
            // Format dates nicely
            if (key === 'date' || key === 'created' || key === 'modified' || key === 'updated') {
                let date;
                // Parse date-only strings (YYYY-MM-DD) as local dates to avoid timezone issues
                if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
                    const [year, month, day] = value.split('-').map(Number);
                    date = new Date(year, month - 1, day);  // month is 0-indexed
                } else {
                    date = new Date(value);
                }
                if (!isNaN(date.getTime())) {
                    return date.toLocaleDateString(this.currentLocale, { 
                        year: 'numeric', 
                        month: 'short', 
                        day: 'numeric' 
                    });
                }
            }
            
            // Booleans
            if (typeof value === 'boolean') {
                return value ? this.t('common.yes') : this.t('common.no');
            }
            
            return String(value);
        },
        
        // Format metadata value as HTML (for URL support)
        formatMetadataValueHtml(key, value) {
            const formatted = this.formatMetadataValue(key, value);
            
            // Check if it's a URL
            if (this.isUrl(formatted)) {
                const escaped = this.escapeHtml(formatted);
                // Truncate long URLs for display
                const displayUrl = formatted.length > 40 
                    ? formatted.substring(0, 37) + '...' 
                    : formatted;
                return `<a href="${escaped}" target="_blank" rel="noopener noreferrer" class="metadata-link">${this.escapeHtml(displayUrl)}</a>`;
            }
            
            return this.escapeHtml(formatted);
        },
        
        // Get priority metadata fields (shown in collapsed view)
        getPriorityMetadataFields() {
            if (!this.noteMetadata) return [];
            
            // Fields to show in collapsed view, in order of priority
            const priority = ['date', 'created', 'author', 'status', 'priority', 'type', 'category'];
            const fields = [];
            
            for (const key of priority) {
                if (this.noteMetadata[key] !== undefined && !Array.isArray(this.noteMetadata[key])) {
                    const formatted = this.formatMetadataValue(key, this.noteMetadata[key]);
                    const isUrl = this.isUrl(formatted);
                    fields.push({ 
                        key, 
                        value: formatted,
                        valueHtml: isUrl ? this.formatMetadataValueHtml(key, this.noteMetadata[key]) : this.escapeHtml(formatted),
                        isUrl
                    });
                }
            }
            
            return fields.slice(0, 3); // Show max 3 fields in collapsed view
        },
        
        // Get all metadata fields except tags (for expanded view)
        getAllMetadataFields() {
            if (!this.noteMetadata) return [];
            
            return Object.entries(this.noteMetadata)
                .filter(([key]) => key !== 'tags') // Tags shown separately
                .map(([key, value]) => {
                    const isArray = Array.isArray(value);
                    const formatted = this.formatMetadataValue(key, value);
                    const isUrl = !isArray && this.isUrl(formatted);
                    return {
                        key,
                        value: formatted,
                        valueHtml: isUrl ? this.formatMetadataValueHtml(key, value) : this.escapeHtml(formatted),
                        isArray,
                        isUrl
                    };
                });
        },
        
        // Check if note has any displayable metadata
        getHasMetadata() {
            const has = this.noteMetadata && Object.keys(this.noteMetadata).length > 0;
            return has;
        },
        
        // Get tags from metadata
        getMetadataTags() {
            if (!this.noteMetadata || !this.noteMetadata.tags) return [];
            return Array.isArray(this.noteMetadata.tags) ? this.noteMetadata.tags : [this.noteMetadata.tags];
        },
        
        // Save sidebar width to localStorage
        saveSidebarWidth() {
            localStorage.setItem('sidebarWidth', this.sidebarWidth.toString());
        },
        
        // Save view mode to localStorage
        saveViewMode() {
            try {
                localStorage.setItem('viewMode', this.viewMode);
            } catch (error) {
                console.error('Error saving view mode:', error);
            }
        },
        
        saveTagsExpanded() {
            try {
                localStorage.setItem('tagsExpanded', this.tagsExpanded.toString());
            } catch (error) {
                console.error('Error saving tags expanded state:', error);
            }
        },
        
        // Start resizing sidebar
        startResize(event) {
            this.isResizing = true;
            event.preventDefault();
            
            const resize = (e) => {
                if (!this.isResizing) return;
                
                // Calculate new width based on mouse position
                const newWidth = e.clientX;
                
                // Clamp between min and max
                if (newWidth >= 200 && newWidth <= 600) {
                    this.sidebarWidth = newWidth;
                }
            };
            
            const stopResize = () => {
                if (this.isResizing) {
                    this.isResizing = false;
                    this.saveSidebarWidth();
                    document.removeEventListener('mousemove', resize);
                    document.removeEventListener('mouseup', stopResize);
                }
            };
            
            document.addEventListener('mousemove', resize);
            document.addEventListener('mouseup', stopResize);
        },
        
        // Back to where this note was left. Stored as a fraction, since the height changes.
        _restoreNoteScroll() {
            const editor = this._domCache.editor;
            if (!this.currentNote || !editor) return;
            const scrollable = editor.scrollHeight - editor.clientHeight;
            editor.scrollTop = (this.noteScrollPositions[this.currentNote] ?? 0) * scrollable;
        },

        _rememberNoteScroll(editor) {
            if (this._scrollRestorePending || !this.currentNote) return;
            const scrollable = editor.scrollHeight - editor.clientHeight;
            if (scrollable > 0) this.noteScrollPositions[this.currentNote] = editor.scrollTop / scrollable;
        },

        // Scroll to top of the note
        scrollToTop() {
            if (!this._domCache.editor) this.refreshDOMCache();
            if (this._domCache.editor) this._domCache.editor.scrollTop = 0;
        },

        // Export current note as HTML via backend API
        async exportToHTML() {
            if (!this.currentNote || !this.noteContent) {
                this.toast(this.t('notes.no_content'), { type: 'info' });
                return;
            }
            
            try {
                // Build API URL with current theme
                const currentTheme = this.currentTheme || 'light';
                const encodedPath = this.currentNote.split('/').map(s => encodeURIComponent(s)).join('/');
                const url = `/api/export/${encodedPath}?theme=${encodeURIComponent(currentTheme)}`;
                
                // Fetch the exported HTML from backend
                const response = await fetch(url);
                if (!response.ok) {
                    const error = await response.json().catch(() => ({ detail: 'Export failed' }));
                    throw new Error(error.detail || 'Export failed');
                }
                
                // Get filename from Content-Disposition header or use note name
                let filename = (this.currentNoteName || 'note') + '.html';
                const contentDisposition = response.headers.get('Content-Disposition');
                if (contentDisposition) {
                    const match = contentDisposition.match(/filename="([^"]+)"/);
                    if (match) {
                        filename = match[1];
                    }
                }
                
                // Download as blob
                const blob = await response.blob();
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                
                // Cleanup
                URL.revokeObjectURL(blobUrl);
                document.body.removeChild(a);
                
            } catch (error) {
                console.error('HTML export failed:', error);
                this.toast(this.t('export.failed', { error: error.message }), { type: 'error' });
            }
        },
        
        // Open print preview in new window
        printPreview() {
            if (!this.currentNote || !this.noteContent) {
                this.toast(this.t('notes.no_content'), { type: 'info' });
                return;
            }
            
            // Build API URL with current theme and download=false for inline display
            const currentTheme = this.currentTheme || 'light';
            const encodedPath = this.currentNote.split('/').map(s => encodeURIComponent(s)).join('/');
            const url = `/api/export/${encodedPath}?theme=${encodeURIComponent(currentTheme)}&download=false`;
            
            // Open in new window/tab
            window.open(url, '_blank');
        },
        
        // Copy current note link to clipboard
        async copyNoteLink() {
            if (!this.currentNote) return;
            
            // Build the full URL
            const pathWithoutExtension = this.currentNote.replace('.md', '');
            const encodedPath = pathWithoutExtension.split('/').map(segment => encodeURIComponent(segment)).join('/');
            const url = `${window.location.origin}/${encodedPath}`;
            
            try {
                await navigator.clipboard.writeText(url);
            } catch (error) {
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = url;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
            }
            
            // Show brief "Copied!" feedback
            this.linkCopied = true;
            setTimeout(() => {
                this.linkCopied = false;
            }, 1500);
        },
        
        // ============================================================================
        // Share Functions
        // ============================================================================
        
        // Load list of shared note paths (for visual indicators and Shared sidebar panel)
        async loadSharedNotePaths() {
            try {
                const response = await fetch('/api/shared-notes');
                if (response.ok) {
                    const data = await response.json();
                    this._sharedNotePaths = new Set(data.paths || []);
                    this._syncSharedNotePathsList();
                }
            } catch (error) {
                console.error('Failed to load shared note paths:', error);
                this._sharedNotePaths = new Set();
                this._sharedNotePathsList = [];
            }
        },

        _syncSharedNotePathsList() {
            this._sharedNotePathsList = [...this._sharedNotePaths].sort((a, b) =>
                a.localeCompare(b, undefined, { sensitivity: 'base' })
            );
        },

        /** Display rows for Shared notes panel: name + folder line (search-style) */
        getSharedPanelItems() {
            return this._sharedNotePathsList.map((path) => {
                const noMd = path.replace(/\.md$/i, '');
                const last = Math.max(noMd.lastIndexOf('/'), noMd.lastIndexOf('\\'));
                const name = last < 0 ? noMd : noMd.slice(last + 1);
                const folder = last < 0 ? '' : noMd.slice(0, last).replace(/\\/g, '/');
                return { path, name, folder: folder || 'Root' };
            });
        },
        
        // Check if a note is currently shared (O(1) lookup)
        isNoteShared(notePath) {
            return this._sharedNotePaths.has(notePath);
        },
        
        // ============================================
        // Quick Switcher (Ctrl+Alt+P)
        // ============================================
        
        openQuickSwitcher() {
            this.showQuickSwitcher = true;
            this.quickSwitcherQuery = '';
            this.quickSwitcherIndex = 0;
            // Populate initial results
            this.quickSwitcherResults = (this.allNotes || []).slice(0, 10);
            // Focus the input after the modal renders
            this.$nextTick(() => {
                const input = document.getElementById('quickSwitcherInput');
                if (input) input.focus();
            });
        },
        
        closeQuickSwitcher() {
            this.showQuickSwitcher = false;
            this.quickSwitcherQuery = '';
            this.quickSwitcherIndex = 0;
        },
        
        // Filter notes for quick switcher based on query
        filterQuickSwitcher(query) {
            // Only include actual notes, not images
            const notes = (this.notes || []).filter(n => n.type === 'note');
            if (!query || !query.trim()) {
                // Show recent notes when no query
                return notes.slice(0, 10);
            }
            const q = query.toLowerCase();
            return notes
                .filter(n => 
                    n.name.toLowerCase().includes(q) || 
                    n.path.toLowerCase().includes(q)
                )
                .slice(0, 10);
        },
        
        // Handle keyboard navigation in quick switcher
        handleQuickSwitcherKeydown(e) {
            const results = this.quickSwitcherResults;
            
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.quickSwitcherIndex = Math.min(this.quickSwitcherIndex + 1, results.length - 1);
                this.scrollQuickSwitcherIntoView();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.quickSwitcherIndex = Math.max(this.quickSwitcherIndex - 1, 0);
                this.scrollQuickSwitcherIntoView();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const note = results[this.quickSwitcherIndex];
                if (note) {
                    this.loadNote(note.path);
                    this.closeQuickSwitcher();
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.closeQuickSwitcher();
            }
        },
        
        // Scroll selected item into view in quick switcher
        scrollQuickSwitcherIntoView() {
            this.$nextTick(() => {
                const items = document.querySelectorAll('[data-quick-switcher-item]');
                if (items[this.quickSwitcherIndex]) {
                    items[this.quickSwitcherIndex].scrollIntoView({ block: 'nearest' });
                }
            });
        },
        
        // Select note from quick switcher by click
        selectQuickSwitcherNote(note) {
            this.loadNote(note.path);
            this.closeQuickSwitcher();
        },
        
        // Close share modal and reset state after animation
        closeShareModal() {
            this.showShareModal = false;
            clearTimeout(this._shareSlugCheckTid);
            // Delay state reset until modal is fully hidden. Reopening cancels it,
            // otherwise a pending reset lands on the freshly loaded dialog and blanks
            // it while it is on screen.
            clearTimeout(this._shareResetTid);
            this._shareResetTid = setTimeout(() => {
                this.showShareQR = false;
                this.shareInfo = null;
                this.shareLoading = false;
                this.shareUseRandomLink = true;
                this.shareSlug = '';
                this.shareSlugState = '';
            }, 200);
        },
        
        // Generate QR code for share URL
        generateQRCode(url) {
            if (!url || typeof qrcode === 'undefined') return '';
            try {
                const qr = qrcode(0, 'M'); // 0 = auto version, M = medium error correction
                qr.addData(url);
                qr.make();
                return qr.createDataURL(4); // 4 = module size in pixels
            } catch (e) {
                console.error('QR code generation failed:', e);
                return '';
            }
        },
        
        /**
         * Correct the scheme and host of a server-generated share URL.
         *
         * The backend builds share URLs from request.base_url, whose scheme comes from
         * the connection it actually received. Behind a TLS-terminating reverse proxy
         * that connection is plain http, so the link comes back as http:// even though
         * the note is reachable only over https. The browser is authoritative for the
         * scheme and host it is currently on, so adopt those two and keep the server's
         * path, which may carry a deployment prefix the frontend cannot infer.
         *
         * When sharePublicOrigin is configured (LAN browse, public share host), prefer
         * that origin instead so the dialog / QR / clipboard show the outbound URL.
         */
        _localizeShareUrl(info) {
            if (!info || typeof info.url !== 'string' || !info.url) return info;
            try {
                const src = new URL(info.url, window.location.href);
                const origin = this.sharePublicOrigin || window.location.origin;
                // Take the origin wholesale rather than assigning protocol/host
                // separately: the URL host setter leaves an existing port in place when
                // the new value carries none, which would yield https://host:8000/...
                info.url = new URL(
                    src.pathname + src.search + src.hash,
                    origin
                ).toString();
            } catch (e) {
                // Keep the server's value rather than risk producing a broken link.
                console.warn('Could not normalize share URL:', e);
            }
            return info;
        },

        /**
         * Drop YAML frontmatter so a suggested link name comes from the prose.
         */
        _bodyWithoutFrontmatter(content) {
            const text = typeof content === 'string' ? content : '';
            const lines = text.split('\n');
            if (lines[0]?.trim() !== '---') return text;
            for (let i = 1; i < lines.length; i++) {
                if (lines[i].trim() === '---') return lines.slice(i + 1).join('\n');
            }
            return text;
        },

        /**
         * Spell text with the ASCII letters a share slug can hold: café -> cafe,
         * straße -> strasse. Case is kept for callers that care about it, and
         * characters with no Latin reading are left in place for them to deal with.
         */
        _toSlugAlphabet(text) {
            return (text || '')
                .replace(SLUG_TRANSLITERATION_RE, (ch) => {
                    const mapped = SLUG_TRANSLITERATIONS[ch.toLowerCase()];
                    if (!mapped) return ch;
                    return ch === ch.toLowerCase() ? mapped : mapped[0].toUpperCase() + mapped.slice(1);
                })
                .normalize('NFKD')
                .replace(/[\u0300-\u036f]/g, '');
        },

        /** Reduce text to the token alphabet the backend accepts. */
        _slugify(text) {
            return this._toSlugAlphabet(text)
                .replace(/[^A-Za-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, CONFIG.SHARE_SLUG_MAX_LENGTH)
                .replace(/-+$/g, '')
                .toLowerCase();
        },

        /**
         * Propose a link name from the note's opening words, falling back to its
         * filename when those are all markup or a script the URL alphabet can't hold.
         */
        _suggestShareSlug() {
            const body = this._bodyWithoutFrontmatter(this.noteContent);
            const openingWords = (text) => text
                .replace(/^#{1,6}\s+/gm, '')
                .replace(/[*_`~>\[\]()!|]/g, ' ')
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, CONFIG.SHARE_SLUG_WORDS)
                .join(' ');
            // The heading on its own reads best. Reaching into the rest of the body is
            // for notes that open straight into prose, or whose title is a word or two.
            const firstLine = body.split('\n').find(line => line.trim()) || '';
            for (const candidate of [openingWords(firstLine), openingWords(body)]) {
                const slug = this._slugify(candidate);
                if (slug.length >= CONFIG.SHARE_SLUG_MIN_LENGTH) return slug;
            }
            const filename = (this.currentNote || '').split('/').pop().replace(/\.md$/, '');
            return this._slugify(filename);
        },

        /**
         * Keep field and state identical, dropping characters a URL can't carry.
         * Accented letters are spelled out rather than deleted, so typing a name
         * produces what the suggested one would have.
         */
        onShareSlugInput(event) {
            const el = event?.target;
            const cleaned = this._toSlugAlphabet(el ? el.value : this.shareSlug)
                .replace(/\s+/g, '-')
                .replace(/[^A-Za-z0-9_-]/g, '')
                .slice(0, CONFIG.SHARE_SLUG_MAX_LENGTH);
            this.shareSlug = cleaned;
            // Alpine repaints only when the bound value changes, and a rejected
            // keystroke leaves it unchanged, so put the field back by hand.
            if (el && el.value !== cleaned) el.value = cleaned;
            this._scheduleShareSlugCheck();
        },

        onShareRandomLinkToggle() {
            if (this.shareUseRandomLink) {
                this.shareSlugState = '';
                return;
            }
            if (!this.shareSlug) this.shareSlug = this._suggestShareSlug();
            this._scheduleShareSlugCheck();
        },

        _scheduleShareSlugCheck() {
            clearTimeout(this._shareSlugCheckTid);
            const slug = this.shareSlug;
            if (!slug) {
                this.shareSlugState = '';
                return;
            }
            if (slug.length < CONFIG.SHARE_SLUG_MIN_LENGTH) {
                this.shareSlugState = 'too_short';
                return;
            }
            this.shareSlugState = '';
            this._shareSlugCheckTid = setTimeout(
                () => this._checkShareSlug(slug),
                CONFIG.SHARE_SLUG_CHECK_DEBOUNCE
            );
        },

        /**
         * Ask whether a name is free. Advisory only - saving re-checks server-side,
         * so a failed check leaves the field neutral instead of blocking the button.
         */
        async _checkShareSlug(slug) {
            try {
                const params = new URLSearchParams({ slug });
                if (this.currentNote) {
                    params.set('note_path', this.currentNote.replace(/\.md$/, ''));
                }
                const response = await fetch(`/api/share-slug?${params.toString()}`);
                if (!response.ok) return;
                const data = await response.json();
                if (slug !== this.shareSlug) return;   // A later keystroke owns the field
                this.shareSlugState = data.available ? 'ok' : (data.reason || 'taken');
            } catch (error) {
                console.warn('Could not check share link name:', error);
            }
        },

        /** Full URL for what is currently typed, built the way the server builds it. */
        shareSlugPreviewUrl() {
            if (!this.shareSlug) return '';
            const origin = this.sharePublicOrigin || window.location.origin;
            return `${origin}/share/${this.shareSlug}`;
        },

        _shareSlugMessageFor(state) {
            if (!state) return '';
            if (state === 'ok') return this.t('share.slug_available');
            if (state === 'taken') return this.t('share.slug_taken');
            if (state === 'too_short') {
                return this.t('share.slug_too_short', { min: CONFIG.SHARE_SLUG_MIN_LENGTH });
            }
            if (state === 'too_long') {
                return this.t('share.slug_too_long', { max: CONFIG.SHARE_SLUG_MAX_LENGTH });
            }
            return this.t('share.slug_invalid_chars');
        },

        shareSlugMessage() {
            return this._shareSlugMessageFor(this.shareSlugState);
        },

        shareSlugOk() {
            return this.shareSlugState === 'ok';
        },

        /** A generated link is always fine; a typed one has to pass validation. */
        canSubmitShareLink() {
            if (this.shareUseRandomLink && !this.shareInfo?.shared) return true;
            return this.shareSlug.length >= CONFIG.SHARE_SLUG_MIN_LENGTH
                && !['taken', 'too_short', 'too_long', 'invalid_chars'].includes(this.shareSlugState);
        },

        /** True when the field holds a name the note is not actually shared under. */
        shareSlugChanged() {
            return !!this.shareInfo?.shared && this.shareSlug !== (this.shareInfo.token || '');
        },

        _shareSlugReason(detail) {
            return detail && typeof detail === 'object' && typeof detail.reason === 'string'
                ? detail.reason
                : '';
        },

        _shareErrorText(detail) {
            const reason = this._shareSlugReason(detail);
            if (reason) return this._shareSlugMessageFor(reason);
            return typeof detail === 'string' && detail ? detail : 'Unknown error';
        },

        // Open share modal and fetch current share status
        async openShareModal() {
            if (!this.currentNote) return;
            
            clearTimeout(this._shareResetTid);
            // Reset state BEFORE showing modal to prevent flicker
            this.showShareQR = false;
            this.shareInfo = null;
            this.shareLoading = true;
            this.showShareModal = true;
            this.shareUseRandomLink = true;
            this.shareSlug = '';
            this.shareSlugState = '';
            
            try {
                const notePath = this.currentNote.replace('.md', '');
                const encodedPath = notePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
                const response = await fetch(`/api/share/${encodedPath}`);
                
                if (response.ok) {
                    this.shareInfo = this._localizeShareUrl(await response.json());
                } else {
                    this.shareInfo = { shared: false };
                }
            } catch (error) {
                console.error('Failed to get share status:', error);
                this.shareInfo = { shared: false };
            } finally {
                // An existing link's own name is what the field starts from, so editing
                // it is a rename rather than a fresh choice.
                this.shareSlug = this.shareInfo?.shared ? (this.shareInfo.token || '') : '';
                this.shareLoading = false;
            }
        },
        
        // Create a share link for the current note (with current theme)
        async createShareLink() {
            if (!this.currentNote) return;
            
            this.shareLoading = true;
            
            try {
                const notePath = this.currentNote.replace('.md', '');
                const encodedPath = notePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
                const body = { theme: this.currentTheme || 'light' };
                if (!this.shareUseRandomLink && this.shareSlug) body.slug = this.shareSlug;
                const response = await fetch(`/api/share/${encodedPath}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                
                if (response.ok) {
                    this.shareInfo = this._localizeShareUrl(await response.json());
                    this.shareInfo.shared = true;
                    this.shareSlug = this.shareInfo.token || '';
                    this.shareSlugState = '';
                    // Update the shared paths set
                    this._sharedNotePaths.add(this.currentNote);
                    this._syncSharedNotePathsList();
                } else {
                    const error = await response.json();
                    // A rejected name belongs on the field, not only in a toast that
                    // disappears while the dialog is still open.
                    const reason = this._shareSlugReason(error.detail);
                    if (reason) this.shareSlugState = reason;
                    this.toast(this.t('share.error_creating', { error: this._shareErrorText(error.detail) }), { type: 'error' });
                }
            } catch (error) {
                console.error('Failed to create share link:', error);
                this.toast(this.t('share.error_creating', { error: error.message }), { type: 'error' });
            } finally {
                this.shareLoading = false;
            }
        },
        
        /**
         * Move the note to a new link name.
         *
         * A note has one share token, so this is a swap: the previous URL stops
         * resolving the moment the new one starts.
         */
        async updateShareLinkSlug() {
            if (!this.currentNote || !this.shareSlugChanged() || !this.canSubmitShareLink()) return;
            
            const ok = await this.confirmModalAsk({
                message: this.t('share.confirm_slug_change'),
                danger: true,
                confirmLabel: this.t('share.update_link'),
            });
            if (!ok) return;
            
            this.shareLoading = true;
            
            try {
                const notePath = this.currentNote.replace('.md', '');
                const encodedPath = notePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
                const response = await fetch(`/api/share/${encodedPath}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        theme: this.shareInfo?.theme || this.currentTheme || 'light',
                        slug: this.shareSlug
                    })
                });
                
                if (response.ok) {
                    this.shareInfo = this._localizeShareUrl(await response.json());
                    this.shareInfo.shared = true;
                    this.shareSlug = this.shareInfo.token || '';
                    this.shareSlugState = '';
                    this.shareLinkCopied = false;
                } else {
                    const error = await response.json();
                    const reason = this._shareSlugReason(error.detail);
                    if (reason) this.shareSlugState = reason;
                    this.toast(this.t('share.error_updating', { error: this._shareErrorText(error.detail) }), { type: 'error' });
                }
            } catch (error) {
                console.error('Failed to update share link:', error);
                this.toast(this.t('share.error_updating', { error: error.message }), { type: 'error' });
            } finally {
                this.shareLoading = false;
            }
        },
        
        // Copy share link to clipboard
        async copyShareLink() {
            if (!this.shareInfo?.url) return;
            
            try {
                await navigator.clipboard.writeText(this.shareInfo.url);
            } catch (error) {
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = this.shareInfo.url;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
            }
            
            this.shareLinkCopied = true;
            setTimeout(() => {
                this.shareLinkCopied = false;
            }, 2000);
        },
        
        // Revoke share link
        async revokeShareLink() {
            if (!this.currentNote) return;
            
            const ok = await this.confirmModalAsk({
                message: this.t('share.confirm_revoke'),
                danger: false,
                confirmLabel: this.t('common.yes'),
            });
            if (!ok) return;
            
            this.shareLoading = true;
            
            try {
                const notePath = this.currentNote.replace('.md', '');
                const encodedPath = notePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
                const response = await fetch(`/api/share/${encodedPath}`, {
                    method: 'DELETE'
                });
                
                if (response.ok) {
                    // Update the shared paths set
                    this._sharedNotePaths.delete(this.currentNote);
                    this._syncSharedNotePathsList();
                    // Nothing is left to do here, and dropping back to the "create a
                    // link" step offers to undo what was just confirmed.
                    this.closeShareModal();
                } else {
                    const error = await response.json();
                    this.toast(this.t('share.error_revoking', { error: error.detail || 'Unknown error' }), { type: 'error' });
                }
            } catch (error) {
                console.error('Failed to revoke share link:', error);
                this.toast(this.t('share.error_revoking', { error: error.message }), { type: 'error' });
            } finally {
                this.shareLoading = false;
            }
        },
        
        // Toggle Zen Mode (full immersive writing experience)
        async toggleZenMode() {
            if (!this.zenMode) {
                // Entering Zen Mode
                this.previousViewMode = this.viewMode;
                this.viewMode = 'edit';
                this.mobileSidebarOpen = false;
                this.zenMode = true;
                
                // Request fullscreen
                try {
                    const elem = document.documentElement;
                    if (elem.requestFullscreen) {
                        await elem.requestFullscreen();
                    } else if (elem.webkitRequestFullscreen) {
                        await elem.webkitRequestFullscreen();
                    } else if (elem.msRequestFullscreen) {
                        await elem.msRequestFullscreen();
                    }
                } catch (e) {
                    // Fullscreen not supported or denied, continue anyway
                    console.log('Fullscreen not available:', e);
                }
                
                // Focus editor after transition
                setTimeout(() => noteEditor?.focus(), 300);
            } else {
                // Exiting Zen Mode
                this.zenMode = false;
                this.viewMode = this.previousViewMode;
                
                // Exit fullscreen
                try {
                    if (document.exitFullscreen) {
                        await document.exitFullscreen();
                    } else if (document.webkitExitFullscreen) {
                        await document.webkitExitFullscreen();
                    } else if (document.msExitFullscreen) {
                        await document.msExitFullscreen();
                    }
                } catch (e) {
                    console.log('Exit fullscreen error:', e);
                }
            }
        },
        
        // Homepage folder navigation methods
        goToHomepageFolder(folderPath) {
            this.showGraph = false; // Close graph when navigating
            this.selectedHomepageFolder = folderPath || '';
            this.homepageNameQuery = '';
            
            // Clear editor state to show landing page
            this._commitPendingEdits();
            this.currentNote = '';
            this.currentNoteName = '';
            this.noteContent = '';
            this.closeMediaViewer();
            this.outline = [];
            this.backlinks = [];
            document.title = this.appName;
            
            // Invalidate cache to force recalculation
            this._homepageCache = {
                folderPath: null,
                notes: null,
                folders: null,
                breadcrumb: null
            };
            
            window.history.pushState({ homepageFolder: folderPath || '' }, '', '/');
        },
        
        // Navigate to homepage root and clear all editor state
        goHome() {
            this._commitPendingEdits();
            this.showGraph = false; // Close graph when going home
            this.selectedHomepageFolder = '';
            this.homepageNameQuery = '';
            this.currentNote = '';
            this.currentNoteName = '';
            this.noteContent = '';
            this.closeMediaViewer();
            this.outline = [];
            this.backlinks = [];
            this.mobileSidebarOpen = false;
            document.title = this.appName;
            
            // Invalidate cache to force recalculation
            this._homepageCache = {
                folderPath: null,
                notes: null,
                folders: null,
                breadcrumb: null
            };
            
            window.history.pushState({ homepageFolder: '' }, '', '/');
        },
        
        // Mobile files/home tab - context-aware behavior
        mobileFilesTabClick() {
            if (this.currentNote || this.currentMedia || this.showGraph) {
                // Leaving content lands in the folder the item lives in, not the vault
                // root: this tab is the only way out of a note on mobile, and dropping
                // the user at the root loses their place. Root stays one tap away on
                // the homepage breadcrumb.
                const openPath = this.currentNote || this.currentMedia;
                const parentFolder = openPath
                    ? openPath.split('/').slice(0, -1).join('/')
                    : this.selectedHomepageFolder;
                this.goToHomepageFolder(parentFolder);
                this.mobileSidebarOpen = false;
            } else {
                // On homepage → toggle files sidebar
                this.activePanel = 'files';
                this.mobileSidebarOpen = !this.mobileSidebarOpen;
            }
        },
        
        // ==================== GRAPH VIEW ====================
        
        // Initialize the graph visualization
        async initGraph() {
            // Check if vis is loaded
            if (typeof vis === 'undefined') {
                console.error('vis-network library not loaded');
                return;
            }
            
            const requestId = (this._graphRequestId || 0) + 1;
            this._graphRequestId = requestId;
            this.graphLoaded = false;
            
            try {
                // Full map by default. The sidebar toggle asks the server to
                // leave out notes stored under any folder whose name starts with "_".
                const graphUrl = this.hideUnderscoreFolders
                    ? '/api/graph?include_system_folders=false'
                    : '/api/graph';
                const response = await fetch(graphUrl);
                if (requestId !== this._graphRequestId) return;
                if (!response.ok) throw new Error('Failed to fetch graph data');
                const data = await response.json();
                if (requestId !== this._graphRequestId) return;
                this.graphData = data;
                
                // Get container
                const container = document.getElementById('graph-overlay');
                if (!container) return;
                
                // Get theme colors (force reflow to ensure CSS is applied)
                document.body.offsetHeight; // Force reflow
                const style = getComputedStyle(document.documentElement);
                
                // Helper to get CSS variable with fallback
                const getCssVar = (name, fallback) => {
                    const value = style.getPropertyValue(name).trim();
                    return value || fallback;
                };
                
                const accentPrimary = getCssVar('--accent-primary', '#7c3aed');
                const accentSecondary = getCssVar('--accent-secondary', '#a78bfa');
                const textPrimary = getCssVar('--text-primary', '#111827');
                const textSecondary = getCssVar('--text-secondary', '#6b7280');
                const bgPrimary = getCssVar('--bg-primary', '#ffffff');
                const bgSecondary = getCssVar('--bg-secondary', '#f3f4f6');
                const borderColor = getCssVar('--border-primary', '#e5e7eb');
                
                // Prepare nodes with styling - all nodes same base color
                const nodes = new vis.DataSet(data.nodes.map(n => ({
                    id: n.id,
                    label: n.label,
                    title: n.id, // Tooltip shows full path
                    color: {
                        background: accentPrimary,
                        border: accentPrimary,
                        highlight: {
                            background: accentPrimary,
                            border: textPrimary  // Darker border when selected
                        },
                        hover: {
                            background: accentSecondary,
                            border: accentPrimary
                        }
                    },
                    font: {
                        color: textPrimary,
                        size: 12,
                        face: 'system-ui, -apple-system, sans-serif'
                    },
                    borderWidth: this.currentNote === n.id ? 4 : 2,
                    chosen: {
                        node: (values) => {
                            values.size = 22;
                            values.borderWidth = 4;
                            values.borderColor = textPrimary;
                        }
                    }
                })));
                
                // Prepare edges with styling based on type
                const edges = new vis.DataSet(data.edges.map((e, i) => ({
                    id: i,
                    from: e.source,
                    to: e.target,
                    color: {
                        color: e.type === 'wikilink' ? accentPrimary : borderColor,
                        highlight: accentPrimary,
                        hover: accentSecondary,
                        opacity: 0.8
                    },
                    width: e.type === 'wikilink' ? 2 : 1,
                    smooth: {
                        type: 'continuous',
                        roundness: 0.5
                    },
                    chosen: {
                        edge: (values) => {
                            values.width = 3;
                            values.color = accentPrimary;
                        }
                    }
                })));
                
                // Network options
                const options = {
                    nodes: {
                        shape: 'dot',
                        size: 16,
                        borderWidth: 2,
                        shadow: {
                            enabled: true,
                            color: 'rgba(0,0,0,0.1)',
                            size: 5,
                            x: 2,
                            y: 2
                        }
                    },
                    edges: {
                        arrows: {
                            to: {
                                enabled: true,
                                scaleFactor: 0.5,
                                type: 'arrow'
                            }
                        }
                    },
                    physics: {
                        enabled: true,
                        solver: 'forceAtlas2Based',
                        forceAtlas2Based: {
                            gravitationalConstant: -50,
                            centralGravity: 0.01,
                            springLength: 100,
                            springConstant: 0.08,
                            damping: 0.4,
                            avoidOverlap: 0.5
                        },
                        stabilization: {
                            enabled: true,
                            iterations: 200,
                            updateInterval: 25
                        }
                    },
                    interaction: {
                        hover: true,
                        tooltipDelay: 200,
                        navigationButtons: false,  // Using custom buttons instead
                        keyboard: {
                            enabled: true,
                            bindToWindow: false
                        },
                        zoomView: true,
                        dragView: true
                    },
                    layout: {
                        improvedLayout: true,
                        randomSeed: 42
                    }
                };
                
                // Destroy existing instance if any
                if (this.graphInstance) {
                    this.graphInstance.destroy();
                    this.graphInstance = null;
                }
                
                // Clear container to ensure clean state
                const graphCanvas = container.querySelector('canvas');
                if (graphCanvas) graphCanvas.remove();
                const visElements = container.querySelectorAll('.vis-network, .vis-navigation');
                visElements.forEach(el => el.remove());
                
                // Create the network
                this.graphInstance = new vis.Network(container, { nodes, edges }, options);
                
                // Store reference for callbacks
                const graphRef = this.graphInstance;
                const currentNoteRef = this.currentNote;
                
                // Wait for stabilization
                this.graphInstance.once('stabilizationIterationsDone', () => {
                    graphRef.setOptions({ physics: { enabled: false } });
                    this.graphLoaded = true;
                    
                    // Focus and select current note if one is loaded
                    if (currentNoteRef) {
                        setTimeout(() => {
                            try {
                                if (graphRef && this.showGraph) {
                                    const nodeIds = graphRef.body.data.nodes.getIds();
                                    if (nodeIds.includes(currentNoteRef)) {
                                        // Focus on the node
                                        graphRef.focus(currentNoteRef, {
                                            scale: 1.2,
                                            animation: {
                                                duration: 500,
                                                easingFunction: 'easeInOutQuad'
                                            }
                                        });
                                        // Select the node to highlight it
                                        graphRef.selectNodes([currentNoteRef]);
                                    }
                                }
                            } catch (e) {
                                // Ignore - graph may have been destroyed
                            }
                        }, 150);
                    }
                });
                
                // Click event - open note
                this.graphInstance.on('click', (params) => {
                    if (params.nodes.length > 0) {
                        const noteId = params.nodes[0];
                        this.loadNote(noteId);
                        // Node is already selected by vis-network on click, no need to call selectNodes
                    }
                });
                
                // Double-click event - open note and close graph
                this.graphInstance.on('doubleClick', (params) => {
                    if (params.nodes.length > 0) {
                        const noteId = params.nodes[0];
                        // Close graph and load note
                        this.showGraph = false;
                        this.loadNote(noteId);
                    }
                });
                
                // Hover event - highlight connections
                this.graphInstance.on('hoverNode', (params) => {
                    const nodeId = params.node;
                    const connectedNodes = this.graphInstance.getConnectedNodes(nodeId);
                    const connectedEdges = this.graphInstance.getConnectedEdges(nodeId);
                    
                    // Dim all nodes except hovered and connected
                    const allNodes = nodes.getIds();
                    const updates = allNodes.map(id => ({
                        id,
                        opacity: (id === nodeId || connectedNodes.includes(id)) ? 1 : 0.2
                    }));
                    nodes.update(updates);
                });
                
                this.graphInstance.on('blurNode', () => {
                    // Reset all nodes to full opacity
                    const allNodes = nodes.getIds();
                    const updates = allNodes.map(id => ({ id, opacity: 1 }));
                    nodes.update(updates);
                });
                
                // Add legend to container
                this.addGraphLegend(container, accentPrimary, borderColor, textSecondary);
                
            } catch (error) {
                if (requestId !== this._graphRequestId) return;
                console.error('Failed to initialize graph:', error);
                this.graphLoaded = true; // Stop loading indicator
            }
        },
        
        // Add legend to graph container
        addGraphLegend(container, wikiColor, mdColor, textColor) {
            // Remove existing legend if any
            const existingLegend = container.querySelector('.graph-legend');
            if (existingLegend) existingLegend.remove();
            
            const legend = document.createElement('div');
            legend.className = 'graph-legend';
            legend.innerHTML = `
                <div class="graph-legend-item">
                    <span class="graph-legend-dot" style="background: ${wikiColor};"></span>
                    <span style="color: ${textColor};">Wikilinks</span>
                </div>
                <div class="graph-legend-item">
                    <span class="graph-legend-dot" style="background: ${mdColor};"></span>
                    <span style="color: ${textColor};">${this.t('graph.markdown_links')}</span>
                </div>
                <div style="margin-top: 8px; font-size: 10px; color: ${textColor}; opacity: 0.7;">
                    ${this.t('graph.click_hint')}
                </div>
            `;
            container.appendChild(legend);
        },
        
        // Refresh graph when theme changes
        refreshGraph() {
            if (this.viewMode === 'graph' && this.graphInstance) {
                this.initGraph();
            }
        }
    }
}
