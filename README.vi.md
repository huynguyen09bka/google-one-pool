# Google One Pool (`gpool`)

[English](./README.md) | **Tiếng Việt**

Công cụ quản lý pool nhiều tài khoản **Google AI Pro / Ultra** (3–15+ tài khoản) trên macOS cho **`agy` CLI**, **`gemini` CLI**, **AI Coding Agents (qua MCP)** và trình duyệt **Google Chrome / Brave** — không cần `npm install`, hỗ trợ đầy đủ **Tiếng Việt & English (`VI` / `EN`)** trên mọi giao diện.

> **Tài liệu hướng dẫn CLI & TUI đầy đủ**: [docs/CLI-GUIDE.md](./docs/CLI-GUIDE.md) (Tiếng Việt) | [docs/CLI-GUIDE.en.md](./docs/CLI-GUIDE.en.md) (English)

---

## Tính năng nổi bật

- **Không phụ thuộc thư viện ngoài**: Chạy trực tiếp bằng **Node.js `>= 26.0`** (`node:sqlite`, TypeScript native, `node:crypto`). Không cần `npm install`.
- **Song ngữ toàn hệ thống (`VI` / `EN`)**: Đổi ngôn ngữ tức thì bằng `gpool lang vi|en`, cờ `--lang`, biến `GPOOL_LANG`, phím `L` trong TUI, hoặc nút `VI`/`EN` trên Web Dashboard (đồng bộ sang cả Menu Bar macOS).
- **Giao diện TUI toàn màn hình (`gpool` / `gpool tui`)**: Thao tác mọi tính năng bằng 1 phím bấm mà không cần nhớ cờ lệnh.
- **Tự động xoay vòng & Auto-Failover `agy` (`gpool agy`)**:
  - Khóa nguyên tử `agy.lock` chống xung đột Keychain giữa nhiều terminal/agent.
  - Tự phát hiện lỗi hết quota (`429`, `RESOURCE_EXHAUSTED`, `"resets in 3h 30m"`), tự parse thời gian reset & model bucket (`pro`, `claude`, `opus`, `sonnet`, `flash`), đặt cooldown, nạp acc kế tiếp và tự chạy lại.
- **Tích hợp sẵn MCP Server (`gpool mcp`)**: Giao tiếp `stdio` JSON-RPC 2.0 với 8 tools (`pool_status`, `agy_health`, `agy_acquire`, `agy_release`, `agy_report_quota`, `agy_clear_cooldown`, `agy_run`, `pool_analytics`) để Devin, Claude Code, Codex, Cursor tự thuê & xoay tài khoản.
- **Bảo mật AES-256-GCM**:
  - Mã hóa kho phiên `agy-sessions` trên đĩa bằng 1 master key 256-bit lưu trong macOS Keychain (`gpool agy-encrypt`), gắn AAD theo alias chống tráo file.
  - Backup mã hóa di động (`scrypt` + `AES-256-GCM`) giúp chuyển cả metadata + toàn bộ phiên `agy` sang máy Mac khác an toàn.
- **Auto-Onboard 1/N (`gpool agy-onboard`)**: Tự bắt link OAuth Google mở vào đúng Chrome profile và tự động capture (mã hóa) ngay khi đăng nhập xong.
- **Thống kê hiệu suất 7 ngày (`gpool stats`)**: Biểu đồ lượt switch, nạp `agy`, đụng quota và độ phủ mã hóa trên CLI, TUI, Web Dashboard và MCP.

---

## Nguyên tắc an toàn & chính thống

- **Luồng chính thống**: Không đọc `Cookies`, `Login Data` hay giải mã `os_crypt` của Chrome; không vượt CAPTCHA/2FA. Với `agy`, `gpool` chỉ đọc/ghi đúng 1 mục Keychain chính thống `gemini`:`antigravity` qua `/usr/bin/security` theo lệnh người dùng.
- **Không bao giờ xóa Chrome profile gốc**: Xóa tài khoản chế độ `linked` chỉ gỡ khỏi pool, tuyệt đối không đụng vào thư mục Chrome gốc.
- **Nội bộ & riêng tư**: Server HTTP chỉ lắng nghe trên `127.0.0.1:47891` kèm kiểm tra `Host` & `Origin` chống CSRF. Thư mục `~/.google-one-pool` (`0700`), SQLite (`0600`), snapshot (`0600`, AES-256-GCM).

---

## Cài đặt & Khởi chạy nhanh (macOS)

Yêu cầu: Node.js `>= 26.0`, Google Chrome (hoặc Brave), và Xcode Command Line Tools (`swiftc`) nếu build Menu Bar app.

```bash
git clone https://github.com/huynguyen09bka/google-one-pool.git
cd google-one-pool

# Tạo lệnh ngắn gpool trong ~/.zshrc (tuỳ chọn)
echo 'alias gpool="node /path/to/google-one-pool/bin/gpool.ts"' >> ~/.zshrc
source ~/.zshrc

# Mở giao diện TUI tương tác (hoặc đổi ngôn ngữ: gpool lang en / gpool lang vi)
gpool
```

### 1. Nhập nhanh tài khoản đã đăng nhập sẵn từ Chrome / Brave

```bash
# Cách 1: Tự quét metadata Chrome / Brave (xem trước bằng --dry-run)
gpool import-chrome --dry-run
gpool import-chrome --tags pro

# Cách 2: Nhiều Gmail gộp trong 1 profile Chrome (/u/0, /u/1...)
# Mở https://accounts.google.com/SignOutOptions -> nhấn ⌘A ⌘C -> chạy:
gpool import-clipboard --profile "Default" --tags pro

# Cách 3: Thêm thủ công
gpool add pro1 acc1@example.com --tags pro,chinh --renewal 2026-12-31
```

### 2. Lưu & xoay vòng phiên `agy` CLI (không cần OAuth lại)

Lần đầu cho các acc mới:

```bash
gpool agy-onboard             # Wizard 1/N tự bắt OAuth + tự capture mã hóa
# Hoặc capture thủ công sau khi đăng nhập agy:
gpool agy-capture pro1
```

Sử dụng hằng ngày (**không dùng `/logout`** để đổi acc vì sẽ thu hồi refresh token — chỉ cần đóng `agy` rồi xoay):

```bash
gpool agy                                   # Chạy agy có khóa agy.lock + tự chọn acc sẵn sàng
gpool agy --bucket auto -- -p "Review PR"   # Tự bắt lỗi quota, đặt cooldown & failover xoay acc
gpool agy-next --cooldown 5                 # Đặt cooldown acc cũ + nạp thẳng phiên agy kế tiếp
gpool agy-health                            # Kiểm tra sức khỏe snapshot, mã hóa AES-256 & gia hạn
gpool agy-encrypt                           # Mã hóa toàn bộ snapshot cũ bằng AES-256-GCM
gpool stats                                 # Biểu đồ hiệu suất & quota 7 ngày
```

### 3. Dịch vụ nền, Web Dashboard & Menu Bar macOS

```bash
gpool daemon start            # Chạy daemon nền (127.0.0.1:47891 + Keep-Alive)
gpool dashboard               # Mở Web Dashboard (http://127.0.0.1:47891)
gpool menubar start           # Build & bật Menu Bar macOS
gpool launchagent install     # Tự chạy daemon khi khởi động macOS
```

### 4. Kết nối AI Agents qua MCP (`gpool mcp`)

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

## Hai chế độ Profile: `linked` vs `isolated`

| Chế độ | Cách hoạt động | Phù hợp khi |
| :--- | :--- | :--- |
| **`linked`** (mặc định khi import từ Chrome) | Dùng chung `--profile-directory` của Chrome gốc kèm `?authuser=` / `login_hint=` | Dùng ngay 5–15 acc đang mở sẵn không cần login lại |
| **`isolated`** | Mỗi tài khoản 1 `--user-data-dir` riêng dưới `~/.google-one-pool/chrome-profiles/` | Chạy đường dài ổn định, Keep-Alive quét ngầm độc lập (`gpool isolate --all && gpool login-wizard`) |

## Chạy kiểm thử

```bash
npm test
```
