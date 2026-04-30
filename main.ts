import { App, normalizePath, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, setIcon, WorkspaceLeaf, FileView, moment } from 'obsidian';
import { I18n } from "./i18n";
import type { LangType, LangTypeAndAuto, TransItemType } from "./i18n";

const ADD_PATH_MAX = 6;
const PASSWORD_LENGTH_MIN = 1;
const PASSWORD_LENGTH_MAX = 20;
const ENCRYPT_KEY = 30;
const ROOT_PATH = normalizePath("/");

interface EmergencyCode {
    hash: string;
    salt: string;
}

interface PasswordPluginSettings {
    // the protected path: the default value is root path
    protectedPath: string;

    // more protected paths
    addedProtectedPath: string[];

    // if the password protection is enabled
    protectEnabled: boolean;

    // the password hash (PBKDF2) or legacy Caesar-cipher value
    password: string;

    // hex-encoded 16-byte random salt; empty means legacy format
    salt: string;

    // single-use emergency unlock codes (stored as PBKDF2 hashes)
    emergencyCodes: EmergencyCode[];

    // the language type, it can be 'auto' or a specific language code
    lang: LangTypeAndAuto;

    // when the auto lock interval is set, it will auto lock the password protection after the interval
    autoLockInterval: number;

    // the password hint question, it will be shown when the password is not correct
    pwdHintQuestion: string;

    // whether to show the lock button in the left sidebar
    showLockButton: boolean;

    // if the last verify password is correct, it will be used to determine if the password protection should be closed
    isLastVerifyPasswordCorrect: boolean;

    // close the obsidian and open it again, if the time difference is less than 2 seconds, it will be considered as the last verify password is correct
    timeOnUnload: moment.Moment | number;
}

const DEFAULT_SETTINGS: PasswordPluginSettings = {
    protectedPath: ROOT_PATH,
    addedProtectedPath: [],
    protectEnabled: false,
    password: '',
    salt: '',
    emergencyCodes: [],
    lang: "auto",
    autoLockInterval: 0,
    pwdHintQuestion: '',
    isLastVerifyPasswordCorrect: false,
    timeOnUnload: 0,
    showLockButton: true
}

export default class PasswordPlugin extends Plugin {
    settings: PasswordPluginSettings;
    isVerifyPasswordWaitting: boolean = false;
    isVerifyPasswordCorrect: boolean = false;
    isAutoLockRegistered: boolean = false;
    lastUnlockOrOpenFileTime: moment.Moment | null = null;

    passwordRibbonBtn: HTMLElement;
    lockVaultRibbonBtn: HTMLElement;
    i18n: I18n;

    t = (x: TransItemType, vars?: any) => {
        return this.i18n.t(x, vars);
    };

    async onload() {
        await this.loadSettings();

        this.lastUnlockOrOpenFileTime = moment();

        // check if the protected path is empty, if so, set to root path
        this.settings.protectedPath = this.settings.protectedPath.trim();
        if (this.settings.protectedPath.length == 0 ) {
            this.settings.protectedPath = ROOT_PATH;
        }

        // check if the added protected path array exceed the limit, if so, remove the extra
        if (this.settings.addedProtectedPath.length > ADD_PATH_MAX) {
            this.settings.addedProtectedPath.slice(ADD_PATH_MAX, this.settings.addedProtectedPath.length - ADD_PATH_MAX);
        }

        // check if the added protected path is empty, if so, remove it
        this.settings.addedProtectedPath = this.settings.addedProtectedPath.filter(str => str.trim() !== '');

        // lang should be load early, but after settings
        this.i18n = new I18n(this.settings.lang, async (lang: LangTypeAndAuto) => {
            this.settings.lang = lang;
            await this.saveSettings();
        });

        // This creates an icon in the left ribbon.
        this.passwordRibbonBtn = this.addRibbonIcon('lock', this.t("open_password_protection"), (evt: MouseEvent) => {
            this.openPasswordProtection();
        });

        // Lock vault ribbon button (shown/hidden by setting)
        this.lockVaultRibbonBtn = this.addRibbonIcon('lock', this.t("lock_vault"), () => {
            this.enablePasswordProtection();
        });
        this.lockVaultRibbonBtn.style.display = this.settings.showLockButton ? '' : 'none';

        // This adds a simple command that can be triggered anywhere
        this.addCommand({
            id: 'Open password protection',
            name: this.t("open"),
            callback: () => {
                this.enablePasswordProtection();
            }
        });

        // Lock vault command with default Cmd+L / Ctrl+L shortcut
        this.addCommand({
            id: 'lock-vault',
            name: this.t("lock_vault"),
            hotkeys: [{ modifiers: ["Mod"], key: "l" }],
            callback: () => {
                this.enablePasswordProtection();
            }
        });

        // This adds a settings tab so that the user can configure various aspects of the plugin
        this.addSettingTab(new PasswordSettingTab(this.app, this));

        // when the layout is ready, check if the root folder need to be protected, if so, show the password dialog
        this.app.workspace.onLayoutReady(() => {
            if (this.settings.protectEnabled && this.isIncludeRootPath()) {
                if (!this.isVerifyPasswordCorrect) {
                    let curTime = moment();
                    if (curTime.diff(this.settings.timeOnUnload, 'second') <= 2 && this.settings.isLastVerifyPasswordCorrect) {
                        this.isVerifyPasswordCorrect = true;
                    } else {
                        this.verifyPasswordProtection(false);
                    }
                }
            }
        });

        // when the file opened, check if it need to be protected, if so, show the password dialog
        this.registerEvent(this.app.workspace.on('file-open', (file: TFile | null) => {
            if (file != null) {
                this.autoLockCheck();
                if (this.settings.protectEnabled && !this.isVerifyPasswordCorrect && this.isProtectedFile(file.path)) {
                    this.verifyPasswordProtection(false);
                }
                // update the time of last open file, the file may be protected and may be not.
                if (this.settings.protectEnabled && this.isVerifyPasswordCorrect) {
                    this.lastUnlockOrOpenFileTime = moment();
                }
            }
        }));

        // when the search view opened, check if it need to be protected, if so, show the password dialog.
        this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf | null) => {
            if (leaf != null && leaf.view != null) {
                let viewType = leaf.view.getViewType();
                if (viewType == 'search') {
                    this.autoLockCheck();
                    if (this.settings.protectEnabled && !this.isVerifyPasswordCorrect) {
                        // show the password dialog
                        this.verifyPasswordProtection(true);
                    }
                    // update the time of last search view actived.
                    if (this.settings.protectEnabled && this.isVerifyPasswordCorrect) {
                        this.lastUnlockOrOpenFileTime = moment();
                    }
                }
            }
        }));

        // listen the rename event
        this.app.vault.on('rename', this.handleRename);

        // listen the save event of file modified.
        this.app.vault.on('modify', this.handleFileModify);

        // When registering intervals, this function will automatically clear the interval when the plugin is disabled.
        this.registerAutoLock();
    }

    async onunload() {
        this.app.vault.off('modify', this.handleFileModify);
        this.app.vault.off('rename', this.handleRename);

        this.settings.isLastVerifyPasswordCorrect = this.isVerifyPasswordCorrect;
        this.settings.timeOnUnload = moment();
        await this.saveSettings();
    }

    private handleRename = (
        file: TFile,       // the file after rename
        oldPath: string    // the old path of the file
    ) => {
        if (file != null) {
            if (this.settings.protectEnabled && !this.isVerifyPasswordCorrect && (this.isProtectedFile(oldPath) || this.isProtectedFile(file.path))) {
                this.verifyPasswordProtection(false);
            }
            if (this.settings.protectEnabled && this.isProtectedFile(oldPath)) {
                this.ReplaceProtectedPath(oldPath, file.path);
            }
            // update the time of last open file, the file may be protected and may be not.
            if (this.settings.protectEnabled && this.isVerifyPasswordCorrect) {
                this.lastUnlockOrOpenFileTime = moment();
            }
        }
    };

    // process the save event of file modified.
    private handleFileModify = (file: TFile) => {
        this.lastUnlockOrOpenFileTime = moment();
    }

    registerAutoLock() {
        if (this.settings.protectEnabled && this.settings.autoLockInterval > 0 && !this.isAutoLockRegistered) {
            this.isAutoLockRegistered = true;
            this.registerInterval(window.setInterval(() => this.autoLockCheck(), 10 * 1000));
        }
    }

    autoLockCheck() {
        if (this.settings.protectEnabled && this.isVerifyPasswordCorrect && this.settings.autoLockInterval > 0) {
            let curTime = moment();
            if (curTime.diff(this.lastUnlockOrOpenFileTime, 'minute') >= this.settings.autoLockInterval) {
                if (this.isProtectFileOpened()) {
                    this.isVerifyPasswordCorrect = false;
                    this.verifyPasswordProtection(false);
                } else {
                    this.isVerifyPasswordCorrect = false;
                }
            }
        }
    }

    // check if the file opened need to be protected.
    isProtectFileOpened(): boolean {
        let leaves: WorkspaceLeaf[] = [];
        let isOpened = false;

        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof FileView && leaf.view.file != null) {
                if (!isOpened) {
                    isOpened = this.isProtectedFile(leaf.view.file.path);
                }
            }
        });

        return isOpened;
    }

    // close notes
    async closeLeaves() {
        let leaves: WorkspaceLeaf[] = [];

        this.app.workspace.iterateAllLeaves((leaf) => {
            leaves.push(leaf);
        });

        const emptyLeaf = async (leaf: WorkspaceLeaf): Promise<void> => {
            leaf.setViewState({ type: 'empty' });
        }

        for (const leaf of leaves) {
            if (leaf.view instanceof FileView && leaf.view.file != null) {
                let needClose = this.isProtectedFile(leaf.view.file.path);
                if (needClose) {
                    await emptyLeaf(leaf);
                    leaf.detach();
                }
            }
        }
    }

    // enable password protection
    enablePasswordProtection() {
        if (!this.settings.protectEnabled) {
            new Notice(this.t("notice_set_password"));
        } else {
            if (this.isVerifyPasswordCorrect) {
                this.isVerifyPasswordCorrect = false;
                this.closeLeaves();
            }
        }
    }

    updateLockRibbonButton() {
        if (this.lockVaultRibbonBtn) {
            this.lockVaultRibbonBtn.style.display = this.settings.showLockButton ? '' : 'none';
        }
    }

    // open or guide in password protection
    openPasswordProtection() {
        if (!this.settings.protectEnabled) {
            new Notice(this.t("notice_set_password"));
        } else {
            if (this.isVerifyPasswordCorrect) {
                this.isVerifyPasswordCorrect = false;
            }

            this.verifyPasswordProtection(false);
        }
    }

    // verify password protection
    verifyPasswordProtection(forbidCloseModal: boolean) {
        if (!this.isVerifyPasswordWaitting) {
            const setModal = new VerifyPasswordModal(this.app, this, forbidCloseModal, () => {
                if (this.isVerifyPasswordCorrect) {
                    new Notice(this.t("password_protection_closed"));
                } else {
                    this.closeLeaves();
                }
            }).open();
        }
    }

    // check if the root folder need to be protected
    isIncludeRootPath(): boolean {
        if (this.settings.protectedPath == ROOT_PATH) {
            return true;
        }

        for (let i = 0; i < this.settings.addedProtectedPath.length; i++) {
            if (this.settings.addedProtectedPath[i] == ROOT_PATH) {
                return true;
            }
        }

        return false;
    }

    // check if the filepath need to be protected
    isProtectedFile(filePath: string): boolean {
        if (filePath == "") {
            return false;
        }

        if (this.isIncludeRootPath()) {
            return true;
        }

        let path = normalizePath(filePath);
        let protectedPath = normalizePath(this.settings.protectedPath);

        if (this.IsChildPath(path, protectedPath)) {
            return true;
        }

        for (let i = 0; i < this.settings.addedProtectedPath.length; i++) {
            protectedPath = normalizePath(this.settings.addedProtectedPath[i]);

            if (protectedPath.length == 0) {
                continue;
            }
            if (path.length < protectedPath.length) {
                continue;
            }
            if (this.IsChildPath(path, protectedPath)) {
                return true;
            }
        }

        return false;
    }

    // check if the protectedPath is the child part of path.
    IsChildPath(path: string, protectedPath: string): boolean {
        if (protectedPath.length > 0 && path.length >= protectedPath.length) {
            if (path.toLowerCase().startsWith(protectedPath.toLowerCase())) {
                if (path.length == protectedPath.length) {
                    return true;
                } else {
                    if (path[protectedPath.length] == '/' ||
                        path[protectedPath.length] == '\\' ||
                        path[protectedPath.length] == '.') {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    // Replace the protected path in the config use new path renamed
    ReplaceProtectedPath(oldPath: string, newPath: string): boolean {
        if (oldPath == "" || newPath == "" ) {
            return false;
        }

        let oldProtectPath = normalizePath(this.removeFileExtension(oldPath));
        let newProtectPath = normalizePath(this.removeFileExtension(newPath));
        let protectedPath = "";

        if (this.settings.protectedPath.trim() != ROOT_PATH) {
            protectedPath = normalizePath(this.settings.protectedPath);

            if (oldProtectPath.toLowerCase() == protectedPath.toLowerCase()) {
                this.settings.protectedPath = newProtectPath;
                this.saveSettings();
                return true;
            }
        }

        for (let i = 0; i < this.settings.addedProtectedPath.length; i++) {
            protectedPath = this.settings.addedProtectedPath[i];
            if (protectedPath.trim() != ROOT_PATH) {
                protectedPath = normalizePath(protectedPath);

                if (oldProtectPath.toLowerCase() == protectedPath.toLowerCase()) {
                    this.settings.addedProtectedPath[i] = newProtectPath;
                    this.saveSettings();
                    return true;
                }
            }
        }

        return false;
    }

    // remove the ext of file path
    removeFileExtension(fullPath: string): string {
        const lastDotIndex = fullPath.lastIndexOf('.');

        const lastSeparatorIndex = Math.max(
            fullPath.lastIndexOf('/'),
            fullPath.lastIndexOf('\\')
        );

        if (lastDotIndex === -1 || lastDotIndex <= lastSeparatorIndex) {
            return fullPath;
        }

        return fullPath.substring(0, lastDotIndex);
    }

    generateSalt(): string {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async hashPassword(password: string, saltHex: string): Promise<string> {
        const encoder = new TextEncoder();
        const saltBytes = new Uint8Array(saltHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
        const keyMaterial = await crypto.subtle.importKey(
            "raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
        );
        const bits = await crypto.subtle.deriveBits(
            { name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" },
            keyMaterial, 256
        );
        return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    generateEmergencyCodeString(): string {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const segment = (n: number) =>
            Array.from(crypto.getRandomValues(new Uint8Array(n)))
                 .map(b => chars[b % chars.length]).join('');
        return `${segment(4)}-${segment(4)}-${segment(4)}`;
    }

    async generateEmergencyCodes(): Promise<{ codes: string[], hashed: EmergencyCode[] }> {
        const codes: string[] = [];
        const hashed: EmergencyCode[] = [];
        for (let i = 0; i < 5; i++) {
            const code = this.generateEmergencyCodeString();
            const salt = this.generateSalt();
            const hash = await this.hashPassword(code, salt);
            codes.push(code);
            hashed.push({ hash, salt });
        }
        return { codes, hashed };
    }

    // kept for migrating legacy Caesar-cipher passwords
    decrypt(text: string, key: number): string {
        let result = "";
        for (let i = 0; i < text.length; i++) {
            let charCode = text.charCodeAt(i);
            if (charCode >= 33 && charCode <= 90) {
                result += String.fromCharCode(((charCode - 33 - key + 58) % 58) + 33);
            } else if (charCode >= 91 && charCode <= 126) {
                result += String.fromCharCode(((charCode - 91 - key + 36) % 36) + 91);
            } else {
                result += text.charAt(i);
            }
        }
        return result;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

class PasswordSettingTab extends PluginSettingTab {
    plugin: PasswordPlugin;
    pathInputSettings: Setting[] = [];

    constructor(app: App, plugin: PasswordPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;

        containerEl.empty();

        // Lock or Unlock password protection
        new Setting(containerEl)
            .setName(this.plugin.t("setting_toggle_name"))
            .setDesc(this.plugin.t("setting_toggle_desc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.protectEnabled)
                    .onChange((value) => {
                        if (value) {
                            this.plugin.settings.protectEnabled = false;
                            const setModal = new SetPasswordModal(this.app, this.plugin, () => {
                                if (this.plugin.settings.protectEnabled) {
                                    this.plugin.isVerifyPasswordCorrect = false;
                                    this.plugin.saveSettings();
                                    this.plugin.closeLeaves();
                                    this.plugin.registerAutoLock();
                                }
                                this.display();
                            }).open();
                        } else {
                            if (!this.plugin.isVerifyPasswordWaitting) {
                                const setModal = new VerifyPasswordModal(this.app, this.plugin, false, () => {
                                    if (this.plugin.isVerifyPasswordCorrect) {
                                        this.plugin.settings.protectEnabled = false;
                                        this.plugin.saveSettings();
                                    }
                                    this.display();
                                }).open();
                            }
                        }
                    })
            );

        new Setting(containerEl)
            .setName(this.plugin.t("setting_show_lock_button_name"))
            .setDesc(this.plugin.t("setting_show_lock_button_desc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.showLockButton)
                    .onChange(async (value) => {
                        this.plugin.settings.showLockButton = value;
                        await this.plugin.saveSettings();
                        this.plugin.updateLockRibbonButton();
                    })
            );

        containerEl.createEl("h6", { text: this.plugin.t("before_open_protection") });

        new Setting(containerEl)
            .setName(this.plugin.t("auto_lock_interval_name"))
            .setDesc(this.plugin.t("auto_lock_interval_desc"))
            .addText(text => text
                .setPlaceholder("0")
                .setValue(this.plugin.settings.autoLockInterval.toString())
                .onChange(async (value) => {
                    value = value.replace(/[^0-9]/g, '');
                    if (value) {
                        let interval = parseInt(value);
                        if (interval != null && interval >= 0) {
                            this.plugin.settings.autoLockInterval = interval;
                        }
                    }
                }))
            .setDisabled(this.plugin.settings.protectEnabled);

        new Setting(containerEl)
            .setName(this.plugin.t("setting_pwd_hint_question_name"))
            .setDesc(this.plugin.t("setting_pwd_hint_question_desc"))
            .addText(text => text
                .setPlaceholder(this.plugin.t("place_holder_enter_pwd_hint_question"))
                .setValue(this.plugin.settings.pwdHintQuestion)
                .onChange(async (value) => {
                    if (typeof (value) !== 'string' || value.length > PASSWORD_LENGTH_MAX) {
                        return;
                    }
                    this.plugin.settings.pwdHintQuestion = value;
                }))
            .setDisabled(this.plugin.settings.protectEnabled);

        // The default protected path input
        new Setting(containerEl)
            .setName(this.plugin.t("setting_folder_name"))
            .setDesc(this.plugin.t("setting_folder_desc"))
            .addText(text => text
                .setPlaceholder(this.plugin.t("place_holder_enter_path"))
                .setValue(this.plugin.settings.protectedPath)
                .onChange(async (value) => {
                    let path = value.trim();
                    if (path == "") {
                        path = ROOT_PATH;
                    }
                    this.plugin.settings.protectedPath = path;
                }))
            .setDisabled(this.plugin.settings.protectEnabled);

        // Add more protected paths, or remove them
        new Setting(containerEl)
            .setName(this.plugin.t("setting_more_path"))
            .setDesc("")
            .addButton((button) =>
                button
                    .setButtonText(this.plugin.t("setting_add_path"))
                    .onClick(async () => {
                        if (this.plugin.settings.addedProtectedPath.length < ADD_PATH_MAX) {
                            this.addPathInput(this.plugin.settings.addedProtectedPath.length, "");
                            this.plugin.settings.addedProtectedPath.push("");
                            this.plugin.saveSettings();
                        }
                    })
                    .setDisabled(this.plugin.settings.protectEnabled || this.plugin.settings.addedProtectedPath.length >= ADD_PATH_MAX))
            .addButton((button) =>
                button
                    .setButtonText(this.plugin.t("setting_remove_path"))
                    .onClick(async () => {
                        if (this.plugin.settings.addedProtectedPath.length > 0) {
                            this.removePathInput();
                            this.plugin.settings.addedProtectedPath.pop();
                            this.plugin.saveSettings();
                        }
                    })
                    .setDisabled(this.plugin.settings.protectEnabled || this.plugin.settings.addedProtectedPath.length >= ADD_PATH_MAX));

        // Add the protected paths input based on the last settings
        for (let i = 0; i < this.plugin.settings.addedProtectedPath.length && i < ADD_PATH_MAX; i++) {
            this.addPathInput(i, this.plugin.settings.addedProtectedPath[i]);
        }

        new Setting(containerEl)
            .setName(this.plugin.t("setting_emergency_codes_name"))
            .setDesc(this.plugin.t("setting_emergency_codes_desc"))
            .addButton((button) =>
                button
                    .setButtonText(this.plugin.t("setting_emergency_codes_btn"))
                    .onClick(() => {
                        new VerifyPasswordModal(this.app, this.plugin, false, async () => {
                            if (this.plugin.isVerifyPasswordCorrect) {
                                const { codes, hashed } = await this.plugin.generateEmergencyCodes();
                                this.plugin.settings.emergencyCodes = hashed;
                                await this.plugin.saveSettings();
                                new EmergencyCodesModal(this.app, this.plugin, codes).open();
                            }
                        }).open();
                    })
                    .setDisabled(!this.plugin.settings.protectEnabled));
    }

    // Add the protected paths input 
    addPathInput(index: number, initPath: string) {
        const { containerEl } = this;

        let setting = new Setting(containerEl)
            .setName(this.plugin.t("setting_add_path_name"))
            .setClass("setting_add_path_input")
            .addText(text => text
                .setPlaceholder(this.plugin.t("setting_add_path_place_holder"))
                .setValue(initPath)
                .onChange(async (value) => {
                    let path = value.trim();
                    if (path == "") {
                        path = ROOT_PATH;
                    }
                    this.plugin.settings.addedProtectedPath[index] = path;
                }))
            .setDisabled(this.plugin.settings.protectEnabled);
        this.pathInputSettings.push(setting);
    }

    // Remove the protected paths input
    removePathInput() {
        const { containerEl } = this;

        if (this.pathInputSettings.length == 0) {
            return;
        }

        let pathInput = this.pathInputSettings.pop() as Setting;
        containerEl.removeChild(pathInput.settingEl);
    }
}

class SetPasswordModal extends Modal {
    plugin: PasswordPlugin;
    onSubmit: () => void;

    constructor(app: App, plugin: PasswordPlugin, onSubmit: () => void) {
        super(app);
        this.plugin = plugin;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        const inputHint = [
            this.plugin.t("hint_enter_in_both_boxes"),
            this.plugin.t("hint_password_must_match"),
            this.plugin.t("hint_password_length"),
            this.plugin.t("hint_password_valid_character")];

        contentEl.createEl("h2", { text: this.plugin.t("set_password_title") });

        // make a div for user's password input
        const inputPwContainerEl = contentEl.createDiv();
        inputPwContainerEl.style.marginBottom = '1em';
        const pwInputEl = inputPwContainerEl.createEl('input', { type: 'password', value: '' });
        pwInputEl.placeholder = this.plugin.t("place_holder_enter_password");
        pwInputEl.style.width = '70%';
        pwInputEl.focus();

        // make a div for password confirmation
        const confirmPwContainerEl = contentEl.createDiv();
        confirmPwContainerEl.style.marginBottom = '1em';
        const pwConfirmEl = confirmPwContainerEl.createEl('input', { type: 'password', value: '' });
        pwConfirmEl.placeholder = this.plugin.t("confirm_password");
        pwConfirmEl.style.width = '70%';

        //message modal - to fire if either input is empty
        const messageEl = contentEl.createDiv();
        messageEl.style.marginBottom = '1em';
        messageEl.setText(this.plugin.t("hint_enter_in_both_boxes"));
        messageEl.show();

        // switch hint text
        const switchHint = (color: string, index: number) => {
            messageEl.style.color = color;
            messageEl.setText(inputHint[index]);
        }

        pwInputEl.addEventListener('input', (event) => {
            switchHint('', 0);
        });

        pwConfirmEl.addEventListener('input', (event) => {
            switchHint('', 0);
        });

        // check the confirm
        const pwConfirmChecker = () => {
            // is either input and confirm field empty?
            if (pwInputEl.value == '' || pwConfirmEl.value == '') {
                switchHint('red', 0);
                return false;
            }

            // is password invalid?
            if (typeof (pwInputEl.value) !== 'string' || pwInputEl.value.length < PASSWORD_LENGTH_MIN || pwInputEl.value.length > PASSWORD_LENGTH_MAX) {
                switchHint('red', 2);
                return false;
            }

            // do both password inputs match?
            if (pwInputEl.value !== pwConfirmEl.value) {
                switchHint('red', 1);
                return false;
            }
            switchHint('', 0);
            return true;
        }

        // check the input and confirm
        const pwChecker = async (ev: Event | null) => {
            ev?.preventDefault();

            let goodToGo = pwConfirmChecker();
            if (!goodToGo) {
                return;
            }

            //deal with accents - normalize Unicode
            let password = pwInputEl.value.normalize('NFC');
            const salt = this.plugin.generateSalt();
            const hash = await this.plugin.hashPassword(password, salt);
            const { codes, hashed } = await this.plugin.generateEmergencyCodes();

            this.plugin.settings.salt = salt;
            this.plugin.settings.password = hash;
            this.plugin.settings.emergencyCodes = hashed;
            this.plugin.settings.protectEnabled = true;
            this.close();

            new EmergencyCodesModal(this.app, this.plugin, codes).open();
        }

        // cancel the modal
        const cancelEnable = (ev: Event | null) => {
            ev?.preventDefault();
            this.close();
        }

        // Press enter key to jump to next editbox.
        pwInputEl.addEventListener('keypress', (event) => {
            if (event.key === 'Enter') {
                pwConfirmEl.focus();
            }
        });

        // Press enter key to set password.
        pwConfirmEl.addEventListener('keypress', (event) => {
            if (event.key === 'Enter') {
                pwChecker(null);
            }
        });

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText(this.plugin.t("ok"))
                    .setCta()
                    .onClick(() => {
                        pwChecker(null);
                    }))
            .addButton((btn) =>
                btn
                    .setButtonText(this.plugin.t("cancel"))
                    .onClick(() => {
                        cancelEnable(null);
                    }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        this.onSubmit();
    }
}

class VerifyPasswordModal extends Modal {
    plugin: PasswordPlugin;
	forbidCloseModal: boolean;
    onSubmit: () => void;

    constructor(app: App, plugin: PasswordPlugin, forbidCloseModal: boolean, onSubmit: () => void) {
        super(app);
        this.plugin = plugin;
        this.plugin.isVerifyPasswordWaitting = true;
        this.plugin.isVerifyPasswordCorrect = false;
		this.forbidCloseModal = forbidCloseModal;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        if (this.forbidCloseModal) {
           const { modalEl } = this;
           const closeButton = modalEl.getElementsByClassName('modal-close-button')[0];
           if (closeButton != null) {
               closeButton.setAttribute('style', 'display: none;');
           }
        }

        Object.assign(this.app.workspace.containerEl.style, {
            filter: "blur(8px)",
        } as CSSStyleDeclaration);

        const { contentEl } = this;
        contentEl.empty();

        // title - to let the user know what the modal will do
        contentEl.createEl("h2", { text: this.plugin.t("verify_password") });

        // make a div for user's password input
        const inputPwContainerEl = contentEl.createDiv();
        inputPwContainerEl.style.marginBottom = '1em';
        const pwInputEl = inputPwContainerEl.createEl('input', { type: 'password', value: '' });
        pwInputEl.placeholder = this.plugin.t("enter_password");
        pwInputEl.style.width = '70%';

        //message modal - to fire if either input is empty
        const messageEl = contentEl.createDiv();
        messageEl.style.marginBottom = '1em';
        messageEl.setText(this.plugin.t("enter_password_to_verify"));
        messageEl.show();

        pwInputEl.addEventListener('input', (event) => {
            messageEl.style.color = '';
            messageEl.setText(this.plugin.t("enter_password_to_verify"));
        });

        // check the confirm input
        const pwConfirmChecker = async (): Promise<boolean> => {
            // is either input and confirm field empty?
            if (pwInputEl.value == '') {
                messageEl.style.color = 'red';
                messageEl.setText(this.plugin.t("password_is_empty"));
                return false;
            }

            // is password invalid?
            if (typeof (pwInputEl.value) !== 'string' || pwInputEl.value.length < PASSWORD_LENGTH_MIN || pwInputEl.value.length > PASSWORD_LENGTH_MAX) {
                messageEl.style.color = 'red';
                messageEl.setText(this.plugin.t("password_not_match"));
                return false;
            }

            //deal with accents - normalize Unicode
            let password = pwInputEl.value.normalize('NFC');

            let isCorrect: boolean;
            if (!this.plugin.settings.salt) {
                // Legacy format: verify with old Caesar cipher and auto-migrate to PBKDF2
                const oldDecrypted = this.plugin.decrypt(this.plugin.settings.password, ENCRYPT_KEY);
                if (password === oldDecrypted) {
                    const salt = this.plugin.generateSalt();
                    const hash = await this.plugin.hashPassword(password, salt);
                    this.plugin.settings.salt = salt;
                    this.plugin.settings.password = hash;
                    await this.plugin.saveSettings();
                    isCorrect = true;
                } else {
                    isCorrect = false;
                }
            } else {
                const hash = await this.plugin.hashPassword(password, this.plugin.settings.salt);
                isCorrect = hash === this.plugin.settings.password;
            }

            if (!isCorrect && this.plugin.settings.emergencyCodes.length > 0) {
                for (let i = 0; i < this.plugin.settings.emergencyCodes.length; i++) {
                    const ec = this.plugin.settings.emergencyCodes[i];
                    const h = await this.plugin.hashPassword(password, ec.salt);
                    if (h === ec.hash) {
                        this.plugin.settings.emergencyCodes.splice(i, 1);
                        await this.plugin.saveSettings();
                        isCorrect = true;
                        const remaining = this.plugin.settings.emergencyCodes.length;
                        new Notice(`Emergency code accepted. ${remaining} code(s) remaining.`);
                        break;
                    }
                }
            }

            if (!isCorrect) {
                messageEl.style.color = 'red';
                let hint = this.plugin.settings.pwdHintQuestion;
                if (hint != '') {
                    hint = "  " + this.plugin.t("setting_pwd_hint_question_name") + ": " + hint;
                }
                messageEl.setText(this.plugin.t("password_not_match") + hint);
                return false;
            }

            messageEl.style.color = '';
            messageEl.setText(this.plugin.t("password_is_right"));
            return true;
        }

        // check the input and confirm
        const pwChecker = async (ev: Event | null) => {
            ev?.preventDefault();

            let goodToGo = await pwConfirmChecker();
            if (!goodToGo) {
                return;
            }

            // if all checks pass, save to settings
            this.plugin.lastUnlockOrOpenFileTime = moment();
            this.plugin.isVerifyPasswordCorrect = true;
            this.close();
        }

        // Press enter key to verify password.
        pwInputEl.addEventListener('keypress', (event) => {
            if (event.key === 'Enter') {
                pwChecker(null);
            }
        });

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText(this.plugin.t("ok"))
                    .setCta()
                    .onClick(() => {
                        pwChecker(null);
                    }));
    }

    restoreBlur() {
        Object.assign(this.app.workspace.containerEl.style, {
            filter: "blur(0px)",
        } as CSSStyleDeclaration);
    }

    onClose() {
        this.plugin.isVerifyPasswordWaitting = false;
        const { contentEl } = this;
        contentEl.empty();

        if (this.forbidCloseModal) {
            if (!this.plugin.isVerifyPasswordCorrect) {
                const setModal = new VerifyPasswordModal(this.app, this.plugin, true, this.onSubmit).open();
            } else {
                this.restoreBlur();
                this.onSubmit();
            }
        } else {
            this.restoreBlur();
            this.onSubmit();
        }
    }
}

class EmergencyCodesModal extends Modal {
    plugin: PasswordPlugin;
    codes: string[];

    constructor(app: App, plugin: PasswordPlugin, codes: string[]) {
        super(app);
        this.plugin = plugin;
        this.codes = codes;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl("h2", { text: this.plugin.t("emergency_codes_title") });
        contentEl.createEl("p", { text: this.plugin.t("emergency_codes_desc") });

        const codesEl = contentEl.createDiv();
        codesEl.style.fontFamily = 'monospace';
        codesEl.style.fontSize = '1.1em';
        codesEl.style.marginBottom = '1em';
        codesEl.style.padding = '1em';
        codesEl.style.background = 'var(--background-secondary)';
        codesEl.style.borderRadius = '4px';

        this.codes.forEach((code, i) => {
            const line = codesEl.createEl("p", { text: `${i + 1}.  ${code}` });
            line.style.margin = '0.3em 0';
        });

        const allCodesText = this.codes.map((c, i) => `${i + 1}.  ${c}`).join('\n');

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText(this.plugin.t("emergency_codes_copy_all"))
                    .onClick(() => {
                        navigator.clipboard.writeText(allCodesText).then(() => {
                            btn.setButtonText(this.plugin.t("emergency_codes_copied"));
                            setTimeout(() => btn.setButtonText(this.plugin.t("emergency_codes_copy_all")), 1500);
                        });
                    }))
            .addButton((btn) =>
                btn
                    .setButtonText(this.plugin.t("emergency_codes_download"))
                    .onClick(() => {
                        const header = "Nao's lock — Emergency Unlock Codes\nEach code can only be used once. Keep this file somewhere safe.\n\n";
                        const blob = new Blob([header + allCodesText], { type: 'text/plain' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'naos-lock-emergency-codes.txt';
                        a.click();
                        URL.revokeObjectURL(url);
                    }))
            .addButton((btn) =>
                btn
                    .setButtonText(this.plugin.t("emergency_codes_saved"))
                    .setCta()
                    .onClick(() => {
                        this.close();
                    }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
