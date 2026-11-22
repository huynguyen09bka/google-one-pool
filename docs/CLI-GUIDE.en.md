# CLI & TUI User Guide (`gpool`)

**English** | [Tiếng Việt](./CLI-GUIDE.md)

Complete guide for installing `gpool`, using the **interactive Terminal UI (TUI)**, automating **`agy` CLI** rotation & MCP agents, encrypting stored sessions, and referencing all CLI commands.

---

## 1. Quick Setup

**Requirements**: Node.js `>= 26.0`, Google Chrome or Brave Browser, macOS (for Keychain `agy` session switching and Menu Bar app).

```bash
# Option 1: Shell alias in ~/.zshrc (recommended)
echo 'alias gpool="node /path/to/google-one-pool/bin/gpool.ts"' >> ~/.zshrc
source ~/.zshrc

# Option 2: Global symlink via npm link
cd /path/to/google-one-pool && chmod +x bin/gpool.ts && npm link

# Switch language to English (persisted across CLI, TUI, Web Dashboard & Menu Bar)
gpool lang en
```

> Tip: Override language for any single invocation with `--lang en` / `--lang vi` or `GPOOL_LANG=en`. Run `gpool help <command>` or `gpool <command> --help` for built-in help.

---

## 2. Interactive TUI (`gpool` / `gpool tui`)

Run `gpool` (with no arguments in an interactive terminal) or `gpool tui` (`gpool ui`) to launch the full-screen TUI. It automatically syncs with the background daemon when running, or operates directly against local SQLite when offline.

### TUI Keyboard Shortcuts

| Key | Action | Equivalent CLI |
| :--- | :--- | :--- |
| `↑` / `↓` or `k` / `j` | Select account (`1`–`9` quick jump, `PgUp`/`PgDn` scroll) | `gpool list` |
| `Enter` or `s` | Switch active account & open Chrome (`S` = without Chrome) | `gpool switch <alias>` |
| `g` | Activate `agy` Keychain session and launch `agy` directly | `gpool run <alias> -- agy` |
| `a` / `c` / `A` | Activate `agy` / Capture `agy` / View Keychain status | `gpool agy-activate` / `agy-capture` / `agy-status` |
| `H` | Open `agy` Health modal (`[E]` AES-256 encrypt all, `[U]` unlock `agy.lock`) | `gpool agy-health` / `agy-encrypt` |
| `U` | Open 7-day Pool Analytics & Quota Chart | `gpool stats` |
| `n` / `N` | `n`: Rotate (+Chrome) • `N`: **Rotate next `agy` & activate Keychain** | `gpool next` / `gpool agy-next` |
| `o` / `l` / `u` | Open Chrome / Sign-In Chrome / Open OAuth URL from Clipboard | `gpool open` / `login` / `auth` |
| `x` | Set account or bucket cooldown (`pro`, `claude`) or clear | `gpool cooldown <alias> ...` |
| `p` / `P` | Probe selected account / Sweep all accounts | `gpool check [alias]` |
| `+` / `e` / `d` | Add / Edit / Delete account | `gpool add` / `edit` / `rm` |
| `i` | Import menu (Chrome scan, SignOutOptions Clipboard, Manual, Login Wizard, **Auto-Onboard 1/N**) | `gpool import-*` / `agy-onboard` |
| `t` | Isolate linked account(s) into dedicated Chrome profiles | `gpool isolate <alias\|--all>` |
| `/` / `f` / `L` | Live search / Cycle status filter / **Toggle Language (`EN` ↔ `VI`)** | `gpool lang` |
| `v` / `D` / `?` / `q` | Events log / System menu (Daemon, Web, Menu Bar, LaunchAgent) / Help / Quit | `gpool daemon` / `dashboard` |

---

## 3. Daily Workflows

### Workflow A — Import Accounts from Chrome / Brave
```bash
gpool import-chrome --dry-run
gpool import-chrome --tags pro

# For multi-login accounts inside one Chrome profile (/u/0, /u/1...):
# Visit https://accounts.google.com/SignOutOptions -> press ⌘A ⌘C -> run:
gpool import-clipboard --profile "Default" --tags pro
```

### Workflow B — 1/N Auto-Onboard for `agy` Sessions
```bash
# Intercepts OAuth URLs (Clipboard/stdout), opens the matching Chrome profile,
# and auto-captures encrypted AES-256-GCM snapshots once Keychain updates:
gpool agy-onboard
```

### Workflow C — Automated Rotation & Quota Failover (`gpool agy`)
```bash
# Interactive agy with agy.lock protection & automatic token re-capture on exit:
gpool agy

# Batch / Agent mode with smart quota detection + auto-failover:
gpool agy --bucket auto --max-retries 5 -- -p "Review this pull request"

# One-step manual rotation (cooldown current + activate next captured agy):
gpool agy-next --cooldown 5 --bucket claude --policy tier-first

# Model-bucket cooldowns (Claude on cooldown while Flash/Pro stay available):
gpool cooldown pro1 3 --bucket claude --reason "Claude limit reached"
gpool cooldown pro1 clear --bucket claude
```

> **Important**: Never run `/logout` inside `agy` to switch saved accounts — `/logout` revokes the refresh token on Google's servers. Simply close `agy` and rotate.

### Workflow D — AI Agent Integration via MCP (`gpool mcp`)
Configure any MCP-compatible coding agent (Devin CLI, Claude Code, Codex, Cursor, etc.):

```json
{
  "mcpServers": {
    "google-one-pool": {
      "command": "node",
      "args": ["/path/to/google-one-pool/bin/gpool.ts", "mcp"]
    }
  }
}
```

Available MCP tools (8):
1. `pool_status` — Pool summary, active account, Keychain owner, `agy.lock` lease, earliest cooldown end.
2. `agy_health` — Snapshot health audit (`refresh_token`, expiry, email match, AES-256 status) & renewal alerts.
3. `agy_acquire` — Pick best ready account (by `tag`, `bucket`, `policy`), acquire `agy.lock`, activate Keychain.
4. `agy_release` — Release `agy.lock`.
5. `agy_report_quota` — Parse reset time/bucket from `error_text`, set cooldown, and auto-rotate + activate next account.
6. `agy_clear_cooldown` — Clear account-wide or bucket cooldown.
7. `agy_run` — Execute `agy` end-to-end with lease locking and multi-account failover.
8. `pool_analytics` — 7-day usage, quota hit rate, availability %, and encryption coverage.

### Workflow E — At-Rest Encryption, Analytics & Cross-Mac Backups
```bash
# Encrypt all plaintext v1 snapshots on disk using a macOS Keychain master key (AES-256-GCM)
gpool agy-encrypt

# Audit health & 7-day analytics
gpool agy-health
gpool stats --days 7

# Export passphrase-encrypted backup including all agy sessions (scrypt + AES-256-GCM)
gpool export backup.gpool.enc --encrypted --with-sessions

# Restore on another Mac (auto-detects encrypted format & re-encrypts with local Keychain key)
gpool import backup.gpool.enc
```

---

## 4. Environment Variables & Data Directory

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `GPOOL_LANG` | `vi` (or persisted `settings.language`) | Default language (`en` or `vi`) |
| `GPOOL_HOME` | `~/.google-one-pool` | Data directory (`0700`) for SQLite DB, Chrome profiles & encrypted `agy-sessions` |
| `GPOOL_PORT` | `47891` | Localhost HTTP daemon port (also `--port`) |
| `GPOOL_CHROME_BIN` | Auto-detected Chrome/Brave | Override Chromium binary path |
| `NO_COLOR` | unset | Disable ANSI colors in TUI |

---

## 5. Troubleshooting

- **`EPERM` / `EACCES` on `import-chrome`**: macOS TCC blocks Terminal from reading `~/Library/Application Support/Google/Chrome`. Use `gpool import-clipboard` after `⌘A` `⌘C` on `https://accounts.google.com/SignOutOptions` (no permissions needed), or grant Full Disk Access to Terminal.
- **`agy-activate` refuses because `agy` is running**: Close `agy` / Antigravity first so it does not overwrite Keychain from RAM (or pass `--force` if certain).
- **`agy.lock` stuck after an abrupt crash**: Stale locks (dead PID or expired TTL) are reclaimed automatically; you can also clear manually with `gpool agy-lock unlock`.
