# Hướng dẫn sử dụng CLI & TUI (`gpool`)

Tài liệu này hướng dẫn chi tiết cách cài đặt, sử dụng **giao diện TUI tương tác** (`gpool` / `gpool tui`) và toàn bộ **lệnh CLI `gpool`** để quản lý pool tài khoản Google AI Pro cho `agy` CLI, `gemini` CLI và Google Chrome trên macOS.

---

## Mục lục

1. [Cài đặt nhanh lệnh `gpool`](#1-cài-đặt-nhanh-lệnh-gpool)
2. [Dùng giao diện TUI tương tác (Khuyên dùng)](#2-dùng-giao-diện-tui-tương-tác-khuyên-dùng)
3. [Bắt đầu nhanh trong 2 phút](#3-bắt-đầu-nhanh-trong-2-phút)
4. [Các quy trình làm việc thực tế](#4-các-quy-trình-làm-việc-thực-tế)
5. [Tra cứu chi tiết toàn bộ lệnh CLI](#5-tra-cứu-chi-tiết-toàn-bộ-lệnh-cli)
6. [Biến môi trường & cấu trúc thư mục dữ liệu](#6-biến-môi-trường--cấu-trúc-thư-mục-dữ-liệu)
7. [Xử lý lỗi thường gặp (Troubleshooting)](#7-xử-lý-lỗi-thường-gặp-troubleshooting)

---

## 1. Cài đặt nhanh lệnh `gpool`

### Yêu cầu hệ thống
- **Node.js `>= 26.0`** (đã có sẵn `node:sqlite` và chạy thẳng file `.ts`, không cần `npm install`).
- **Google Chrome** hoặc **Brave Browser**.
- **macOS** (tính năng `agy-capture` / `agy-activate` dùng macOS Keychain qua `/usr/bin/security`; Menu Bar app dùng `swiftc`).

Kiểm tra nhanh phiên bản Node:

```bash
node -v
# Ví dụ: v26.13.0
```

### Tạo lệnh ngắn `gpool` dùng ở mọi thư mục

**Cách 1 — Thêm `alias` vào `~/.zshrc` (nhanh nhất):**

```bash
echo 'alias gpool="node /Users/huynguyen-max/Documents/GitHub/google-one-pool/bin/gpool.ts"' >> ~/.zshrc
source ~/.zshrc
```

**Cách 2 — Dùng `npm link`:**

```bash
cd /Users/huynguyen-max/Documents/GitHub/google-one-pool
chmod +x bin/gpool.ts
npm link
```

**Cách 3 — Chạy trực tiếp trong thư mục dự án (không cần cài):**

```bash
npm run tui                 # mở giao diện TUI
npm run gpool -- list       # chạy lệnh CLI bất kỳ
```

> Mẹo: Mọi lệnh đều hỗ trợ xem hướng dẫn chi tiết ngay trên Terminal bằng `gpool help <tên-lệnh>` hoặc `gpool <tên-lệnh> --help` (ví dụ: `gpool help agy-activate`).

---

## 2. Dùng giao diện TUI tương tác (Khuyên dùng)

Chế độ **TUI (Terminal UI)** cho phép thao tác toàn bộ tính năng bằng bàn phím mà không cần nhớ cú pháp hay cờ lệnh.

### Cách mở TUI

```bash
gpool          # Gõ "gpool" không tham số trong Terminal sẽ tự mở TUI
# hoặc:
gpool tui      # Mở TUI tường minh (alias: gpool ui)
```

- TUI tự động kết nối tới **Daemon (`127.0.0.1:47891`)** khi daemon đang chạy (mọi thao tác đồng bộ tức thì sang Web Dashboard và Menu Bar macOS).
- Khi daemon chưa chạy, TUI tự động chuyển sang chế độ **Local DB** và vẫn thao tác bình thường; nhấn `D` để bật daemon hoặc mở Web Dashboard bất cứ lúc nào.

### Bảng phím tắt trong TUI

#### Di chuyển & tìm kiếm
| Phím | Công dụng |
| :--- | :--- |
| `↑` / `↓` hoặc `k` / `j` | Di chuyển chọn tài khoản |
| `PgUp` / `PgDn` | Cuộn nhanh 5 tài khoản |
| `1` – `9` | Nhảy nhanh tới tài khoản thứ 1–9 trong danh sách |
| `/` | Tìm kiếm trực tiếp theo alias, email, tag, ghi chú (`Enter` giữ lọc, `Esc` xóa tìm) |
| `f` | Chuyển vòng bộ lọc trạng thái (`Tất cả` → `Sẵn sàng` → `Cooldown` → `Cần login/Lỗi` → `Chưa quét`) |
| `Esc` | Đóng hộp thoại hiện tại hoặc xóa bộ lọc đang áp dụng |
| `r` | Làm mới dữ liệu ngay lập tức |

#### Thao tác tài khoản & `agy` CLI
| Phím | Công dụng | Lệnh CLI tương đương |
| :--- | :--- | :--- |
| `Enter` hoặc `s` | Chọn tài khoản làm active và mở Chrome Profile | `gpool switch <alias>` |
| `S` (`Shift+s`) | Chọn tài khoản làm active **không** mở Chrome | `gpool switch <alias> --no-open` |
| `g` | **Tự nạp phiên `agy` rồi chạy thẳng lệnh `agy`** (thoát `agy` sẽ quay lại TUI) | `gpool run <alias> -- agy` |
| `a` | Nạp phiên `agy` đã lưu của acc đang chọn vào Keychain | `gpool agy-activate <alias>` |
| `c` | Lưu phiên `agy` hiện đang đăng nhập trong Keychain vào acc đang chọn | `gpool agy-capture <alias>` |
| `A` (`Shift+a`) | Xem chi tiết trạng thái Keychain `agy` & toàn bộ snapshot đã lưu | `gpool agy-status` |
| `n` | Hết quota → đặt cooldown cho acc hiện tại và xoay sang acc kế tiếp | `gpool next` |
| `o` | Mở / focus cửa sổ Chrome Profile | `gpool open <alias>` |
| `l` | Mở Chrome tại trang đăng nhập Google (điền sẵn email) | `gpool login <alias>` |
| `u` | Mở link OAuth (tự điền sẵn từ Clipboard macOS) vào đúng profile | `gpool auth <alias> [url]` |
| `x` | Mở menu đặt cooldown (`+1h`, `+5h`, `+24h`, `+7d`, tùy chỉnh) hoặc gỡ cooldown | `gpool cooldown <alias> <h\|clear>` |
| `p` | Kiểm tra & làm mới phiên cho tài khoản đang chọn | `gpool check <alias>` |
| `P` (`Shift+p`) | Quét giữ phiên (Keep-Alive sweep) toàn bộ pool | `gpool check` |

#### Quản lý danh sách & hệ thống
| Phím | Công dụng | Lệnh CLI tương đương |
| :--- | :--- | :--- |
| `+` | Mở form tương tác thêm tài khoản mới | `gpool add <alias> <email>` |
| `i` | Mở menu nhập nhanh: Quét Chrome / Mở SignOutOptions / Clipboard / Danh sách / Login Wizard | `gpool import-chrome` / `import-clipboard` |
| `t` | Tách tài khoản `linked` hiện tại (hoặc tất cả) sang Chrome profile riêng | `gpool isolate <alias\|--all>` |
| `e` | Mở form sửa thông tin tài khoản đang chọn | `gpool edit <alias>` |
| `d` | Xóa tài khoản (có xác nhận, tùy chọn `--purge` cho profile riêng) | `gpool rm <alias>` |
| `v` | Xem nhật ký hoạt động gần đây (có cuộn `↑/↓`) | — |
| `D` (`Shift+d`) | Menu Hệ thống: Mở Web Dashboard, Start/Stop Daemon, Menu Bar, LaunchAgent, Export JSON | `gpool daemon` / `dashboard` / `menubar` |
| `?` | Mở bảng hướng dẫn phím tắt & lệnh CLI ngay trong TUI | `gpool help` |
| `q` hoặc `Ctrl+C` | Thoát TUI (khôi phục nguyên trạng màn hình Terminal) | — |

---

## 3. Bắt đầu nhanh trong 2 phút

### Bước 1 — Nhập các tài khoản Google AI Pro đang đăng nhập sẵn trên Chrome

```bash
# Cách A: Tự quét metadata Chrome / Brave (xem trước bằng --dry-run)
gpool import-chrome --dry-run
gpool import-chrome --tags pro

# Cách B: Nếu Chrome đang gộp nhiều Gmail trong 1 profile (/u/0, /u/1...)
# 1) Mở https://accounts.google.com/SignOutOptions trên Chrome
# 2) Nhấn ⌘A rồi ⌘C để copy cả trang
# 3) Chạy lệnh sau để tự lọc toàn bộ email và nhập vào pool:
gpool import-clipboard --profile "Default" --tags pro
```

### Bước 2 — Kiểm tra danh sách tài khoản

```bash
gpool list
```

### Bước 3 — Lưu phiên `agy` lần đầu cho từng tài khoản

```bash
# 1) Đảm bảo agy đã đăng nhập tài khoản pro1 (nếu chưa, đăng nhập OAuth bình thường)
gpool agy-capture pro1

# 2) Chuyển sang tài khoản pro2 để đăng nhập OAuth lần đầu rồi lưu tiếp:
gpool switch pro2
# ... hoàn tất /login trong agy (có thể dùng "gpool auth pro2" để mở link OAuth từ clipboard vào đúng profile) ...
gpool agy-capture pro2
```

### Bước 4 — Đổi tài khoản hằng ngày (tức thì, không cần OAuth lại)

```bash
# Cách 1: Chạy thẳng agy với tài khoản mong muốn (tự nạp phiên Keychain)
gpool run pro2 -- agy

# Cách 2: Hoặc đổi phiên Keychain trước rồi tự gõ "agy"
gpool agy-activate pro2
agy

# Cách 3: Dùng TUI — gõ "gpool", chọn acc rồi bấm [g] để vào thẳng agy!
```

---

## 4. Các quy trình làm việc thực tế

### Quy trình A — Quy tắc vàng khi đổi phiên `agy` (Keychain)

1. **Đóng `agy` / Antigravity trước khi nạp phiên**: ứng dụng `agy` giữ token trong RAM và sẽ ghi đè Keychain lúc refresh. `gpool agy-activate` sẽ tự động kiểm tra và từ chối nếu thấy tiến trình `agy` đang mở (chỉ dùng `--force` khi thật sự chắc chắn).
2. **TUYỆT ĐỐI KHÔNG dùng `/logout` để đổi acc đã lưu**: lệnh `/logout` gửi yêu cầu thu hồi (revoke) refresh token trên máy chủ Google, làm snapshot đã lưu của tài khoản đó hết hiệu lực. Chỉ cần đóng `agy` → chạy `gpool agy-activate <alias>` (hoặc `gpool run <alias> -- agy`) → mở lại.
3. **Tự động bảo toàn token mới nhất**: mỗi khi đổi từ acc A sang acc B, `gpool` tự động cập nhật lại snapshot của acc A bằng token mới nhất đang nằm trong Keychain (tránh bị trôi refresh token). Nếu Keychain đang chứa phiên lạ chưa thuộc acc nào trong pool, `gpool` sao lưu dự phòng vào `~/.google-one-pool/agy-sessions/_orphan.json`.

### Quy trình B — Hết quota và xoay vòng tự động

Khi tài khoản hiện tại bị giới hạn quota (ví dụ 5 giờ):

```bash
# Đặt cooldown 5h cho acc hiện tại, tự tìm acc sẵn sàng kế tiếp (ưu tiên live + ít dùng gần đây nhất)
gpool next --cooldown 5 --reason "Hết quota Gemini Pro"

# Chỉ xoay trong nhóm tài khoản có tag "work"
gpool next --tag work --cooldown 5

# Đặt hoặc gỡ cooldown thủ công cho 1 tài khoản cụ thể
gpool cooldown pro1 24 --reason "Chờ reset ngày mai"
gpool cooldown pro1 clear
```

Sau khi xoay sang acc mới (ví dụ `pro2`), nạp phiên `agy` và chạy tiếp:

```bash
gpool run pro2 -- agy
```

### Quy trình C — Chuyển từ `linked` sang `isolated` để Keep-Alive chạy ngầm độc lập

| Chế độ | Khi nào dùng | Keep-Alive ngầm |
| :--- | :--- | :--- |
| **`linked`** | Vừa nhập 5–15 acc đang đăng nhập sẵn trong Chrome chính; muốn dùng ngay 100% không cần login lại | Chrome gốc tự duy trì phiên (Chrome 136+ chặn headless debug trên thư mục mặc định) |
| **`isolated`** | Muốn mỗi acc có `--user-data-dir` riêng biệt hoàn toàn, tách cookie tuyệt đối, Keep-Alive tự làm mới định kỳ | Quét & làm mới cookie ngầm tự động theo lịch |

Cách chuyển sang `isolated`:

```bash
# Tách 1 tài khoản (tự mở cửa sổ Chrome mới điền sẵn email để đăng nhập 1 lần)
gpool isolate pro2

# Hoặc tách hàng loạt toàn bộ acc đang ở chế độ linked
gpool isolate --all
# Sau đó chạy Wizard đăng nhập lần lượt từng cửa sổ (1/N):
gpool login-wizard
```

### Quy trình D — Dùng với `gemini` CLI hoặc Google Cloud ADC

- **Với `gemini` CLI**: `gpool run <alias> -- gemini` tự tạo và gán `GEMINI_CLI_HOME=~/.google-one-pool/gemini-homes/<alias>` riêng biệt cho từng tài khoản.
- **Với `agy` dùng Google Cloud / Enterprise ADC**:

```bash
gpool edit work1 --adc /Users/you/.config/gcloud/work1-adc.json
gpool run work1 -- agy
# Tự động đặt AGY_ADC_AUTH=true và GOOGLE_APPLICATION_CREDENTIALS=...
```

### Quy trình E — Chạy nền tự động (Daemon + Web Dashboard + Menu Bar + LaunchAgent)

```bash
# 1. Khởi động daemon nền + mở Web Dashboard (http://127.0.0.1:47891)
gpool daemon start
gpool dashboard

# 2. Build & mở ứng dụng Menu Bar macOS (chuyển acc nhanh ngay trên thanh menu)
gpool menubar build
gpool menubar start

# 3. Cài tự khởi động daemon mỗi khi mở máy macOS
gpool launchagent install
gpool launchagent status
```

### Quy trình F — Sao lưu / khôi phục & dùng trong script (`--json`)

```bash
# Xuất metadata (alias, email, tags, ghi chú, ngày gia hạn, cài đặt — KHÔNG bao gồm cookie hay token)
gpool export backup-pool.json

# Khôi phục trên máy mới hoặc sau khi cài lại
gpool import backup-pool.json

# Lấy danh sách tài khoản sẵn sàng dạng JSON để xử lý với jq
gpool list --status ready --json | jq -r '.accounts[].alias'
```

---

## 5. Tra cứu chi tiết toàn bộ lệnh CLI

### Giao diện & Trợ giúp
| Lệnh | Cú pháp & Flags | Mô tả |
| :--- | :--- | :--- |
| `tui` (`ui`) | `gpool` hoặc `gpool tui [--port 47891]` | Mở giao diện TUI tương tác toàn màn hình |
| `help` | `gpool help [lệnh]` hoặc `gpool <lệnh> --help` | Xem hướng dẫn tổng quan hoặc chi tiết cho từng lệnh |

### Quản lý & nhập tài khoản
| Lệnh | Cú pháp & Flags | Mô tả |
| :--- | :--- | :--- |
| `add` | `gpool add <alias> <email> [--name "..."] [--plan "..."] [--renewal YYYY-MM-DD] [--tags a,b] [--proxy <url>] [--adc <file>] [--notes "..."] [--json]` | Thêm thủ công tài khoản mới (tạo profile riêng) |
| `import-chrome` | `gpool import-chrome [--dry-run] [--isolated] [--plan "..."] [--tags a,b] [--json]` | Quét metadata `Local State` / `Preferences` của Chrome & Brave để nhập |
| `import-clipboard` | `gpool import-clipboard [--profile "Default"] [--browser chrome\|brave] [--user-data-dir <dir>] [--dry-run] [--isolated] [--plan "..."] [--tags a,b] [--json]` | Tự lọc email & tên hiển thị từ Clipboard sau khi `⌘A ⌘C` trang `SignOutOptions` |
| `import-emails` | `gpool import-emails <file.txt \| --emails "a@g.com,b@g.com"> [--profile "Default"] [--browser chrome\|brave] [--dry-run] [--isolated] [--plan "..."] [--tags a,b] [--json]` | Nhập hàng loạt từ file hoặc chuỗi email (hỗ trợ `alias email`, `email \| ghi chú`) |
| `list` (`ls`) | `gpool list [--status active\|ready\|cooldown\|needs_login\|unknown\|error] [--tag <tag>] [-q <từ khóa>] [--json]` | Liệt kê tài khoản trong pool |
| `show` (`info`) | `gpool show <alias> [--json]` | Xem thông tin đầy đủ của 1 tài khoản (gồm trạng thái phiên `agy`) |
| `edit` | `gpool edit <alias> [--alias ...] [--email ...] [--name ...] [--plan ...] [--renewal YYYY-MM-DD\|""] [--tags a,b] [--proxy <url>\|""] [--adc <file>\|""] [--authuser ...] [--notes "..."] [--json]` | Cập nhật thông tin tài khoản (đổi alias tự đổi tên profile riêng và snapshot `agy`) |
| `rm` (`delete`) | `gpool rm <alias> [--purge] [--json]` | Xóa tài khoản khỏi pool (`--purge` chỉ xóa profile `isolated`, không bao giờ đụng Chrome gốc) |

### Điều khiển Chrome, OAuth, vòng xoay & Keep-Alive
| Lệnh | Cú pháp & Flags | Mô tả |
| :--- | :--- | :--- |
| `login` | `gpool login <alias> [--json]` | Mở Chrome tại trang đăng nhập Google đã điền sẵn email |
| `login-wizard` | `gpool login-wizard` | Mở lần lượt từng profile riêng đang chờ đăng nhập (1/N) và xác nhận Live |
| `open` | `gpool open <alias> [url] [--json]` | Mở / focus cửa sổ Chrome của tài khoản |
| `switch` (`use`) | `gpool switch <alias> [--no-open] [--cooldown-prev <giờ>] [--reason "..."] [--url <url>] [--json]` | Đặt tài khoản làm active và mở Chrome |
| `next` (`rotate`) | `gpool next [--cooldown <giờ>] [--reason "..."] [--tag <tag>] [--no-open] [--json]` | Đặt cooldown acc hiện tại và xoay sang acc sẵn sàng tiếp theo |
| `auth` | `gpool auth <alias> [oauth-url] [--json]` | Mở link OAuth vào đúng Chrome profile (tự đọc từ Clipboard nếu bỏ trống URL) |
| `isolate` | `gpool isolate <alias \| --all> [--no-open] [--json]` | Tách 1 hoặc tất cả acc `linked` sang Chrome profile riêng |
| `cooldown` | `gpool cooldown <alias> <giờ \| clear> [--reason "..."] [--json]` | Đặt hoặc gỡ cooldown thủ công |
| `check` | `gpool check [alias] [--json]` | Kiểm tra & làm mới phiên cho 1 acc hoặc toàn bộ pool |

### Phiên `agy` CLI (macOS Keychain) & chạy lệnh
| Lệnh | Cú pháp & Flags | Mô tả |
| :--- | :--- | :--- |
| `agy-capture` | `gpool agy-capture <alias> [--json]` | Lưu phiên `agy` hiện tại trong Keychain vào snapshot của `<alias>` |
| `agy-activate` | `gpool agy-activate <alias> [--force] [--json]` | Nạp snapshot phiên `agy` của `<alias>` vào Keychain (tự re-capture acc cũ trước) |
| `agy-status` | `gpool agy-status [--json]` | Xem phiên đang nạp trong Keychain, tiến trình `agy` đang chạy và danh sách snapshot |
| `run` | `gpool run <alias> [--force] -- <lệnh...>` | Chạy lệnh với ngữ cảnh tài khoản (`agy`: tự nạp Keychain/ADC; `gemini`: `GEMINI_CLI_HOME`) |

### Dịch vụ nền, Dashboard, macOS & Sao lưu
| Lệnh | Cú pháp & Flags | Mô tả |
| :--- | :--- | :--- |
| `daemon` | `gpool daemon <start\|stop\|status\|run> [--port 47891] [--json]` | Quản lý HTTP daemon & lịch Keep-Alive chạy nền |
| `dashboard` | `gpool dashboard [--port 47891]` | Tự bật daemon nếu cần và mở Web Dashboard (`http://127.0.0.1:47891`) |
| `menubar` | `gpool menubar <build\|start\|stop>` | Build và bật/tắt ứng dụng Menu Bar macOS |
| `launchagent` | `gpool launchagent <install\|uninstall\|status> [--json]` | Cài / gỡ tự khởi động daemon cùng macOS |
| `export` | `gpool export [file.json]` | Xuất metadata tài khoản & cài đặt ra JSON |
| `import` | `gpool import <file.json> [--json]` | Nhập metadata từ file JSON đã xuất |

---

## 6. Biến môi trường & cấu trúc thư mục dữ liệu

### Biến môi trường hỗ trợ
| Biến | Mặc định | Công dụng |
| :--- | :--- | :--- |
| `GPOOL_HOME` | `~/.google-one-pool` | Thư mục lưu database, Chrome profiles riêng và snapshot phiên `agy` |
| `GPOOL_PORT` | `47891` | Cổng HTTP localhost của daemon (cũng có thể truyền `--port <số>`) |
| `GPOOL_CHROME_BIN` | Tự dò Chrome/Brave | Ghi đè đường dẫn binary Chrome/Brave mặc định |
| `NO_COLOR` | (không đặt) | Đặt giá trị bất kỳ (ví dụ `NO_COLOR=1`) để tắt màu ANSI trong TUI |

### Cấu trúc thư mục `~/.google-one-pool` (quyền `0700`)

```text
~/.google-one-pool/
├── pool.db                 # SQLite database (0600): accounts, events, settings
├── daemon.pid              # PID tiến trình daemon nền
├── daemon.log              # Log hoạt động daemon
├── chrome-profiles/        # Các Chrome --user-data-dir riêng (chế độ isolated)
│   └── <alias>/
├── gemini-homes/           # GEMINI_CLI_HOME riêng cho gemini CLI
│   └── <alias>/
└── agy-sessions/           # Snapshot phiên agy Keychain (0700, file 0600)
    ├── _active.json        # Marker alias vừa activate/capture gần nhất
    ├── _orphan.json        # Bản sao dự phòng nếu Keychain có phiên lạ bị ghi đè
    └── <alias>.json        # Snapshot phiên agy của từng tài khoản
```

---

## 7. Xử lý lỗi thường gặp (Troubleshooting)

1. **macOS báo `EPERM` / `EACCES` khi chạy `gpool import-chrome`**
   - Do cơ chế bảo vệ quyền riêng tư (TCC) của macOS chặn Terminal đọc thư mục `~/Library/Application Support/Google/Chrome`.
   - **Cách nhanh nhất (không cần cấp quyền)**: mở `https://accounts.google.com/SignOutOptions` trên Chrome → nhấn `⌘A` `⌘C` → chạy `gpool import-clipboard --tags pro` (hoặc chọn `[i]` trong TUI).
   - Hoặc bật **Full Disk Access** cho Terminal/IDE trong *System Settings → Privacy & Security* rồi khởi động lại daemon (`gpool daemon stop && gpool daemon start`).

2. **`agy-activate` báo lỗi: "Đang có tiến trình agy chạy"**
   - Đóng hẳn cửa sổ Terminal đang chạy `agy` (hoặc app Antigravity) rồi chạy lại để tránh `agy` ghi đè token cũ ngược lại Keychain.
   - Chỉ dùng `gpool agy-activate <alias> --force` (hoặc nhấn `F` trong TUI) nếu chắc chắn tiến trình đó sẽ không refresh token.

3. **`agy-capture` báo lỗi: "Phiên agy trong Keychain đang thuộc email khác"**
   - `gpool` tự kiểm tra `id_token_email` trong credential để chống lưu nhầm acc A vào alias B. Hãy kiểm tra `gpool agy-status` để xem Keychain hiện đang chứa email nào, rồi capture vào đúng alias tương ứng.

4. **Chạy `gpool tui` báo "yêu cầu terminal tương tác (TTY)"**
   - TUI cần Terminal trực tiếp (không chạy qua pipe/non-interactive shell). Trong script tự động hãy dùng các lệnh CLI chuẩn kèm `--json`.

5. **Web Dashboard hoặc TUI chưa thấy cập nhật sau khi đổi phiên hoặc nâng cấp mã nguồn**
   - Khởi động lại daemon nền: `gpool daemon stop && gpool daemon start`.
