# Nao's lock

> A personal Obsidian plugin that puts a lock on your vault — because some notes are yours alone.

No encryption, no file modification. Nao's lock simply asks for a password before letting anyone into your protected notes. Think of it as a bouncer for your vault.

---

## What it does

When you open a protected file or folder, a password prompt appears. Wrong password? No entry. The notes themselves are never touched — this is pure access control at the Obsidian UI level.

Works on **desktop** (macOS, Windows, Linux) and **mobile** (iOS, Android).

---

## Security

Passwords are hashed with **PBKDF2** (100,000 iterations, SHA-256) with a unique random salt — not stored in plain text or with a reversible cipher. The plugin uses only the Web Crypto API, so it works identically on every platform.

**Emergency codes** — when you set your password, 5 single-use backup codes are generated and shown once. Store them somewhere safe. Each one unlocks the vault and is then consumed. You can regenerate them anytime from settings.

---

## Settings

| Setting | What it does |
|---|---|
| **Enable / Disable** | Toggle protection on or off. Enabling sets your password; disabling requires it. |
| **Auto-lock** | Automatically re-lock after N minutes of inactivity. Set to 0 to disable. |
| **Password prompt** | A hint question shown when the password doesn't match, to jog your memory. |
| **Protected folder or file** | Path to protect. Use `/` for the entire vault. |
| **More folders or files** | Up to 6 additional paths to protect. |
| **Emergency unlock codes** | Regenerate your 5 single-use backup codes. |

---

## Installation via BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) (Beta Reviewers Auto-update Tool) is the easiest way to install this plugin.

1. Install and enable the BRAT plugin from the Obsidian community plugins.
2. Open BRAT settings → **Add Beta plugin**.
3. Paste: `https://github.com/Naosou-3355/obsidian-password-protection`
4. Click **Add Plugin** — done.

BRAT will keep the plugin updated automatically when new releases are published.

---

## Manual installation

1. Go to the [Releases](https://github.com/Naosou-3355/obsidian-password-protection/releases) page and download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. In your vault, navigate to `.obsidian/plugins/` and create a folder named `naos-lock`.
3. Drop the three downloaded files into that folder.
4. Restart Obsidian, go to **Settings → Community plugins**, and enable **Nao's lock**.

---

## License

[MIT](LICENSE)
