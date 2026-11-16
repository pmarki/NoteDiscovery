// Attachments and folder files shown in a modal over the page, one at a time, with
// the files they were opened among to step through. The note underneath stays open.

const VIEWER_SWIPE_PX = 50;

function viewerFeature() {
    return {
        viewer: {
            open: false,
            items: [],   // { path, type } in the order shown where they were opened
            index: 0,
        },
        _viewerTouch: null,
        _viewerAfterClose: null,

        // `items` is the list the file was opened from; notes in it are skipped
        openViewer(items, path) {
            const files = (items || [])
                .map(item => ({ path: item.path, type: item.type !== 'note' ? item.type : this.getMediaType(item.path) }))
                .filter(item => item.type && item.type !== 'note');
            const index = files.findIndex(item => item.path === path);
            if (index === -1) {
                this.openItem(path);
                return;
            }
            const wasOpen = this.viewer.open;
            Object.assign(this.viewer, { open: true, items: files, index });
            this.mobileSidebarOpen = false;
            // Back closes the viewer instead of leaving the page underneath
            if (!wasOpen) history.pushState({ ...(history.state || {}), viewer: true }, '');
            this._viewerPreload();
        },

        // The other media files in the folder of `path`, in the tree's order
        viewerSiblings(path) {
            const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
            return this.notes
                .filter(item => item.type !== 'note' && (item.folder || '') === folder)
                .sort(this.getSortComparator());
        },

        viewerCurrent() {
            return this.viewer.open ? this.viewer.items[this.viewer.index] || null : null;
        },

        viewerUrl(item = this.viewerCurrent()) {
            return item ? `/api/media/${this.encodeVaultRelativePathForMediaApi(item.path)}` : '';
        },

        viewerName() {
            return this.viewerCurrent()?.path.split('/').pop() || '';
        },

        viewerMove(step) {
            const index = this.viewer.index + step;
            if (!this.viewer.open || index < 0 || index >= this.viewer.items.length) return;
            this.viewer.index = index;
            this._viewerPreload();
        },

        // The close button goes back, so the entry openViewer added doesn't linger;
        // popstate then lands here with fromHistory. `then` runs once it's closed.
        closeViewer({ fromHistory = false, then = null } = {}) {
            if (!this.viewer.open) return;
            if (then) this._viewerAfterClose = then;
            if (!fromHistory && history.state?.viewer) {
                history.back();
                return;
            }
            Object.assign(this.viewer, { open: false, items: [], index: 0 });
            const after = this._viewerAfterClose;
            this._viewerAfterClose = null;
            after?.();
        },

        // Arrow keys step only while nothing else (a dialog, a media control) wants them
        viewerKey(event) {
            if (!this.viewer.open || this.showConfirmModal) return;
            if (event.key === 'Escape') {
                this.closeViewer();
                return;
            }
            if (event.target.closest?.('input, textarea, audio, video, [contenteditable="true"]')) return;
            if (event.key === 'ArrowLeft') this.viewerMove(-1);
            else if (event.key === 'ArrowRight') this.viewerMove(1);
            else return;
            event.preventDefault();
        },

        viewerTouchStart(event) {
            const touch = event.changedTouches[0];
            this._viewerTouch = event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null;
        },

        viewerTouchEnd(event) {
            const start = this._viewerTouch;
            this._viewerTouch = null;
            if (!start) return;
            const touch = event.changedTouches[0];
            const dx = touch.clientX - start.x;
            const dy = touch.clientY - start.y;
            if (Math.abs(dx) < VIEWER_SWIPE_PX || Math.abs(dx) < Math.abs(dy)) return;
            this.viewerMove(dx < 0 ? 1 : -1);
        },

        viewerDownload() {
            const item = this.viewerCurrent();
            if (item) this._downloadMedia({ url: this.viewerUrl(item), name: this.viewerName() });
        },

        viewerOpenNewTab() {
            const url = this.viewerUrl();
            if (url) window.open(url, '_blank', 'noopener');
        },

        viewerEditDrawing() {
            const item = this.viewerCurrent();
            if (!item) return;
            // After the step back in history, which would otherwise undo viewMedia's own
            this.closeViewer({ then: () => this.viewMedia(item.path, 'drawing') });
        },

        viewerDelete() {
            const item = this.viewerCurrent();
            if (item) this.deleteMedia(item.path);
        },

        // A deleted file leaves the viewer, which shows the next one or closes
        _viewerForget(path) {
            const index = this.viewer.items.findIndex(item => item.path === path);
            if (!this.viewer.open || index === -1) return;
            this.viewer.items.splice(index, 1);
            if (this.viewer.items.length === 0) {
                this.closeViewer();
                return;
            }
            if (index < this.viewer.index || this.viewer.index >= this.viewer.items.length) this.viewer.index -= 1;
            this._viewerPreload();
        },

        // The images either side, so a step shows them at once
        _viewerPreload() {
            for (const step of [-1, 1]) {
                const item = this.viewer.items[this.viewer.index + step];
                if (item && (item.type === 'image' || item.type === 'drawing')) new Image().src = this.viewerUrl(item);
            }
        },
    };
}
