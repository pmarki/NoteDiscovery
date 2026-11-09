// New notes and folders, and the name, rename and confirm dialogs
function createFeature() {
    return {
        // Split view resize state
        
        // Dropdown state
        showNewDropdown: false,
        dropdownTargetFolder: null, // Folder context for "New" dropdown ('' = root, null = not set)
        dropdownPosition: { top: 0, left: 0 }, // Position for contextual dropdown
        newButtonAction: 'chooser',
        autoFillNoteTitle: false,
        
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
            
            // The rename can rewrite the open note's links, so its edits go first
            await this._commitPendingEdits();
            
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
                await this._reloadIfUpdated(await response.json());
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
    };
}
