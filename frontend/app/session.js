// A login that ends while the app is open: the app's own session (a 401), or a login
// in front of it such as Cloudflare Access, whose redirect to its login page makes a
// fetch fail outright. Either way the app says so and offers to log in again, keeping
// the open note's text across the login.

const LOGIN_RESTORE_KEY = 'keepItAfterLogin';
const LOGIN_RESTORE_MAX_AGE = 7 * 24 * 3600 * 1000;

function sessionFeature() {
    return {
        loginEnded: false,
        loginKeepFailed: false,  // the note couldn't be kept, so logging in would lose it
        _loginProbe: null,

        // Watches every call to our own API, wherever it's made
        watchLogin() {
            const nativeFetch = window.fetch.bind(window);
            const ownApi = (input) => {
                try {
                    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
                    return url.origin === location.origin && url.pathname.startsWith('/api/');
                } catch {
                    return false;
                }
            };
            window.fetch = async (input, init) => {
                try {
                    const response = await nativeFetch(input, init);
                    if (response.status === 401 && ownApi(input)) this.loginEnded = true;
                    return response;
                } catch (error) {
                    if (ownApi(input) && error?.name !== 'AbortError' && navigator.onLine) {
                        this._probeLogin(nativeFetch);
                    }
                    throw error;
                }
            };
        },

        // A failed fetch may be the network or a login redirect; a redirect we don't
        // follow tells them apart. One probe at a time.
        _probeLogin(nativeFetch) {
            if (this.loginEnded || this._loginProbe) return;
            this._loginProbe = nativeFetch('/api/config', { redirect: 'manual', cache: 'no-store' })
                .then((response) => {
                    if (response.type === 'opaqueredirect' || response.status === 401) this.loginEnded = true;
                })
                .catch(() => {})  // offline after all
                .finally(() => { this._loginProbe = null; });
        },

        // Reloading goes through the login, and back here with the note restored
        loginAgain({ force = false } = {}) {
            noteEditor?.flush();
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }
            if (this.currentNote && !force) {
                try {
                    localStorage.setItem(LOGIN_RESTORE_KEY, JSON.stringify({
                        path: this.currentNote,
                        content: this.noteContent,
                        hash: this.noteBaseHash,
                        at: Date.now(),
                    }));
                } catch (error) {
                    // Too big for storage, or storage is off: say so rather than lose it
                    console.warn('Could not keep the note for after the login:', error);
                    this.loginKeepFailed = true;
                    return;
                }
            }
            location.reload();
        },

        // After the login: the note kept by loginAgain() goes back where it was. Saving it
        // carries the old hash, so a note that changed meanwhile gets the conflict dialog.
        async restoreAfterLogin() {
            let kept = null;
            try {
                kept = JSON.parse(localStorage.getItem(LOGIN_RESTORE_KEY));
                localStorage.removeItem(LOGIN_RESTORE_KEY);
            } catch {
                return false;
            }
            if (!kept?.path || typeof kept.content !== 'string' || Date.now() - kept.at > LOGIN_RESTORE_MAX_AGE) return false;

            await this.loadNote(kept.path);
            if (this.currentNote !== kept.path) {
                // Deleted or moved meanwhile: keep the text as a copy rather than lose it
                const copy = await this._saveConflictCopy(kept.path, kept.content);
                if (copy) await this.loadNote(copy);
                return true;
            }
            if (kept.content !== this.noteContent) {
                this.noteBaseHash = kept.hash || null;
                this.noteContent = kept.content;  // the noteContent watcher puts it in the editor
                this.autoSave();
            }
            return true;
        },
    };
}
