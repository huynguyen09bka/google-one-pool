import Cocoa

struct AgySessionDTO: Codable, Sendable {
    let captured: Bool
    let captured_at: String?
    let detected_email: String?
    let is_live_owner: Bool
    let active_alias: String?
}

struct AccountDTO: Codable, Sendable {
    let id: Int
    let alias: String
    let email: String
    let display_name: String
    let plan_tier: String
    let session_status: String
    let effective_state: String
    let is_active: Bool
    let cooldown_remaining_ms: Int
    let agy_session: AgySessionDTO?
}

struct SummaryDTO: Codable, Sendable {
    let total: Int
    let ready: Int
    let cooldown: Int
    let needs_login: Int
    let unknown: Int?
    let error: Int?
}

struct SettingsDTO: Codable, Sendable {
    let default_cooldown_hours: Double?
    let language: String?
}

struct AgyStatusDTO: Codable, Sendable {
    let keychain_present: Bool
    let live_owner_alias: String?
    let live_unknown: Bool
    let live_email: String?
    let marker_alias: String?
}

struct AccountsResponseDTO: Codable, Sendable {
    let accounts: [AccountDTO]
    let activeAlias: String?
    let summary: SummaryDTO
    let settings: SettingsDTO?
    let agyStatus: AgyStatusDTO?
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private var refreshTimer: Timer?

    private var accounts: [AccountDTO] = []
    private var activeAlias: String?
    private var summary: SummaryDTO?
    private var settings: SettingsDTO?
    private var agyStatus: AgyStatusDTO?
    private var daemonOnline = false
    private var statusMessage: String?

    private let port: Int = {
        if let raw = ProcessInfo.processInfo.environment["GPOOL_PORT"],
           let parsed = Int(raw), parsed > 0, parsed <= 65535 {
            return parsed
        }
        return 47891
    }()

    private var baseURL: URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }

    private func readDaemonToken() -> String? {
        let homeDir: String
        if let customHome = ProcessInfo.processInfo.environment["GPOOL_HOME"], !customHome.isEmpty {
            homeDir = (customHome as NSString).expandingTildeInPath
        } else {
            homeDir = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".google-one-pool")
                .path
        }
        let tokenURL = URL(fileURLWithPath: homeDir).appendingPathComponent("daemon.token")
        guard let raw = try? String(contentsOf: tokenURL, encoding: .utf8) else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "G1P"
        statusItem.button?.toolTip = "Google One Pool"

        menu.delegate = self
        statusItem.menu = menu

        rebuildMenu()
        Task {
            await refreshFromDaemon()
        }

        refreshTimer = Timer.scheduledTimer(withTimeInterval: 15.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.refreshFromDaemon()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    func menuWillOpen(_ menu: NSMenu) {
        Task {
            await refreshFromDaemon()
        }
    }

    private func refreshFromDaemon() async {
        let url = baseURL.appendingPathComponent("api/accounts")
        var req = URLRequest(url: url)
        req.timeoutInterval = 3.0
        if let token = readDaemonToken() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                markOffline()
                return
            }
            let decoded = try JSONDecoder().decode(AccountsResponseDTO.self, from: data)
            self.accounts = decoded.accounts
            self.activeAlias = decoded.activeAlias
            self.summary = decoded.summary
            self.settings = decoded.settings
            self.agyStatus = decoded.agyStatus
            self.daemonOnline = true
            self.statusMessage = nil
        } catch {
            markOffline()
        }

        updateStatusButtonTitle()
        rebuildMenu()
    }

    private func markOffline() {
        self.daemonOnline = false
        self.statusMessage = "Daemon chưa chạy tại 127.0.0.1:\(port)"
    }

    private func updateStatusButtonTitle() {
        guard daemonOnline else {
            statusItem.button?.title = "G1P (off)"
            return
        }
        let needsAttention = (summary?.needs_login ?? 0) > 0 || (summary?.error ?? 0) > 0
        if let active = activeAlias, !active.isEmpty {
            let shortName = active.count > 16 ? String(active.prefix(15)) + "…" : active
            statusItem.button?.title = needsAttention ? "⚠️ \(shortName)" : "⚡ \(shortName)"
        } else {
            statusItem.button?.title = needsAttention ? "⚠️ G1P" : "G1P"
        }
    }

    private func formatCooldownHours(_ hours: Double?) -> String {
        let val = hours ?? 5.0
        if val.rounded() == val {
            return "\(Int(val))h"
        }
        return String(format: "%.2gh", val)
    }

    private var isEnglish: Bool {
        if let lang = settings?.language?.lowercased() {
            return lang.hasPrefix("en")
        }
        if let envLang = ProcessInfo.processInfo.environment["GPOOL_LANG"]?.lowercased() {
            return envLang.hasPrefix("en")
        }
        return false
    }

    private func tr(_ vi: String, _ en: String) -> String {
        return isEnglish ? en : vi
    }

    private func rebuildMenu() {
        menu.removeAllItems()

        let headerTitle: String
        if daemonOnline, let s = summary {
            var parts = ["Google One Pool", "\(s.ready)/\(s.total) \(tr("sẵn sàng", "ready"))"]
            if s.cooldown > 0 { parts.append("\(s.cooldown) cooldown") }
            if s.needs_login > 0 { parts.append("\(s.needs_login) \(tr("cần login", "needs login"))") }
            if let owner = agyStatus?.live_owner_alias {
                parts.append("agy: \(owner)")
            }
            headerTitle = parts.joined(separator: " • ")
        } else {
            headerTitle = statusMessage ?? "Google One Pool • Offline"
        }
        let headerItem = NSMenuItem(title: headerTitle, action: nil, keyEquivalent: "")
        headerItem.isEnabled = false
        menu.addItem(headerItem)
        menu.addItem(.separator())

        let cdText = formatCooldownHours(settings?.default_cooldown_hours)
        let nextAgyItem = NSMenuItem(
            title: tr("Xoay nhanh agy kế tiếp (+\(cdText))", "Rotate next agy (+\(cdText))"),
            action: #selector(handleRotateNextAgy),
            keyEquivalent: "N"
        )
        nextAgyItem.target = self
        nextAgyItem.isEnabled = daemonOnline && !accounts.isEmpty
        menu.addItem(nextAgyItem)

        let nextItem = NSMenuItem(
            title: tr("Chuyển acc kế tiếp (+\(cdText) cooldown)", "Switch next account (+\(cdText) cooldown)"),
            action: #selector(handleRotateNext),
            keyEquivalent: "n"
        )
        nextItem.target = self
        nextItem.isEnabled = daemonOnline && !accounts.isEmpty
        menu.addItem(nextItem)

        let activeAcc = accounts.first { $0.alias == activeAlias }
        if let active = activeAcc {
            if let agy = active.agy_session, agy.captured {
                if agy.is_live_owner {
                    let agyDone = NSMenuItem(
                        title: tr("agy Keychain đang dùng \"\(active.alias)\"", "agy Keychain active: \"\(active.alias)\""),
                        action: nil,
                        keyEquivalent: ""
                    )
                    agyDone.isEnabled = false
                    menu.addItem(agyDone)
                } else {
                    let agyAct = NSMenuItem(
                        title: tr("Nạp phiên agy của \"\(active.alias)\" vào Keychain", "Activate agy session \"\(active.alias)\""),
                        action: #selector(handleAgyActivateActive),
                        keyEquivalent: "a"
                    )
                    agyAct.target = self
                    agyAct.isEnabled = daemonOnline
                    menu.addItem(agyAct)
                }
            } else {
                let agyCap = NSMenuItem(
                    title: tr("Lưu phiên agy hiện tại vào \"\(active.alias)\"", "Capture current agy session to \"\(active.alias)\""),
                    action: #selector(handleAgyCaptureActive),
                    keyEquivalent: "c"
                )
                agyCap.target = self
                agyCap.isEnabled = daemonOnline
                menu.addItem(agyCap)
            }
        }

        let oauthTitle = activeAlias != nil
            ? tr("Mở link OAuth từ Clipboard vào \"\(activeAlias!)\"", "Open OAuth URL from Clipboard in \"\(activeAlias!)\"")
            : tr("Mở link OAuth từ Clipboard", "Open OAuth URL from Clipboard")
        let oauthItem = NSMenuItem(
            title: oauthTitle,
            action: #selector(handleOpenOAuthFromClipboard),
            keyEquivalent: "o"
        )
        oauthItem.target = self
        oauthItem.isEnabled = daemonOnline && activeAlias != nil
        menu.addItem(oauthItem)

        menu.addItem(.separator())

        if accounts.isEmpty {
            let emptyItem = NSMenuItem(
                title: daemonOnline
                    ? tr("Chưa có tài khoản nào (mở Dashboard để thêm)", "No accounts yet (open Dashboard to add)")
                    : tr("Hãy chạy: gpool daemon start", "Run: gpool daemon start"),
                action: nil,
                keyEquivalent: ""
            )
            emptyItem.isEnabled = false
            menu.addItem(emptyItem)
        } else {
            for (index, acc) in accounts.enumerated() {
                let emoji = iconForState(acc.effective_state)
                var suffixParts: [String] = []
                if acc.is_active {
                    suffixParts.append(tr("Đang chọn", "Active"))
                } else if acc.cooldown_remaining_ms > 0 {
                    suffixParts.append("\(tr("còn", "left")) \(formatDuration(acc.cooldown_remaining_ms))")
                } else if acc.effective_state == "needs_login" {
                    suffixParts.append(tr("Cần đăng nhập", "Needs login"))
                }
                if acc.agy_session?.is_live_owner == true {
                    suffixParts.append("agy live")
                }
                let suffix = suffixParts.isEmpty ? "" : " • " + suffixParts.joined(separator: " • ")

                let key = index < 9 ? "\(index + 1)" : ""
                let title = "\(emoji) \(acc.alias) (\(acc.email))\(suffix)"
                let item = NSMenuItem(title: title, action: #selector(handleSelectAccount(_:)), keyEquivalent: key)
                item.target = self
                item.representedObject = acc.alias
                item.state = acc.is_active ? .on : .off
                menu.addItem(item)
            }
        }

        menu.addItem(.separator())

        let sweepItem = NSMenuItem(
            title: tr("Quét giữ phiên ngay (Keep-Alive)", "Run Keep-Alive Sweep Now"),
            action: #selector(handleSweep),
            keyEquivalent: "k"
        )
        sweepItem.target = self
        sweepItem.isEnabled = daemonOnline
        menu.addItem(sweepItem)

        let dashItem = NSMenuItem(
            title: tr("Mở Web Dashboard", "Open Web Dashboard"),
            action: #selector(handleOpenDashboard),
            keyEquivalent: "d"
        )
        dashItem.target = self
        menu.addItem(dashItem)

        let refreshItem = NSMenuItem(
            title: tr("Làm mới danh sách", "Refresh Accounts"),
            action: #selector(handleManualRefresh),
            keyEquivalent: "r"
        )
        refreshItem.target = self
        menu.addItem(refreshItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(
            title: tr("Thoát Menu Bar", "Quit Menu Bar"),
            action: #selector(handleQuit),
            keyEquivalent: "q"
        )
        quitItem.target = self
        menu.addItem(quitItem)
    }

    private func iconForState(_ state: String) -> String {
        switch state {
        case "active": return "⚡"
        case "ready": return "🟢"
        case "cooldown": return "⏳"
        case "needs_login": return "🔴"
        case "error": return "⚠️"
        case "checking": return "🔄"
        default: return "⚪"
        }
    }

    private func formatDuration(_ ms: Int) -> String {
        let totalMinutes = max(1, (ms + 59_999) / 60_000)
        let hours = totalMinutes / 60
        let mins = totalMinutes % 60
        if hours >= 24 {
            let days = hours / 24
            let remH = hours % 24
            return "\(days)n\(remH)g"
        }
        if hours > 0 {
            return mins > 0 ? "\(hours)g\(mins)p" : "\(hours)g"
        }
        return "\(mins)p"
    }

    @objc private func handleSelectAccount(_ sender: NSMenuItem) {
        guard let alias = sender.representedObject as? String else { return }
        let encoded = alias.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? alias
        Task {
            await postAction(path: "api/accounts/\(encoded)/switch", body: ["openChrome": true])
        }
    }

    @objc private func handleRotateNextAgy() {
        Task {
            await postAction(path: "api/pool/next", body: ["activateAgy": true, "requireAgy": true, "openChrome": false])
        }
    }

    @objc private func handleRotateNext() {
        Task {
            await postAction(path: "api/pool/next", body: ["openChrome": true])
        }
    }

    @objc private func handleAgyActivateActive() {
        guard let alias = activeAlias else { return }
        let encoded = alias.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? alias
        Task {
            await postAction(path: "api/accounts/\(encoded)/agy-activate", body: [:])
        }
    }

    @objc private func handleAgyCaptureActive() {
        guard let alias = activeAlias else { return }
        let encoded = alias.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? alias
        Task {
            await postAction(path: "api/accounts/\(encoded)/agy-capture", body: [:])
        }
    }

    @objc private func handleOpenOAuthFromClipboard() {
        guard let alias = activeAlias,
              let raw = NSPasteboard.general.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines),
              raw.hasPrefix("http://") || raw.hasPrefix("https://") else {
            NSSound.beep()
            return
        }
        let encoded = alias.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? alias
        Task {
            await postAction(path: "api/accounts/\(encoded)/oauth", body: ["oauthUrl": raw])
        }
    }

    @objc private func handleSweep() {
        Task {
            await postAction(path: "api/keepalive/sweep", body: nil)
        }
    }

    @objc private func handleOpenDashboard() {
        if let token = readDaemonToken(),
           let encoded = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
           let authURL = URL(string: "http://127.0.0.1:\(port)/auth?token=\(encoded)") {
            NSWorkspace.shared.open(authURL)
            return
        }
        NSWorkspace.shared.open(baseURL)
    }

    @objc private func handleManualRefresh() {
        Task {
            await refreshFromDaemon()
        }
    }

    @objc private func handleQuit() {
        NSApplication.shared.terminate(nil)
    }

    private func postAction(path: String, body: [String: Any]?) async {
        let url = baseURL.appendingPathComponent(path)
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 15.0
        if let token = readDaemonToken() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        _ = try? await URLSession.shared.data(for: req)
        await refreshFromDaemon()
    }
}

@main
struct GoogleOnePoolMenuApp {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
