# Google One Pool (`gpool`)

Công cụ quản lý pool nhiều tài khoản **Google AI Pro** (3–15 tài khoản) trên macOS cho **`agy` CLI** và trình duyệt Google Chrome — hỗ trợ nhập nhanh tài khoản đã đăng nhập sẵn từ Chrome/Brave (kể cả **nhiều tài khoản gộp trong 1 profile Chrome** `/u/0`, `/u/1`...), chế độ **Link Chrome gốc** hoặc **Profile tách riêng + Keep-Alive chạy ngầm**, **Quản lý vòng xoay quota/cooldown**, **TUI tương tác ngay trên Terminal (`gpool` / `gpool tui`)**, **Web Dashboard `localhost`**, **CLI `gpool`**, và **Menu Bar macOS gốc (Swift)**.

> **Tài liệu đầy đủ về CLI & TUI**: xem [docs/CLI-GUIDE.md](./docs/CLI-GUIDE.md) (bao gồm cách cài lệnh `gpool`, bảng phím tắt TUI, quy trình thực chiến và tra cứu toàn bộ lệnh).

## Chế độ TUI tương tác (Dễ dùng nhất cho CLI)

Không cần nhớ tên lệnh hay cờ tham số — mở giao diện toàn màn hình ngay trong Terminal:

```bash
node bin/gpool.ts           # Mở TUI ngay khi chạy trong Terminal tương tác
# hoặc:
node bin/gpool.ts tui       # alias: gpool ui / npm run tui
```

Trong TUI hỗ trợ đầy đủ mọi thao tác bằng 1 phím bấm: `↑↓/jk` chọn acc, `s`/`Enter` chuyển acc, `g` nạp phiên & chạy thẳng `agy`, `a`/`c` nạp/lưu phiên `agy`, `n` xoay acc kế tiếp (+cooldown), `i` nhập từ Chrome/Clipboard, `x` đặt/gỡ cooldown, `p`/`P` kiểm tra phiên, `D` quản lý Daemon/Dashboard/Menu Bar, `?` xem bảng phím tắt & lệnh CLI tương ứng.

*(Gợi ý: chạy `gpool help <tên-lệnh>` hoặc `gpool <tên-lệnh> --help` để xem hướng dẫn chi tiết từng lệnh ngay trên Terminal.)*

## Nguyên tắc an toàn & chính thống

- **Luồng chính thống**: Không đọc `Cookies`, `Login Data` hay giải mã `os_crypt` của Chrome; không vượt CAPTCHA/2FA. **Riêng với Keychain của `agy`**: từ bản này `gpool` *có chủ đích* đọc/ghi đúng 1 mục `gemini`:`antigravity` (qua binary `/usr/bin/security` chính thống — cùng cơ chế `agy` dùng) để lưu/nạp phiên đăng nhập khi anh ra lệnh `agy-capture` / `agy-activate`. Credential chỉ nằm trong `~/.google-one-pool/agy-sessions` (`0700`), không in ra log/CLI/dashboard, không export.
- **Không vượt CAPTCHA / 2FA**: Nếu Keep-Alive phát hiện Google yêu cầu xác minh lại (`accounts.google.com` hoặc `myaccount.google.com/intro`), hệ thống chỉ đánh dấu `needs_login`, gửi thông báo macOS và mở đúng profile Chrome để anh đăng nhập lại thủ công.
- **Không bao giờ xóa Chrome profile gốc**: Khi xóa một tài khoản đang dùng chế độ `linked`, hệ thống chỉ gỡ khỏi danh sách quản lý của `gpool` và tuyệt đối không đụng vào thư mục profile Chrome của người dùng.
- **Riêng tư & nội bộ**: Server HTTP chỉ lắng nghe trên `127.0.0.1:47891`, kiểm tra `Host` & `Origin` chống CSRF. Thư mục dữ liệu `~/.google-one-pool` có quyền `0700`, database SQLite `0600`.

## Cài đặt & Khởi chạy nhanh (macOS)

Yêu cầu: Node.js `>= 26.0` (đã có sẵn `node:sqlite` và TypeScript native), Google Chrome (hoặc Brave), và Xcode Command Line Tools (`swiftc`) nếu muốn build Menu Bar app. Không cần `npm install`.

### Cách 1: Nhập tài khoản đang đăng nhập sẵn từ trình duyệt (Khuyên dùng)

Nếu trình duyệt Chrome / Brave của anh đã đăng nhập sẵn các tài khoản Google AI Pro:

- **Trên Web Dashboard (`http://127.0.0.1:47891`)**: bấm **`Nhập từ Chrome`** ở góc trên:
  - **Tab 1 — Quét Chrome / Brave tự động**: tự quét email & profile từ metadata Chrome (`Local State` / `Preferences`). *(Nếu macOS chặn quyền `EPERM`, hoặc tài khoản chỉ đăng nhập Web không bật Chrome Sync, dùng Tab 2.)*
  - **Tab 2 — Dán nhiều email (1 Profile gộp `/u/0`, `/u/1`...)**: bấm **`1. Mở trang tài khoản Google`** (`accounts.google.com/SignOutOptions`) → nhấn `⌘A` `⌘C` → quay lại bấm **`2. Dán từ Clipboard & Tự lọc Email`** (dán nguyên cả trang web, app tự lọc mọi Gmail & tên hiển thị) → bấm nhập là dùng ngay không cần đăng nhập lại!
- **Hoặc qua CLI**:

```bash
# 1) Tự quét các tài khoản có sẵn trong Chrome / Brave (thêm --dry-run để xem trước)
node bin/gpool.ts import-chrome --tags pro

# 2) Nhập nhanh từ Clipboard sau khi ⌘A ⌘C trên https://accounts.google.com/SignOutOptions
node bin/gpool.ts import-clipboard --profile "Default" --tags pro

# 3) Hoặc nhập hàng loạt nhiều Gmail đang đăng nhập chung trong 1 Chrome profile (multi-login /u/0, /u/1...)
node bin/gpool.ts import-emails --emails "acc1@gmail.com,acc2@gmail.com,acc3@gmail.com" --profile "Default" --tags pro

# Khi muốn tách 1 hoặc tất cả tài khoản sang Chrome profile riêng để Keep-Alive quét ngầm độc lập:
node bin/gpool.ts isolate acc2
node bin/gpool.ts isolate --all
node bin/gpool.ts login-wizard
```

### Cách 2: Thêm thủ công & chạy Dashboard / Menu Bar

```bash
# 1. Thêm thủ công tài khoản Google AI Pro mới
node bin/gpool.ts add pro1 acc1@gmail.com --tags pro,chinh --renewal 2026-12-31
node bin/gpool.ts login pro1

# 2. Khởi động daemon nền + mở Web Dashboard (http://127.0.0.1:47891)
node bin/gpool.ts daemon start
node bin/gpool.ts dashboard

# 3. Build và bật app Menu Bar macOS (tuỳ chọn)
node bin/gpool.ts menubar build
node bin/gpool.ts menubar start

# 4. Tự chạy daemon khi khởi động macOS (tuỳ chọn)
node bin/gpool.ts launchagent install
```

*(Gợi ý: có thể tạo alias `alias gpool="node /Users/huynguyen-max/Documents/GitHub/google-one-pool/bin/gpool.ts"` trong `~/.zshrc`.)*

## Hai chế độ Profile: `linked` vs `isolated`

| Chế độ | Cách hoạt động | Ưu điểm | Phù hợp khi |
| :--- | :--- | :--- | :--- |
| **`linked`** (mặc định khi import từ Chrome) | Dùng chung `--profile-directory` của Chrome gốc kết hợp `?authuser=` / `login_hint=` cho Google & OAuth | **Dùng ngay 100% không phải login lại**, không tốn thêm dung lượng đĩa | Vừa nhập 5–15 acc đang mở sẵn trên Chrome chính |
| **`isolated`** (profile tách riêng) | Mỗi tài khoản có 1 `--user-data-dir` riêng dưới `~/.google-one-pool/chrome-profiles/` | **Keep-Alive headless chạy độc lập**, cookie từng acc hoàn toàn tách biệt, không sợ bị lẫn phiên | Chạy đường dài ổn định nhất sau khi bấm **`Tách profile riêng`** từng acc |

## Quy trình chuyển tài khoản cho `agy` CLI (phiên đã lưu — không cần OAuth lại)

`agy` giữ phiên đăng nhập trong macOS Keychain (`gemini`:`antigravity`). `gpool` lưu snapshot phiên đó **theo từng tài khoản** và nạp lại khi đổi acc — mọi acc "login sẵn" cùng lúc.

**Lần đầu với mỗi tài khoản** (đăng nhập OAuth như cũ):

1. `gpool switch <alias>` (hoặc `gpool next`) để mở đúng Chrome của acc.
2. Trong `agy`, chạy `/login` và hoàn tất OAuth (dùng `gpool auth <alias>` để mở link OAuth vào đúng profile).
3. **`gpool agy-capture <alias>`** — lưu phiên hiện tại vào pool. Xong — acc đó từ nay "login sẵn".

**Đổi acc hàng ngày** (không cần OAuth lại, không cần `/logout`):

```bash
gpool agy                       # Chạy agy có khóa agy.lock + tự chọn acc sẵn sàng
gpool agy --bucket auto -- -p "Tác vụ..."  # Tự bắt lỗi quota, đặt cooldown & failover xoay acc
gpool agy-next                  # Đổi acc agy kế tiếp + nạp thẳng Keychain trong 1 lệnh
gpool agy-activate <alias>      # Nạp phiên agy của 1 acc cụ thể
gpool agy-health                # Kiểm tra sức khỏe snapshot agy + mã hóa AES-256 + cảnh báo gia hạn
gpool agy-encrypt               # Mã hóa toàn bộ kho agy-sessions bằng AES-256-GCM (Keychain master key)
gpool agy-onboard               # Wizard 1/N tự bắt link OAuth & tự động capture phiên agy
gpool stats                     # Biểu đồ hiệu suất & thống kê quota 7 ngày
gpool export backup.enc --encrypted --with-sessions  # Backup mã hóa chuyển máy kèm phiên agy
gpool mcp                       # Chạy MCP Server (stdio) cho AI Agents (Devin/Claude/Codex/Cursor)
```

Cơ chế & an toàn:

- `agy-capture` đọc item `gemini`:`antigravity` + file `credential-user-scope` (+ file secrets fallback nếu có) → ghi snapshot `~/.google-one-pool/agy-sessions/<alias>.json` (`0700`, file `0600`).
- `agy-activate` **tự re-capture phiên đang nạp** về đúng acc trước khi ghi đè (giữ refresh-token mới nhất); nếu không xác định được chủ phiên hiện tại thì sao lưu vào `_orphan.json` chứ không mất.
- **Từ chối chạy khi `agy`/Antigravity đang mở** (nó giữ credential trong RAM và sẽ ghi đè lại lúc refresh) — hãy đóng agy trước, hoặc `--force` nếu chắc chắn.
- **Không dùng `/logout` để đổi acc** — logout revoke refresh token, snapshot vô dụng. Chỉ cần đóng agy → activate → mở lại.
- Nếu credential detect được email khác acc yêu cầu, `agy-capture` sẽ báo lỗi thay vì lưu nhầm.

*(Nếu anh dùng Google Cloud / Enterprise ADC cho `agy`, gắn đường dẫn file ADC JSON vào tài khoản rồi chạy `gpool run <alias> -- agy`.)*

## Danh sách lệnh CLI (`gpool`)

> Xem hướng dẫn đầy đủ kèm ví dụ và xử lý lỗi tại [docs/CLI-GUIDE.md](./docs/CLI-GUIDE.md).

| Lệnh | Công dụng |
| :--- | :--- |
| `gpool` / `gpool tui` (`ui`) | Mở giao diện TUI tương tác toàn màn hình trên Terminal |
| `gpool help [lệnh]` | Xem hướng dẫn tổng quan hoặc chi tiết từng lệnh |
| `gpool import-chrome [--dry-run] [--isolated] [--tags pro]` | Quét và nhập các tài khoản đang có trên Chrome / Brave |
| `gpool import-clipboard [--profile "Default"] [--isolated]` | Đọc clipboard sau khi `⌘A` `⌘C` trang Account Chooser và tự lọc mọi email để nhập |
| `gpool import-emails <file \| --emails "..."> [--profile "Default"] [--isolated]` | Nhập hàng loạt nhiều Gmail đang đăng nhập chung 1 profile Chrome |
| `gpool isolate <alias \| --all> [--no-open]` | Tách 1 hoặc tất cả tài khoản từ `linked` sang Chrome profile riêng (`isolated`) |
| `gpool add <alias> <email> [flags]` | Thêm tài khoản thủ công (`--tags`, `--renewal YYYY-MM-DD`, `--proxy`, `--plan`, `--notes`) |
| `gpool list [--status ...] [--tag ...] [-q ...] [--json]` | Xem danh sách tài khoản trong pool |
| `gpool show <alias> [--json]` | Xem chi tiết một tài khoản |
| `gpool edit <alias> [flags]` | Sửa thông tin tài khoản |
| `gpool rm <alias> [--purge]` | Xóa tài khoản (`--purge` chỉ áp dụng cho profile `isolated`) |
| `gpool login <alias>` | Mở Chrome profile để đăng nhập Google (điền sẵn email) |
| `gpool login-wizard` | Mở nối tiếp từng profile riêng đang chờ đăng nhập (1/N) |
| `gpool open <alias> [url]` | Mở/focus cửa sổ Chrome của tài khoản |
| `gpool switch <alias> [--no-open]` | Chọn tài khoản làm active và mở Chrome |
| `gpool next [--cooldown 5] [--tag ...]` | Đặt cooldown acc hiện tại và xoay sang acc sẵn sàng tiếp theo |
| `gpool auth <alias> [oauth-url]` | Mở link OAuth vào đúng profile Chrome (tự đọc clipboard nếu bỏ trống URL) |
| `gpool cooldown <alias> <hours\|clear>` | Đặt hoặc gỡ cooldown thủ công |
| `gpool check [alias]` | Kiểm tra & làm mới phiên cho 1 hoặc tất cả tài khoản |
| `gpool agy-capture <alias>` | Lưu phiên đăng nhập `agy` hiện tại trong Keychain vào tài khoản |
| `gpool agy-activate <alias> [--force]` | Nạp phiên agy đã lưu vào Keychain (tự re-capture phiên cũ trước) |
| `gpool agy-status` | Xem phiên agy đang nạp là của acc nào + danh sách phiên đã lưu |
| `gpool run <alias> -- <cmd...>` | Chạy lệnh với env chính thống (`AGY_ADC_AUTH` / `GEMINI_CLI_HOME`); nếu là `agy` thì tự nạp phiên đã lưu |
| `gpool daemon <start\|stop\|status\|run>` | Quản lý HTTP daemon & bộ lập lịch Keep-Alive |
| `gpool dashboard` | Bật daemon nếu cần và mở Web Dashboard |
| `gpool menubar <build\|start\|stop>` | Build và bật/tắt Menu Bar macOS |
| `gpool launchagent <install\|uninstall\|status>` | Cài hoặc gỡ tự khởi động cùng macOS |
| `gpool export [file.json]` / `gpool import <file.json>` | Sao lưu / khôi phục metadata (không bao gồm cookie) |
