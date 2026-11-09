// The drawing canvas for drawing-*.png files
function drawingFeature() {
    return {
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
    };
}
