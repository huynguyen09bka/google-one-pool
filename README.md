# Google One Pool (`gpool`)

**English** | [Tiếng Việt](./README.vi.md)

A zero-dependency macOS account pool manager for **Google AI Pro / Ultra** accounts (3–15+ accounts) built for **`agy` CLI**, **`gemini` CLI**, AI Coding Agents (via **MCP**), and **Google Chrome / Brave**.

Includes instant **macOS Keychain session switching** (no re-OAuth or `/logout`), **quota auto-failover (`gpool agy`)**, **per-model bucket cooldowns**, **AES-256-GCM at-rest encryption**, **1/N Auto-Onboard**, **7-day Usage Analytics**, a built-in **MCP Server (`gpool mcp`)**, full-screen **Interactive TUI (`gpool`)**, **Localhost Web Dashboard**, **CLI**, and a native **macOS Menu Bar app (Swift)** — with full **English & Vietnamese (`EN` / `VI`)** support across every interface.

> **Full CLI & TUI Guide**: [docs/CLI-GUIDE.en.md](./docs/CLI-GUIDE.en.md) (English) | [docs/CLI-GUIDE.md](./docs/CLI-GUIDE.md) (Tiếng Việt)

---

## Key Features

- **Zero External Dependencies**: Runs natively on **Node.js `>= 26.0`** (`node:sqlite`, native TypeScript, `node:crypto`). No `npm install` required.
- **Bilingual Everywhere (`EN` / `VI`)**: Switch instantaneously via `gpool lang en|vi`, `--lang en|vi`, `GPOOL_LANG=en`, pressing `L` in the TUI, or clicking `EN`/`VI` on the Web Dashboard (synced to macOS Menu Bar too).
- **Interactive Full-Screen TUI (`gpool` / `gpool tui`)**: Manage your entire pool, run `agy`, inspect health, encrypt snapshots, and view 7-day analytics with single-key shortcuts.
- **Zero-Friction `agy` Auto-Failover (`gpool agy`)**:
  - Atomic `agy.lock` lease prevents Keychain races across concurrent terminals/agents.
  - Detects quota / rate-limit errors (`429`, `RESOURCE_EXHAUSTED`, `"resets in 3h 30m"`), parses exact reset times & model buckets (`pro`, `claude`, `opus`, `sonnet`, `flash`), puts the exhausted account on cooldown, activates the next ready account, and retries automatically.
- **Built-in MCP Server (`gpool mcp`)**: Stdio JSON-RPC 2.0 server exposing 8 tools (`pool_status`, `agy_health`, `agy_acquire`, `agy_release`, `agy_report_quota`, `agy_clear_cooldown`, `agy_run`, `pool_analytics`) so Devin, Claude Code, Codex, Cursor, or any MCP agent can self-rotate accounts.
- **AES-256-GCM Session Security**:
  - Encrypts stored `agy` session snapshots on disk using a single 256-bit master key in macOS Keychain (`google-one-pool`/`master-key`) with alias-bound AAD (`gpool agy-encrypt`).
  - Passphrase-encrypted portable backups (`scrypt` + `AES-256-GCM`) let you migrate metadata + `agy` sessions safely between Macs.
- **1/N Auto-Onboard (`gpool agy-onboard`)**: Watches Clipboard/stdout for Google OAuth URLs, opens them in the exact matching Chrome profile (`login_hint` / `authuser`), and auto-captures encrypted snapshots the instant Keychain updates.
- **Fast Browser Import**: Auto-scan Chrome/Brave metadata (`Local State` / `Preferences`) or paste `accounts.google.com/SignOutOptions` (`⌘A` `⌘C`) to bulk-import multi-login accounts (`/u/0`, `/u/1`...) in 5 seconds.
- **Local Web Dashboard & Native macOS Menu Bar**: Real-time SSE updates on `http://127.0.0.1:47891` (Dark & Light themes, mobile responsive, Health & Analytics modals) plus a lightweight Swift Menu Bar app.

---

## Security & Safety Principles

- **Official Flows Only**: Never decrypts Chrome `Cookies`/`Login Data` (`os_crypt`) and never bypasses CAPTCHA/2FA. For `agy` CLI, `gpool` intentionally snapshots/restores the single official macOS Keychain item (`gemini`/`antigravity`) via `/usr/bin/security` only on explicit commands.
- **Never Touches Your System Chrome Profile**: Deleting a `linked` account only removes its pool entry and never modifies your original Chrome profile directory.
- **Strict Local Isolation**: HTTP daemon binds strictly to `127.0.0.1:47891` with `Host` & `Origin` CSRF validation. Data lives under `~/.google-one-pool` (`0700`), SQLite DB (`0600`), and snapshots (`0600`, AES-256-GCM encrypted).

---

## Quick Start (macOS)

**Requirements**: Node.js `>= 26.0`, Google Chrome (or Brave), and Xcode Command Line Tools (`swiftc`) if building the Menu Bar app.

```bash
git clone https://github.com/huynguyen09bka/google-one-pool.git
cd google-one-pool

# Optional: create a global shell alias in ~/.zshrc
echo 'alias gpool="node /path/to/google-one-pool/bin/gpool.ts"' >> ~/.zshrc
source ~/.zshrc

# Switch CLI/TUI/Web/Menu Bar to English (or "vi" for Vietnamese)
gpool lang en

# Launch the interactive TUI
gpool
```

### 1. Import Existing Signed-In Accounts from Chrome / Brave

```bash
# Option A: Auto-scan Chrome / Brave metadata (preview with --dry-run)
gpool import-chrome --dry-run
gpool import-chrome --tags pro

# Option B: Multi-login accounts in a single Chrome profile (/u/0, /u/1...)
# Open https://accounts.google.com/SignOutOptions -> press ⌘A ⌘C -> run:
gpool import-clipboard --profile "Default" --tags pro

# Option C: Add manually
gpool add pro1 acc1@example.com --tags pro,primary --renewal 2026-12-31
```

### 2. Capture & Rotate `agy` CLI Sessions (Zero Re-Login)

First time per account (or automate N accounts with `gpool agy-onboard`):

```bash
gpool agy-onboard             # 1/N auto-OAuth + auto-capture wizard
# Or manually per account after signing into agy:
gpool agy-capture pro1
```

Daily usage (**never use `/logout`** to switch saved accounts — it revokes the refresh token; just close `agy` and rotate):

```bash
gpool agy                                   # Interactive agy with agy.lock + auto-selected ready account
gpool agy --bucket auto -- -p "Review PR"   # Batch/agent mode with automatic quota failover
gpool agy-next --cooldown 5                 # Put current acc on cooldown & activate next agy Keychain session
gpool agy-health                            # Audit snapshot health, AES-256 encryption & renewal alerts
gpool agy-encrypt                           # Encrypt all existing v1 snapshots with AES-256-GCM
gpool stats                                 # 7-day usage & quota analytics chart
```

### 3. Daemon, Web Dashboard & macOS Menu Bar

```bash
gpool daemon start            # Start background daemon (localhost:47891 + Keep-Alive)
gpool dashboard               # Open Web Dashboard (http://127.0.0.1:47891)
gpool menubar start           # Build & launch native macOS Menu Bar app
gpool launchagent install     # Auto-start daemon on macOS login
```

### 4. Connect AI Agents via MCP (`gpool mcp`)

Add to your MCP client config (Devin CLI, Claude Code, Codex, Cursor, etc.):

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

---

## Profile Modes: `linked` vs `isolated`

| Mode | How It Works | Best For |
| :--- | :--- | :--- |
| **`linked`** (default on browser import) | Shares your existing Chrome `--profile-directory` with `?authuser=` / `login_hint=` | Using 5–15 already signed-in accounts immediately with zero re-login |
| **`isolated`** | Dedicated `--user-data-dir` per account under `~/.google-one-pool/chrome-profiles/` | Long-term stability with independent background Keep-Alive cookie refresh (`gpool isolate --all && gpool login-wizard`) |

---

## CLI Command Reference

> See [docs/CLI-GUIDE.en.md](./docs/CLI-GUIDE.en.md) for all flags, examples, TUI keybindings, and troubleshooting (or run `gpool help <command>`).

| Command | Description |
| :--- | :--- |
| `gpool` / `gpool tui` | Launch full-screen interactive Terminal UI |
| `gpool lang [en\|vi]` | View or switch system language (`en` / `vi`) |
| `gpool help [command]` | Show general or per-command help |
| `gpool import-chrome` / `import-clipboard` / `import-emails` | Bulk-import accounts from Chrome/Brave or pasted lists |
| `gpool add` / `list` / `show` / `edit` / `rm` | Full account CRUD |
| `gpool switch` / `next` / `cooldown` / `open` / `login` / `auth` | Switch profiles, rotate quotas, manage bucketed cooldowns, open OAuth URLs |
| `gpool isolate <alias\|--all>` / `login-wizard` | Graduate `linked` accounts into isolated Chrome profiles |
| `gpool check [alias]` | Probe & refresh Google session cookies |
| `gpool agy [flags] -- <args...>` | Smart `agy` runner with `agy.lock` lease & quota auto-failover |
| `gpool agy-next` / `agy-capture` / `agy-activate` / `agy-status` | Manage & rotate macOS Keychain `agy` sessions |
| `gpool agy-health` / `agy-encrypt` / `agy-onboard` / `agy-lock` | Health audit, AES-256-GCM encryption, 1/N onboarding, lock control |
| `gpool stats [--days 7]` | Pool availability, usage & quota analytics |
| `gpool run <alias> -- <cmd...>` | Run CLI with account context (`agy` Keychain/ADC or `GEMINI_CLI_HOME`) |
| `gpool mcp` | Run stdio MCP server (8 tools) for AI agents |
| `gpool daemon` / `dashboard` / `menubar` / `launchagent` | Manage background daemon, Web UI, macOS Menu Bar & auto-start |
| `gpool export` / `import` | Metadata JSON or `scrypt` + `AES-256-GCM` encrypted portable backup (`--encrypted --with-sessions`) |

## Running Tests

```bash
npm test
```
