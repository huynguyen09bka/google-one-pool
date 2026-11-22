import { validateLocale } from './config.ts';
import type { Locale } from './types.ts';

/**
 * Resolves the active UI/CLI locale: explicit override -> GPOOL_LANG env -> persisted settings -> 'vi'.
 */
export function resolveLocale(override?: string | null, persisted?: Locale | null): Locale {
  const candidate = override?.trim() || process.env.GPOOL_LANG?.trim() || persisted || 'vi';
  try {
    return validateLocale(candidate);
  } catch {
    return 'vi';
  }
}

/**
 * Returns the localized Vietnamese or English text for the active locale.
 */
export function pick(locale: Locale, vi: string, en: string): string {
  return locale === 'en' ? en : vi;
}

export function getMainHelpText(locale: Locale): string {
  if (locale === 'en') {
    return `Google One Pool (gpool) — Multi-account Google AI Pro manager for agy CLI & Chrome

Interactive TUI (easiest way to use gpool):
  gpool                                 Launch full-screen interactive TUI (in a TTY terminal)
  gpool tui                             Launch interactive TUI explicitly (alias: gpool ui)
  gpool lang [en|vi]                    View or switch language between English and Vietnamese
  gpool help [command]                  Show overview or detailed help for a specific command

Account Management & Import:
  gpool add <alias> <email> [--tags a,b] [--renewal YYYY-MM-DD] [--proxy <url>] [--notes "..."]
  gpool import-chrome [--dry-run] [--isolated] [--tags pro] [--json]
  gpool import-clipboard [--profile "Default"] [--browser chrome|brave] [--dry-run] [--isolated]
  gpool import-emails <file.txt | --emails "a@g.com,b@g.com"> [--profile "Default"] [--isolated] [--tags pro]
  gpool list [--status ready|cooldown|needs_login] [--tag <tag>] [-q <text>] [--json]
  gpool show <alias> [--json]
  gpool edit <alias> [--alias ...] [--email ...] [--tags ...] [--renewal ...] [--proxy ...] [--notes ...]
  gpool rm <alias> [--purge]

Chrome Control, Rotation & Keep-Alive:
  gpool login <alias>                   Open Chrome profile at Google Sign-In (email pre-filled)
  gpool login-wizard                    Open pending isolated Chrome profiles one-by-one (1/N)
  gpool open <alias> [url]              Open or focus the account's Chrome window
  gpool switch <alias> [--no-open]      Mark account active and open its Chrome profile
  gpool next [--agy] [--cooldown <h>] [--bucket <bkt>] [--policy lru|round-robin|tier-first]
  gpool auth <alias> [oauth-url]        Open OAuth URL in the account's Chrome profile (reads clipboard if omitted)
  gpool isolate <alias|--all> [--no-open]  Graduate linked account(s) into isolated Chrome profiles
  gpool cooldown <alias> <hours|clear> [--bucket all|pro|claude|flash]
  gpool check [alias]                   Probe & refresh session cookies (one account or full pool)

agy CLI Automation (Auto-Failover, Keychain, Encryption & MCP):
  gpool agy [flags] -- <args...>        Smart wrapper: agy.lock lease + Keychain activation + quota auto-failover
  gpool agy-next [--cooldown <h>] [--bucket <bkt>]  Rotate to next captured agy account & activate Keychain
  gpool agy-capture <alias>             Capture current agy Keychain session (AES-256-GCM encrypted)
  gpool agy-activate <alias> [--force]  Restore saved agy session into Keychain (no re-login required)
  gpool agy-status                      Inspect live Keychain owner and saved snapshots
  gpool agy-health [--json]             Audit snapshot health, AES-256 encryption coverage & renewal alerts
  gpool agy-encrypt [--json]            Encrypt all plaintext v1 snapshots with AES-256-GCM (Keychain master key)
  gpool agy-onboard [--alias <a>|--all] 1/N wizard: intercept OAuth URLs, open right Chrome & auto-capture
  gpool agy-lock <status|unlock>        Inspect or force-release the agy.lock concurrency lease
  gpool stats [--days 7] [--json]       7-day usage & quota analytics chart (alias: analytics)
  gpool run <alias> -- agy              Activate saved agy session (or GEMINI_CLI_HOME / ADC) and run command
  gpool mcp                             Run stdio MCP server (8 tools) for AI Agents (Devin/Claude/Codex/Cursor)

Daemon, Web Dashboard & macOS:
  gpool daemon <start|stop|status|run>  Manage localhost:47891 HTTP daemon & Keep-Alive scheduler
  gpool dashboard                       Start daemon if needed and open Web Dashboard
  gpool menubar <build|start|stop>      Build and launch native macOS Menu Bar app
  gpool launchagent <install|uninstall|status>  Auto-start daemon on macOS login
  gpool export [file] [--encrypted] [--with-sessions]  Export metadata or encrypted portable backup (+agy)
  gpool import <file> [--passphrase "..."]             Restore metadata or encrypted backup

Global flags: --lang en|vi, --port <port>, --json
Full guide: docs/CLI-GUIDE.en.md (English) | docs/CLI-GUIDE.md (Tiếng Việt).`;
  }

  return `Google One Pool (gpool) — Quản lý nhiều tài khoản Google AI Pro cho agy CLI & Chrome

Giao diện TUI tương tác (dễ dùng nhất — không cần nhớ lệnh):
  gpool                                 Mở giao diện TUI toàn màn hình (khi chạy trong terminal tương tác)
  gpool tui                             Mở giao diện TUI tương tác (alias: gpool ui)
  gpool lang [vi|en]                    Xem hoặc đổi ngôn ngữ hệ thống (Tiếng Việt / English)
  gpool help [lệnh]                     Xem hướng dẫn chung hoặc chi tiết từng lệnh (vd: gpool help agy)

Quản lý & nhập tài khoản:
  gpool add <alias> <email> [--tags a,b] [--renewal YYYY-MM-DD] [--proxy <url>] [--notes "..."]
  gpool import-chrome [--dry-run] [--isolated] [--tags pro] [--json]
  gpool import-clipboard [--profile "Default"] [--browser chrome|brave] [--dry-run] [--isolated]
  gpool import-emails <file.txt | --emails "a@g.com,b@g.com"> [--profile "Default"] [--isolated] [--tags pro]
  gpool list [--status ready|cooldown|needs_login] [--tag <tag>] [-q <text>] [--json]
  gpool show <alias> [--json]
  gpool edit <alias> [--alias ...] [--email ...] [--tags ...] [--renewal ...] [--proxy ...] [--notes ...]
  gpool rm <alias> [--purge]

Điều khiển tài khoản & vòng xoay:
  gpool login <alias>                   Mở Chrome profile để đăng nhập Google (điền sẵn email)
  gpool login-wizard                    Mở nối tiếp từng Chrome profile riêng đang chờ đăng nhập (1/N)
  gpool open <alias> [url]              Mở hoặc focus cửa sổ Chrome của tài khoản
  gpool switch <alias> [--no-open]      Chọn tài khoản làm active và mở Chrome profile
  gpool next [--agy] [--cooldown <h>] [--bucket <bkt>] [--policy lru|round-robin|tier-first]
  gpool auth <alias> [oauth-url]        Mở link OAuth của agy vào đúng profile Chrome (tự lấy từ clipboard nếu bỏ trống)
  gpool isolate <alias|--all> [--no-open]  Tách 1 hoặc tất cả acc đang Link sang Chrome profile riêng độc lập
  gpool cooldown <alias> <giờ|clear> [--bucket all|pro|claude|flash]
  gpool check [alias]                   Kiểm tra & làm mới cookie (1 acc hoặc toàn bộ pool)

Phiên agy CLI (Auto-Failover, Keychain, Mã hóa & MCP):
  gpool agy [flags] -- <args...>        Chạy agy có tự phát hiện hết quota + tự xoay acc + khóa agy.lock
  gpool agy-next [--cooldown <h>] [--bucket <bkt>]  Xoay sang acc agy kế tiếp & tự nạp Keychain (1 lệnh)
  gpool agy-capture <alias>             Lưu phiên agy hiện tại trong Keychain (tự mã hóa AES-256-GCM)
  gpool agy-activate <alias> [--force]  Nạp phiên đã lưu vào Keychain — đổi acc agy không cần login lại
  gpool agy-status                      Xem phiên keychain hiện tại thuộc acc nào + các snapshot đã lưu
  gpool agy-health [--json]             Kiểm tra sức khỏe toàn bộ snapshot agy + mã hóa AES-256 + cảnh báo gia hạn
  gpool agy-encrypt [--json]            Mã hóa toàn bộ snapshot agy trên đĩa bằng AES-256-GCM (Keychain master key)
  gpool agy-onboard [--alias <a>|--all] Wizard 1/N tự bắt link OAuth mở đúng Chrome & tự động capture phiên agy
  gpool agy-lock <status|unlock>        Xem hoặc mở khóa agy.lock (chống xung đột Keychain giữa nhiều agent)
  gpool stats [--days 7] [--json]       Xem biểu đồ hiệu suất pool, lượt xoay vòng & tỷ lệ đụng quota
  gpool run <alias> -- agy              Tự nạp phiên đã lưu rồi chạy agy (với CLI khác: ADC / GEMINI_CLI_HOME)
  gpool mcp                             Chạy MCP Server (stdio, 8 tools) cho AI Agents (Devin/Claude/Codex/Cursor)

Daemon, Web Dashboard & macOS:
  gpool daemon <start|stop|status|run>  Quản lý dịch vụ nền & HTTP localhost:47891
  gpool dashboard                       Khởi động daemon nếu cần và mở Web Dashboard
  gpool menubar <build|start|stop>      Build và mở app Menu Bar gốc trên macOS
  gpool launchagent <install|uninstall|status>  Tự chạy daemon khi mở máy macOS
  gpool export [file] [--encrypted] [--with-sessions]  Xuất metadata hoặc backup mã hóa (kèm phiên agy)
  gpool import <file> [--passphrase "..."]             Khôi phục metadata hoặc backup mã hóa từ file

Cờ toàn cục: --lang vi|en, --port <port>, --json
Tài liệu chi tiết: docs/CLI-GUIDE.md (Tiếng Việt) | docs/CLI-GUIDE.en.md (English).`;
}

const COMMAND_HELP_EN: Record<string, string> = {
  tui: `gpool tui (alias: gpool ui, or run "gpool" with no args)
Launch the full-screen interactive Terminal UI.

Keybindings:
  ↑/↓ or j/k    Navigate accounts (1-9 quick jump)
  Enter or s    Switch active account & open Chrome (S = no Chrome)
  g             Activate agy Keychain session and launch agy directly
  a / c / A     Activate agy / Capture agy / View Keychain status
  H / U         agy Health (+ [E] AES-256 encrypt, [U] unlock) / 7-day Stats
  n / N         Rotate account (+Chrome) / Rotate & activate agy Keychain
  o / l / u     Open Chrome / Open Sign-In / Open OAuth URL from clipboard
  x / p / P     Set or clear Cooldown (with bucket) / Probe 1 / Sweep all
  + / i / t     Add account / Import Chrome-Clipboard-Onboard / Isolate
  e / d         Edit / Delete account
  / / f / L     Live search / Status filter / Toggle Language (EN ↔ VI)
  v / D / ? / q Events log / System menu / Help / Quit`,

  lang: `gpool lang [en|vi] [--json]
View or change the default system language (persisted across CLI, TUI, Web Dashboard, and macOS Menu Bar).
You can also override per command with --lang en|vi or GPOOL_LANG=en|vi.`,

  agy: `gpool agy [flags] [-- <agy-args...>]
Smart Auto-Failover Wrapper for agy CLI:
  - Acquires atomic agy.lock lease to prevent Keychain races across agents
  - Automatically selects a ready captured agy account and activates Keychain
  - In non-interactive/agent mode: detects quota errors (429 / RESOURCE_EXHAUSTED / "resets in ..."),
    parses exact reset time & model bucket, sets cooldown, rotates to next account, and retries!

Flags:
  --alias <alias>        Start with this account
  --tag <tag>            Filter pool by tag
  --bucket <name|auto>   Cooldown bucket (all, pro, claude, flash, opus, sonnet, or auto)
  --policy <p>           Rotation policy: lru | round-robin | tier-first
  --cooldown <hours>     Fallback cooldown hours when error omits reset time
  --max-retries <N>      Max failover retries (default: 3)
  --wait <sec>           Wait up to N seconds if agy.lock is held
  --timeout <sec>        Per-attempt timeout in seconds
  --auto-rotate          Force quota-detection failover mode
  --force                Bypass running agy process check
  --json                 Emit structured JSON output`,

  'agy-next': `gpool agy-next [--cooldown <h>] [--bucket <name>] [--tag <tag>] [--policy <p>] [--wait <sec>] [--force] [--open] [--json]
One-step rotation: puts current account on cooldown, picks the next ready captured agy account, and activates its Keychain session (no Chrome window unless --open).`,

  'agy-health': `gpool agy-health [--json]
Audit all agy session snapshots (refresh_token presence, access token expiry, email match, AES-256-GCM encryption status), agy.lock lease state, and upcoming plan renewal alerts.`,

  'agy-encrypt': `gpool agy-encrypt [--json]
Creates a 256-bit AES master key in macOS Keychain ("google-one-pool"/"master-key") and encrypts all plaintext v1 agy snapshots on disk to v2 AES-256-GCM.`,

  'agy-onboard': `gpool agy-onboard [alias] [--all] [--timeout <sec>] [--login-cmd "<cmd>"]
1/N Auto-Onboard wizard for new accounts: watches clipboard/stdout for Google OAuth URLs, opens them in the matching Chrome profile, and auto-captures encrypted snapshots once Keychain updates.`,

  'agy-lock': `gpool agy-lock <status|unlock> [--json]
Inspect the current agy.lock holder or force-unlock a stuck lease.`,

  stats: `gpool stats (alias: analytics) [--days 7] [--json]
Display pool availability %, encryption coverage, N-day activity & quota chart, and per-account breakdown.`,

  mcp: `gpool mcp
Start the zero-dependency Model Context Protocol (MCP) server over stdio (JSON-RPC 2.0).
Exposes 8 tools: pool_status, agy_health, agy_acquire, agy_release, agy_report_quota, agy_clear_cooldown, agy_run, pool_analytics.`,

  next: `gpool next [--agy] [--cooldown <h>] [--bucket <name>] [--tag <tag>] [--policy lru|round-robin|tier-first] [--force] [--no-open] [--json]
Put active account on cooldown and rotate to the next ready account. Pass --agy to pick only agy-captured accounts and activate Keychain automatically.`,

  cooldown: `gpool cooldown <alias> <hours|clear> [--bucket all|pro|claude|flash] [--reason "..."] [--json]
Set or clear an account-wide or model-bucket cooldown.`,

  export: `gpool export [file] [--encrypted] [--with-sessions] [--passphrase "..."]
Export metadata JSON, or an scrypt + AES-256-GCM encrypted portable backup including agy sessions.`,

  import: `gpool import <file> [--passphrase "..."] [--json]
Restore accounts/settings from a plain JSON export or an encrypted portable backup (auto-detected).`,
};

const COMMAND_HELP_VI: Record<string, string> = {
  tui: `gpool tui (alias: gpool ui, hoặc chạy "gpool" không tham số)
Mở giao diện tương tác toàn màn hình (TUI) ngay trên Terminal.

Phím tắt chính trong TUI:
  ↑/↓ hoặc j/k   Chọn tài khoản (1-9 nhảy nhanh)
  Enter hoặc s   Chọn tài khoản làm active & mở Chrome (S = không mở Chrome)
  g              Tự nạp phiên agy rồi chạy thẳng lệnh "agy"
  a / c / A      Nạp phiên agy / Lưu phiên agy / Xem trạng thái Keychain agy
  H / U          Sức khỏe agy ([E] mã hóa AES-256, [U] mở khóa) / Thống kê 7 ngày
  n / N          Xoay acc (+Chrome) / Xoay nhanh agy kế tiếp & nạp Keychain
  o / l / u      Mở Chrome / Đăng nhập Chrome / Mở link OAuth từ Clipboard
  x / p / P      Đặt hoặc gỡ Cooldown (theo bucket) / Kiểm tra 1 acc / Quét cả pool
  + / i / t      Thêm mới / Nhập Chrome-Clipboard-Onboard / Tách profile riêng
  e / d          Sửa thông tin / Xóa tài khoản
  / / f / L      Tìm kiếm trực tiếp / Lọc trạng thái / Đổi ngôn ngữ (VI ↔ EN)
  v / D / ? / q  Nhật ký hoạt động / Hệ thống / Trợ giúp / Thoát`,

  lang: `gpool lang [vi|en] [--json]
Xem hoặc đổi ngôn ngữ mặc định của toàn hệ thống (đồng bộ CLI, TUI, Web Dashboard và Menu Bar macOS).
Có thể ghi đè tạm thời bằng cờ --lang en|vi hoặc biến môi trường GPOOL_LANG=en|vi.`,

  agy: `gpool agy [flags] [-- <agy-args...>]
Smart Auto-Failover Wrapper cho agy CLI:
  - Tự lấy khóa agy.lock (chống 2 tiến trình tranh chấp Keychain)
  - Tự chọn acc sẵn sàng đã lưu snapshot agy và nạp Keychain
  - Ở chế độ batch/agent: tự phát hiện lỗi hết quota (429 / RESOURCE_EXHAUSTED / resets in ...),
    đặt cooldown theo đúng thời gian reset, xoay sang acc kế tiếp và tự chạy lại!

Flags:
  --alias <alias>        Ưu tiên bắt đầu từ tài khoản này
  --tag <tag>            Chỉ dùng các tài khoản có tag này
  --bucket <name|auto>   Bucket cooldown (all, pro, claude, flash, opus, sonnet, hoặc auto)
  --policy <p>           Chiến lược xoay: lru | round-robin | tier-first
  --cooldown <giờ>       Ghi đè số giờ cooldown nếu lỗi không báo giờ reset cụ thể
  --max-retries <N>      Số lần tự xoay vòng tối đa (mặc định: 3)
  --wait <giây>          Chờ tối đa N giây nếu agy.lock đang bận
  --timeout <giây>       Giới hạn thời gian mỗi lần chạy agy
  --auto-rotate          Ép chế độ bắt lỗi quota & auto-failover
  --force                Bỏ qua kiểm tra tiến trình agy đang chạy
  --json                 Xuất kết quả JSON (cho script/agent)`,

  'agy-next': `gpool agy-next [--cooldown <giờ>] [--bucket <name>] [--tag <tag>] [--policy <p>] [--wait <giây>] [--force] [--open] [--json]
Lệnh gọn 1 bước: đặt cooldown acc hiện tại, chọn acc sẵn sàng ĐÃ LƯU PHIÊN AGY kế tiếp, và nạp thẳng vào Keychain (không bật Chrome trừ khi truyền --open).`,

  'agy-health': `gpool agy-health [--json]
Kiểm tra sức khỏe toàn bộ snapshot agy (refresh_token, hạn access_token, khớp email, trạng thái mã hóa AES-256-GCM, acc chưa capture), trạng thái khóa agy.lock và cảnh báo các tài khoản sắp đến ngày gia hạn gói.`,

  'agy-encrypt': `gpool agy-encrypt [--json]
Tạo 1 master key AES-256 duy nhất trong macOS Keychain ("google-one-pool"/"master-key") và mã hóa toàn bộ snapshot agy v1 hiện có trên đĩa sang định dạng v2 AES-256-GCM.`,

  'agy-onboard': `gpool agy-onboard [alias] [--all] [--timeout <giây>] [--login-cmd "<lệnh>"]
Wizard 1/N nạp nhanh nhiều tài khoản mới vào agy: tự bắt link OAuth mở đúng Chrome profile và tự động capture (mã hóa AES-256-GCM) khi Keychain cập nhật.`,

  'agy-lock': `gpool agy-lock <status|unlock> [--json]
Xem tiến trình/agent nào đang giữ khóa agy.lock hoặc ép mở khóa (unlock) nếu cần.`,

  stats: `gpool stats (alias: analytics) [--days 7] [--json]
Hiển thị thống kê hiệu suất toàn pool: tỷ lệ sẵn sàng, độ phủ mã hóa AES-256-GCM, biểu đồ hoạt động N ngày gần đây và bảng chi tiết từng tài khoản.`,

  mcp: `gpool mcp
Khởi chạy Model Context Protocol (MCP) Server qua stdio (JSON-RPC 2.0) cho AI Agents.
8 tools: pool_status, agy_health, agy_acquire, agy_release, agy_report_quota, agy_clear_cooldown, agy_run, pool_analytics.`,

  next: `gpool next [--agy] [--cooldown <giờ>] [--bucket <name>] [--tag <tag>] [--policy lru|round-robin|tier-first] [--force] [--no-open]
Đặt cooldown acc hiện tại và xoay sang acc sẵn sàng kế tiếp. Thêm --agy để chỉ chọn acc đã capture agy và nạp thẳng vào Keychain.`,

  cooldown: `gpool cooldown <alias> <giờ|clear> [--bucket all|pro|claude|flash] [--reason "..."]
Đặt hoặc gỡ cooldown thủ công (toàn tài khoản hoặc riêng 1 bucket model).`,

  export: `gpool export [file] [--encrypted] [--with-sessions] [--passphrase "..."]
Xuất metadata JSON hoặc backup mã hóa scrypt + AES-256-GCM (kèm toàn bộ phiên agy).`,

  import: `gpool import <file> [--passphrase "..."] [--json]
Khôi phục metadata hoặc backup mã hóa từ file (tự nhận diện định dạng).`,
};

export function getCommandHelpText(locale: Locale, rawCmd: string): string | null {
  const aliases: Record<string, string> = {
    ui: 'tui',
    interactive: 'tui',
    ls: 'list',
    info: 'show',
    delete: 'rm',
    use: 'switch',
    rotate: 'next',
    analytics: 'stats',
    language: 'lang',
  };
  const key = aliases[rawCmd] ?? rawCmd;
  const map = locale === 'en' ? COMMAND_HELP_EN : COMMAND_HELP_VI;
  return map[key] ?? null;
}
