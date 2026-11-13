// Line diff for the save-conflict dialog (Myers, O((N+M)·D))

// More edits than this and the two texts are shown as one removed and one added
// block: a diff that size says no more, and finding it could freeze the tab.
const DIFF_MAX_EDITS = 2000;

// Lines of a and b as [{type: 'same'|'del'|'add', text}], a's lines first in a change.
// Lines that differ only in trailing spaces count as the same and show b's text: the
// editor writes a paragraph's line breaks as "  " once it's edited, which changes
// nothing a reader sees.
function diffLines(a, b) {
    const split = (text) => {
        if (!text) return [];
        const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
        // A final newline doesn't make an empty last line
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
        return lines;
    };
    const x = split(a);
    const y = split(b);
    const xk = x.map(line => line.trimEnd());
    const yk = y.map(line => line.trimEnd());

    // Lines both start and end with need no search
    let head = 0;
    while (head < x.length && head < y.length && xk[head] === yk[head]) head++;
    let tail = 0;
    while (tail < x.length - head && tail < y.length - head
        && xk[x.length - 1 - tail] === yk[y.length - 1 - tail]) tail++;

    // Edits as [type, index in x or y] over the lines between
    const xs = xk.slice(head, x.length - tail);
    const ys = yk.slice(head, y.length - tail);
    const edits = myers(xs, ys) || [
        ...xs.map((_, i) => ['del', i]),
        ...ys.map((_, j) => ['add', j]),
    ];
    const ops = y.slice(0, head).map(text => ({ type: 'same', text }));
    for (const [type, index] of edits) {
        const text = type === 'del' ? x[head + index] : y[head + index];
        ops.push({ type, text });
    }
    ops.push(...y.slice(y.length - tail).map(text => ({ type: 'same', text })));
    return ops;
}

// The shortest edit script from x to y, or null past DIFF_MAX_EDITS
function myers(x, y) {
    const n = x.length;
    const m = y.length;
    const max = Math.min(n + m, DIFF_MAX_EDITS);
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let i = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]))
                ? v[offset + k + 1]
                : v[offset + k - 1] + 1;
            let j = i - k;
            while (i < n && j < m && x[i] === y[j]) { i++; j++; }
            v[offset + k] = i;
            if (i >= n && j >= m) return backtrack(trace, n, m, offset);
        }
    }
    return null;
}

// Walks the saved frontiers back from the end to recover the edits: ['same', j],
// ['del', i] or ['add', j]
function backtrack(trace, n, m, offset) {
    const edits = [];
    let i = n;
    let j = m;
    for (let d = trace.length - 1; d >= 0; d--) {
        const v = trace[d];
        const k = i - j;
        const down = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
        const prevK = down ? k + 1 : k - 1;
        const prevI = v[offset + prevK];
        const prevJ = prevI - prevK;
        while (i > prevI && j > prevJ) { i--; edits.push(['same', --j]); }
        if (d > 0) {
            if (down) edits.push(['add', --j]);
            else edits.push(['del', --i]);
        }
    }
    edits.reverse();
    // Within a change, removed lines read better before added ones
    const sorted = [];
    for (let s = 0; s < edits.length;) {
        if (edits[s][0] === 'same') { sorted.push(edits[s]); s++; continue; }
        let e = s;
        while (e < edits.length && edits[e][0] !== 'same') e++;
        const run = edits.slice(s, e);
        sorted.push(...run.filter(edit => edit[0] === 'del'), ...run.filter(edit => edit[0] === 'add'));
        s = e;
    }
    return sorted;
}

// Unchanged runs longer than 2 × context fold to {type: 'fold', count}, keeping
// `context` lines around each change.
function foldDiff(ops, context = 3) {
    const rows = [];
    for (let s = 0; s < ops.length;) {
        if (ops[s].type !== 'same') { rows.push(ops[s]); s++; continue; }
        let e = s;
        while (e < ops.length && ops[e].type === 'same') e++;
        const keepBefore = s === 0 ? 0 : context;          // after a change
        const keepAfter = e === ops.length ? 0 : context;  // before a change
        if (e - s - keepBefore - keepAfter >= 2) {  // folding one line saves nothing
            rows.push(...ops.slice(s, s + keepBefore));
            rows.push({ type: 'fold', count: e - s - keepBefore - keepAfter });
            rows.push(...ops.slice(e - keepAfter, e));
        } else {
            rows.push(...ops.slice(s, e));
        }
        s = e;
    }
    return rows;
}

if (typeof module !== 'undefined') module.exports = { diffLines, foldDiff };
