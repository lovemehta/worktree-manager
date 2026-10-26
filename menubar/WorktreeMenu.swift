// WorktreeMenu: macOS menu bar switcher for repos/worktrees. Talks to the local Worktree Manager server.
import AppKit
import Foundation
import Carbon.HIToolbox
import ApplicationServices

let serverURL = URL(string: ProcessInfo.processInfo.environment["WM_URL"] ?? "http://127.0.0.1:7777")!
let intellijApp = ProcessInfo.processInfo.environment["INTELLIJ_APP"] ?? "IntelliJ IDEA"   // app name passed to `open -a` when the server is down

struct Worktree: Decodable { let path: String; let branch: String?; let head: String?; let detached: Bool; let exists: Bool?; let lastActivity: Double? }
struct Snip: Decodable { let role: String; let before: String; let match: String; let after: String }
struct ChatHit: Decodable { let sessionId: String; let cwd: String?; let openPath: String?; let label: String; let sub: String?; let exists: Bool; let branch: String?; let title: String; let mtime: Double; let hits: Int; let snippets: [Snip] }
struct SearchResult: Decodable { let total: Int; let sessions: [ChatHit]; let truncated: Bool }
func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

struct Repo: Decodable { let name: String; let path: String; let branch: String?; let worktrees: [Worktree]?; let error: String?; let lastActivity: Double?; let mainLastActivity: Double? }

func ago(_ ms: Double?) -> String? {
    guard let ms = ms, ms > 0 else { return nil }
    let m = Int((Date().timeIntervalSince1970 * 1000 - ms) / 60000)
    if m < 60 { return m <= 1 ? "now" : "\(m)m" }
    if m < 48 * 60 { return "\(m / 60)h" }
    return "\(m / 1440)d"
}


// MARK: - Spotlight-style switcher (⌘⇧Space)

struct Entry { let title: String; let subtitle: String; let path: String?; let repo: Repo?; let haystack: String; let last: Double; var create: String? = nil; var url: URL? = nil; var resume: String? = nil; var search = false }

final class KeyPanel: NSPanel { override var canBecomeKey: Bool { true } }

final class PaletteController: NSObject, NSTextFieldDelegate, NSTableViewDataSource, NSTableViewDelegate, NSWindowDelegate {
    private let panel: KeyPanel
    private let field = NSTextField()
    private let crumb = NSTextField(labelWithString: "")
    private let hint = NSTextField(labelWithString: "")
    private let table = NSTableView()
    private var repos: [Repo] = []
    private var current: Repo?          // nil = repo list, non-nil = that repo's worktrees
    private var creating = false        // true = typing a branch name for a new worktree in `current`
    private var searching = false       // true = chat search mode (type "?" in the repo list)
    private var chatRows: [Entry] = []
    private var chatStatus = ""
    private var searchWork: DispatchWorkItem?
    private var searchTask: URLSessionDataTask?
    private var busy = false
    private var rows: [Entry] = []
    private let onOpen: (String) -> Void
    private let onShow: () -> Void

    init(onShow: @escaping () -> Void, onOpen: @escaping (String) -> Void) {
        self.onOpen = onOpen; self.onShow = onShow
        panel = KeyPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 420), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.delegate = self

        let bg = NSVisualEffectView(frame: panel.contentView!.bounds)
        bg.autoresizingMask = [.width, .height]
        bg.material = .popover; bg.blendingMode = .behindWindow; bg.state = .active
        bg.wantsLayer = true; bg.layer?.cornerRadius = 14; bg.layer?.masksToBounds = true
        panel.contentView = bg

        crumb.frame = NSRect(x: 18, y: 420 - 50, width: 0, height: 28)
        crumb.font = NSFont.systemFont(ofSize: 20, weight: .semibold); crumb.textColor = .secondaryLabelColor
        crumb.autoresizingMask = [.minYMargin]
        bg.addSubview(crumb)

        field.frame = NSRect(x: 18, y: 420 - 58, width: 640 - 36, height: 40)
        field.autoresizingMask = [.width, .minYMargin]
        field.isBordered = false; field.drawsBackground = false; field.focusRingType = .none
        field.font = NSFont.systemFont(ofSize: 24, weight: .light)
        field.delegate = self
        bg.addSubview(field)

        let sep = NSBox(frame: NSRect(x: 0, y: 420 - 66, width: 640, height: 1)); sep.boxType = .separator; sep.autoresizingMask = [.width, .minYMargin]
        bg.addSubview(sep)

        hint.frame = NSRect(x: 18, y: 6, width: 604, height: 16); hint.autoresizingMask = [.width]
        hint.font = NSFont.systemFont(ofSize: 11); hint.textColor = .tertiaryLabelColor; hint.alignment = .right
        bg.addSubview(hint)

        let scroll = NSScrollView(frame: NSRect(x: 0, y: 24, width: 640, height: 420 - 92))
        scroll.autoresizingMask = [.width, .height]
        scroll.drawsBackground = false; scroll.hasVerticalScroller = true
        let col = NSTableColumn(identifier: .init("c")); col.width = 640
        table.addTableColumn(col); table.headerView = nil; table.rowHeight = 44
        table.backgroundColor = .clear; table.selectionHighlightStyle = .regular
        table.dataSource = self; table.delegate = self
        table.target = self; table.action = #selector(rowClicked)
        scroll.documentView = table
        bg.addSubview(scroll)
    }

    var isVisible: Bool { panel.isVisible }

    func setRepos(_ repos: [Repo]) {
        self.repos = repos
        if let c = current { current = repos.first { $0.path == c.path } }
        applyFilter()
    }

    func toggle() { if panel.isVisible { hide() } else { show() } }

    func show() {
        onShow()
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: f.midX - 320, y: f.midY + f.height * 0.12))
        }
        current = nil; creating = false; searching = false; chatRows = []; chatStatus = ""; busy = false; field.stringValue = ""; applyFilter()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
    }

    func hide() { panel.orderOut(nil) }
    func windowDidResignKey(_ n: Notification) { hide() }

    private func enter(_ repo: Repo) { current = repo; creating = false; field.stringValue = ""; applyFilter(); panel.makeFirstResponder(field) }
    private func enterCreate(prefill: String) { creating = true; field.stringValue = prefill; applyFilter(); panel.makeFirstResponder(field); field.currentEditor()?.selectedRange = NSRange(location: prefill.count, length: 0) }
    private func enterSearch(prefill: String) { searching = true; current = nil; creating = false; chatRows = []; chatStatus = ""; field.stringValue = prefill; applyFilter(); panel.makeFirstResponder(field); field.currentEditor()?.selectedRange = NSRange(location: prefill.count, length: 0) }
    private func back() {
        if searching { searching = false; chatRows = []; searchWork?.cancel(); searchTask?.cancel() }
        else if creating { creating = false } else { current = nil }
        field.stringValue = ""; applyFilter(); panel.makeFirstResponder(field)
    }

    private func createWorktree(branch: String) {
        guard let repo = current, !busy else { return }
        let b = branch.trimmingCharacters(in: .whitespaces)
        guard !b.isEmpty else { return }
        busy = true; hint.stringValue = "Creating \(repo.name)-\(b.replacingOccurrences(of: "/", with: "-"))… (git fetch + worktree add)"; hint.textColor = .secondaryLabelColor
        var req = URLRequest(url: serverURL.appendingPathComponent("api/worktree/create"))
        req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.timeoutInterval = 120
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["repo": repo.name, "branch": b, "fetch": true])
        URLSession.shared.dataTask(with: req) { data, resp, err in
            DispatchQueue.main.async {
                self.busy = false
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                if code == 200, let path = json?["path"] as? String {
                    self.hide(); self.onOpen(path); self.onShow()
                } else {
                    self.hint.stringValue = "Error: " + ((json?["error"] as? String) ?? err?.localizedDescription ?? "HTTP \(code)")
                    self.hint.textColor = .systemRed
                }
            }
        }.resume()
    }

    // Debounced call to /api/search; results land in chatRows.
    private func scheduleSearch() {
        searchWork?.cancel(); searchTask?.cancel()
        let q = field.stringValue.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else { chatRows = []; chatStatus = "Type at least 2 characters"; reloadRows(); return }
        chatStatus = "Searching…"; reloadRows()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            var comps = URLComponents(url: serverURL.appendingPathComponent("api/search"), resolvingAgainstBaseURL: false)!
            comps.queryItems = [URLQueryItem(name: "q", value: q)]
            var req = URLRequest(url: comps.url!); req.timeoutInterval = 20
            self.searchTask = URLSession.shared.dataTask(with: req) { data, resp, err in
                DispatchQueue.main.async {
                    guard self.searching, self.field.stringValue.trimmingCharacters(in: .whitespaces) == q else { return }
                    guard let data = data, let res = try? JSONDecoder().decode(SearchResult.self, from: data) else {
                        self.chatRows = []; self.chatStatus = "Error: " + (err?.localizedDescription ?? "HTTP \((resp as? HTTPURLResponse)?.statusCode ?? 0)"); self.reloadRows(); return
                    }
                    self.chatRows = res.sessions.map { h in
                        let when = ago(h.mtime) ?? ""
                        let snip = h.snippets.first.map { sn in
                            let who = sn.role == "assistant" ? "Claude" : sn.role == "user" ? "You" : "Tool"
                            return "\(who): " + (sn.before + sn.match + sn.after).replacingOccurrences(of: "\n", with: " ") } ?? ""
                        let whereStr = [h.label + (h.sub.map { "/" + $0 } ?? ""), h.branch, when, h.exists ? nil : "folder gone"].compactMap { $0 }.joined(separator: " · ")
                        let cmd = "cd " + shellQuote(h.cwd ?? h.openPath ?? "") + " && claude --resume " + h.sessionId
                        return Entry(title: h.title, subtitle: whereStr + (snip.isEmpty ? "" : "  —  " + snip), path: h.exists ? h.openPath : nil, repo: nil, haystack: "", last: h.mtime, resume: cmd)
                    }
                    self.chatStatus = res.sessions.isEmpty ? "No chats contain “\(q)”" : "\(res.total) chat\(res.total == 1 ? "" : "s")" + (res.total > res.sessions.count ? ", newest \(res.sessions.count)" : "") + (res.truncated ? " · capped, narrow the search" : "")
                    self.reloadRows()
                }
            }
            self.searchTask?.resume()
        }
        searchWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }
    private func reloadRows() {
        rows = chatRows
        hint.stringValue = chatStatus.isEmpty ? "↩ open in IntelliJ + copy resume command   ⌘↩ copy only   ⇥ back to repos   esc close" : chatStatus + "   ·   ↩ open + copy resume   ⌘↩ copy only   ⇥ back"
        hint.textColor = chatStatus.hasPrefix("Error") ? .systemRed : .tertiaryLabelColor
        table.reloadData()
        if !rows.isEmpty { table.selectRowIndexes([0], byExtendingSelection: false); table.scrollRowToVisible(0) }
    }

    private func layoutHeader() {
        if searching {
            crumb.stringValue = "Chats ›"; crumb.sizeToFit()
            crumb.frame.origin.y = 420 - 52; crumb.isHidden = false
            field.frame = NSRect(x: 18 + crumb.frame.width + 8, y: 420 - 58, width: 640 - 36 - crumb.frame.width - 8, height: 40)
            field.placeholderString = "search all Claude chats…"
        } else if let r = current, creating {
            crumb.stringValue = r.name + " › new worktree ›"; crumb.sizeToFit()
            crumb.frame.origin.y = 420 - 52; crumb.isHidden = false
            field.frame = NSRect(x: 18 + crumb.frame.width + 8, y: 420 - 58, width: 640 - 36 - crumb.frame.width - 8, height: 40)
            field.placeholderString = "branch name"
            hint.stringValue = "↩ create & open in IntelliJ   ⌫ (empty) back   esc close"; hint.textColor = .tertiaryLabelColor
        } else if let r = current {
            crumb.stringValue = r.name + " ›"; crumb.sizeToFit()
            crumb.frame.origin.y = 420 - 52; crumb.isHidden = false
            field.frame = NSRect(x: 18 + crumb.frame.width + 8, y: 420 - 58, width: 640 - 36 - crumb.frame.width - 8, height: 40)
            field.placeholderString = "Worktree…"
            hint.stringValue = "↩ open in IntelliJ   ⌫ / ← back   ⇥ search chats   esc close"; hint.textColor = .tertiaryLabelColor
        } else {
            crumb.isHidden = true
            field.frame = NSRect(x: 18, y: 420 - 58, width: 640 - 36, height: 40)
            field.placeholderString = "Repo…"
            hint.stringValue = "↩ / → worktrees   ⌘↩ open main   ⇥ search chats   esc close"; hint.textColor = .tertiaryLabelColor
        }
    }

    private func applyFilter() {
        if !searching, current == nil, field.stringValue.hasPrefix("?") { enterSearch(prefill: String(field.stringValue.dropFirst())); return }
        layoutHeader()
        if searching { scheduleSearch(); return }
        let q = field.stringValue.lowercased().split(separator: " ").map(String.init)
        var out: [Entry] = []
        if let r = current, creating {
            let b = field.stringValue.trimmingCharacters(in: .whitespaces)
            let base = r.branch.map { "from origin/HEAD (currently on \($0))" } ?? "from origin/HEAD"
            out.append(Entry(title: b.isEmpty ? "Type a branch name" : "Create \(r.name)-\(b.replacingOccurrences(of: "/", with: "-"))",
                             subtitle: b.isEmpty ? "e.g. feat/trx-1234-short-name" : "branch \(b) · \(base) · reuses the branch if it already exists",
                             path: nil, repo: nil, haystack: "", last: 0, create: b))
            rows = out; table.reloadData(); table.selectRowIndexes([0], byExtendingSelection: false); return
        }
        if let r = current {
            out.append(Entry(title: "main", subtitle: [r.branch, ago(r.mainLastActivity).map { "last chat \($0)" }].compactMap { $0 }.joined(separator: " · "),
                             path: r.path, repo: nil, haystack: "main \(r.branch ?? "")", last: r.mainLastActivity ?? 0))
            for w in r.worktrees ?? [] where w.exists != false {
                let b = w.branch ?? "detached @ \(w.head ?? "?")"
                out.append(Entry(title: b, subtitle: [(w.path as NSString).lastPathComponent, ago(w.lastActivity).map { "last chat \($0)" }].compactMap { $0 }.joined(separator: " · "),
                                 path: w.path, repo: nil, haystack: "\(b) \(w.path)", last: w.lastActivity ?? 0))
            }
        } else {
            for r in repos {
                let n = (r.worktrees ?? []).count
                let sub = [n > 0 ? "\(n) worktree\(n == 1 ? "" : "s")" : "no worktrees", r.branch, ago(r.lastActivity).map { "last chat \($0)" }].compactMap { $0 }.joined(separator: " · ")
                let hay = ([r.name, r.branch ?? ""] + (r.worktrees ?? []).map { $0.branch ?? "" }).joined(separator: " ")
                out.append(Entry(title: r.name, subtitle: sub, path: nil, repo: r, haystack: hay, last: r.lastActivity ?? 0))
            }
        }
        if current == nil {
            out.append(Entry(title: "Search Claude chats…", subtitle: "find which repo or worktree you discussed something in · ⇥ or type ? first", path: nil, repo: nil,
                             haystack: "search chats claude find", last: -2, search: true))
            out.append(Entry(title: "Open Worktree Manager", subtitle: "\(serverURL.absoluteString) · create, delete, migrate Claude chats", path: nil, repo: nil,
                             haystack: "open worktree manager web browser ui", last: -2, url: serverURL))
        }
        rows = q.isEmpty ? out : out.filter { e in let h = e.haystack.lowercased(); return q.allSatisfy { h.contains($0) } }
        if let r = current {
            let typed = field.stringValue.trimmingCharacters(in: .whitespaces)
            if !typed.isEmpty && rows.isEmpty {
                rows.append(Entry(title: "＋ Create worktree \"\(typed)\"", subtitle: "new branch in \(r.name)", path: nil, repo: nil, haystack: "", last: -1, create: typed))
            } else {
                rows.append(Entry(title: "＋ New worktree…", subtitle: "create a branch and open it in IntelliJ", path: nil, repo: nil, haystack: "", last: -1, create: ""))
            }
        }
        if let first = q.first { rows.sort { a, b in
            let pa = a.title.lowercased().hasPrefix(first), pb = b.title.lowercased().hasPrefix(first)
            return pa != pb ? pa : a.last > b.last } }
        rows.sort { ($0.create == nil && $0.url == nil && !$0.search ? 0 : 1) < ($1.create == nil && $1.url == nil && !$1.search ? 0 : 1) }
        if q.isEmpty && current == nil, rows.count > 42 { rows = Array(rows.prefix(40)) + rows.suffix(2) }
        table.reloadData()
        if !rows.isEmpty { table.selectRowIndexes([0], byExtendingSelection: false); table.scrollRowToVisible(0) }
    }

    private func activateSelected(openMain: Bool = false) {
        let row = table.selectedRow >= 0 ? table.selectedRow : 0
        guard row < rows.count else { return }
        let e = rows[row]
        if e.search { enterSearch(prefill: ""); return }
        if let cmd = e.resume {
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(cmd, forType: .string)
            if openMain || e.path == nil { chatStatus = "Copied resume command" + (e.path == nil ? " (folder gone, migrate the chat first)" : ""); reloadRows(); return }
            hide(); onOpen(e.path!); return
        }
        if let u = e.url { hide(); NSWorkspace.shared.open(u); return }
        if let c = e.create { if creating { createWorktree(branch: c) } else { enterCreate(prefill: c) }; return }
        if let repo = e.repo { if openMain { hide(); onOpen(repo.path) } else { enter(repo) } }
        else if let p = e.path { hide(); onOpen(p) }
    }

    @objc private func rowClicked() {
        guard table.clickedRow >= 0 else { return }
        table.selectRowIndexes([table.clickedRow], byExtendingSelection: false)
        activateSelected(openMain: NSEvent.modifierFlags.contains(.command))
    }

    // NSTextFieldDelegate
    func controlTextDidChange(_ n: Notification) { applyFilter() }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        switch sel {
        case #selector(NSResponder.moveDown(_:)): move(1); return true
        case #selector(NSResponder.moveUp(_:)): move(-1); return true
        case #selector(NSResponder.moveRight(_:)):
            if current == nil, !searching, field.stringValue.isEmpty || textView.selectedRange.location >= field.stringValue.count { activateSelected(); return true }
            return false
        case #selector(NSResponder.moveLeft(_:)):
            if current != nil || searching, field.stringValue.isEmpty { back(); return true }
            return false
        case #selector(NSResponder.deleteBackward(_:)):
            if current != nil || searching, field.stringValue.isEmpty { back(); return true }
            return false
        case #selector(NSResponder.insertNewline(_:)):
            if creating { createWorktree(branch: field.stringValue) } else { activateSelected(openMain: NSEvent.modifierFlags.contains(.command)) }
            return true
        case #selector(NSResponder.insertTab(_:)), #selector(NSResponder.insertBacktab(_:)):
            guard !creating else { return true }
            let typed = field.stringValue
            if searching { back(); field.stringValue = typed; applyFilter(); field.currentEditor()?.selectedRange = NSRange(location: typed.count, length: 0) }
            else { enterSearch(prefill: typed) }
            return true
        case #selector(NSResponder.cancelOperation(_:)): hide(); return true
        default: return false
        }
    }
    private func move(_ d: Int) {
        guard !rows.isEmpty else { return }
        let r = min(max(table.selectedRow + d, 0), rows.count - 1)
        table.selectRowIndexes([r], byExtendingSelection: false); table.scrollRowToVisible(r)
    }

    // NSTableView
    func numberOfRows(in t: NSTableView) -> Int { rows.count }
    func tableView(_ t: NSTableView, viewFor c: NSTableColumn?, row: Int) -> NSView? {
        let e = rows[row]
        let cell = NSTableCellView(frame: NSRect(x: 0, y: 0, width: 640, height: 44))
        let tf = NSTextField(labelWithAttributedString: {
            let a = NSMutableAttributedString(string: e.title + "\n", attributes: [.font: NSFont.systemFont(ofSize: 15, weight: .medium), .foregroundColor: NSColor.labelColor])
            a.append(NSAttributedString(string: e.subtitle, attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor]))
            return a }())
        tf.frame = NSRect(x: 16, y: 4, width: e.repo != nil ? 580 : 608, height: 38); tf.autoresizingMask = [.width]
        tf.lineBreakMode = .byTruncatingMiddle; tf.maximumNumberOfLines = 2
        cell.addSubview(tf); cell.textField = tf
        if e.repo != nil {
            let chev = NSTextField(labelWithString: "›"); chev.font = NSFont.systemFont(ofSize: 18); chev.textColor = .tertiaryLabelColor
            chev.frame = NSRect(x: 608, y: 10, width: 20, height: 24); chev.autoresizingMask = [.minXMargin]
            cell.addSubview(chev)
        }
        return cell
    }
}

// If IntelliJ already has a window for this folder, raise it (no reopen flash). Needs Accessibility permission.
private var axPrompted = false
func raiseIntelliJWindow(forPath path: String) -> Bool {
    let name = (path as NSString).lastPathComponent
    let apps = ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"].flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0) }
    guard let app = apps.first else { return false }
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: !axPrompted] as CFDictionary
    axPrompted = true
    guard AXIsProcessTrustedWithOptions(opts) else { NSLog("WorktreeMenu: no Accessibility permission, falling back to open"); return false }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var winsRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winsRef) == .success, let wins = winsRef as? [AXUIElement] else { return false }
    for w in wins {
        var t: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t) == .success, let title = t as? String else { continue }
        // IntelliJ titles look like "<project> – <file>" or "<project> [branch]".
        if title == name || title.hasPrefix(name + " ") {
            AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            AXUIElementPerformAction(w, kAXRaiseAction as CFString)
            if #available(macOS 14, *) { app.activate(from: .current, options: []) } else { app.activate(options: [.activateIgnoringOtherApps]) }
            NSLog("WorktreeMenu: raised IntelliJ window '%@'", title)
            return true
        }
    }
    return false
}

// Global hotkey via Carbon (no Accessibility permission needed).
private var hotKeyRef: EventHotKeyRef?
private var hotKeyAction: (() -> Void)?
func registerHotKey(keyCode: UInt32, modifiers: UInt32, action: @escaping () -> Void) -> Bool {
    hotKeyAction = action
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in DispatchQueue.main.async { hotKeyAction?() }; return noErr }, 1, &spec, nil, nil)
    let id = EventHotKeyID(signature: 0x574B5452, id: 1)
    return RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &hotKeyRef) == noErr
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private var repos: [Repo] = []
    private var lastError: String?
    private var loading = false
    private var palette: PaletteController!
    private var hotkeyOK = false
    private var sigSource: DispatchSourceSignal?
    private var recents: [String] { get { UserDefaults.standard.stringArray(forKey: "recents") ?? [] } set { UserDefaults.standard.set(newValue, forKey: "recents") } }

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let img = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: "Worktrees") { statusItem.button?.image = img } else { statusItem.button?.title = "⎇" }
        menu.delegate = self
        statusItem.menu = menu
        palette = PaletteController(onShow: { [weak self] in self?.refresh() }, onOpen: { [weak self] p in self?.open(path: p) })
        hotkeyOK = registerHotKey(keyCode: UInt32(kVK_Space), modifiers: UInt32(cmdKey | shiftKey)) { [weak self] in self?.palette.toggle() }
        NSLog("WorktreeMenu: hotkey ⌘⇧Space registered=%@", hotkeyOK ? "yes" : "NO")
        // `pkill -USR1 WorktreeMenu` toggles the switcher too (handy for scripts / other launchers).
        signal(SIGUSR1, SIG_IGN)
        sigSource = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        sigSource?.setEventHandler { [weak self] in self?.palette.toggle() }
        sigSource?.resume()
        rebuild()
        refresh()
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in self.refresh() }
    }

    func menuWillOpen(_ menu: NSMenu) { refresh() }

    private func refresh() {
        if loading { return }
        loading = true
        var req = URLRequest(url: serverURL.appendingPathComponent("api/repos")); req.timeoutInterval = 8
        URLSession.shared.dataTask(with: req) { data, _, err in
            DispatchQueue.main.async {
                self.loading = false
                if let data = data, let list = try? JSONDecoder().decode([Repo].self, from: data) { self.repos = list; self.lastError = nil; self.palette.setRepos(list) }
                else { self.lastError = err?.localizedDescription ?? "Bad response from server" }
                self.rebuild()
            }
        }.resume()
    }

    private func action(_ title: String, _ sel: Selector, _ key: String = "") -> NSMenuItem {
        let it = NSMenuItem(title: title, action: sel, keyEquivalent: key); it.target = self; return it
    }

    private func item(_ title: String, _ path: String, _ sub: String? = nil) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: #selector(openPath(_:)), keyEquivalent: "")
        it.target = self; it.representedObject = path; it.toolTip = path
        if let sub = sub {
            let a = NSMutableAttributedString(string: title, attributes: [.font: NSFont.menuFont(ofSize: 0)])
            a.append(NSAttributedString(string: "  " + sub, attributes: [.font: NSFont.menuFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor]))
            it.attributedTitle = a
        }
        return it
    }

    private func repoItem(_ r: Repo) -> NSMenuItem {
        let top = NSMenuItem(title: r.name, action: nil, keyEquivalent: "")
        let sub = NSMenu()
        sub.addItem(item("Open main", r.path, [r.branch, ago(r.mainLastActivity)].compactMap { $0 }.joined(separator: " · ")))
        if let wts = r.worktrees, !wts.isEmpty {
            sub.addItem(.separator())
            for w in wts {
                let it = item(w.branch ?? "detached @ \(w.head ?? "?")", w.path, ago(w.lastActivity))
                if w.exists == false { it.isEnabled = false }
                sub.addItem(it)
            }
        }
        sub.addItem(.separator())
        sub.addItem(action("Manage in browser…", #selector(openUI)))
        top.submenu = sub
        let n = (r.worktrees ?? []).count
        var tail: [String] = []; if n > 0 { tail.append("\(n) wt") }; if let a = ago(r.lastActivity) { tail.append(a) }
        if !tail.isEmpty {
            let a = NSMutableAttributedString(string: r.name, attributes: [.font: NSFont.menuFont(ofSize: 0)])
            a.append(NSAttributedString(string: "  " + tail.joined(separator: " · "), attributes: [.font: NSFont.menuFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor]))
            top.attributedTitle = a
        }
        return top
    }

    private func rebuild() {
        menu.removeAllItems()
        if let e = lastError {
            let it = NSMenuItem(title: "Server unreachable: \(e)", action: nil, keyEquivalent: ""); it.isEnabled = false; menu.addItem(it)
            menu.addItem(action("Start server (launchctl kickstart)", #selector(startServer)))
            menu.addItem(.separator())
        }
        let byPath = Dictionary(uniqueKeysWithValues: repos.flatMap { r in [(r.path, (r.name, r.branch ?? "main", true))] + (r.worktrees ?? []).map { ($0.path, (r.name, $0.branch ?? "detached", false)) } })
        let recent = recents.filter { byPath[$0] != nil }
        if !recent.isEmpty {
            let h = NSMenuItem(title: "Recent", action: nil, keyEquivalent: ""); h.isEnabled = false; menu.addItem(h)
            for p in recent { let (repo, branch, isMain) = byPath[p]!; menu.addItem(item("\(repo)\(isMain ? "" : " › " + branch)", p, isMain ? branch : nil)) }
            menu.addItem(.separator())
        }
        let topN = 5
        for r in repos.prefix(topN) { menu.addItem(repoItem(r)) }
        if repos.count > topN {
            let more = NSMenuItem(title: "More repos (\(repos.count - topN))", action: nil, keyEquivalent: "")
            let moreMenu = NSMenu()
            for r in repos.dropFirst(topN) { moreMenu.addItem(repoItem(r)) }
            more.submenu = moreMenu
            menu.addItem(more)
        }
        menu.addItem(.separator())
        let sw = action("Switcher", #selector(showPalette)); sw.keyEquivalent = " "; sw.keyEquivalentModifierMask = [.command, .shift]
        if !hotkeyOK { sw.title = "Switcher (⌘⇧Space taken by another app)" }
        menu.addItem(sw)
        menu.addItem(action("Open Worktree Manager", #selector(openUI), "o"))
        menu.addItem(action("Refresh", #selector(doRefresh), "r"))
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    @objc private func openPath(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        open(path: path)
    }
    @objc private func showPalette() { palette.show() }

    private func noteRecent(_ path: String) {
        var rec = recents.filter { $0 != path }; rec.insert(path, at: 0); recents = Array(rec.prefix(6))
    }

    private func open(path: String) {
        noteRecent(path)
        if raiseIntelliJWindow(forPath: path) { return }   // already open: just switch to it
        var req = URLRequest(url: serverURL.appendingPathComponent("api/worktree/open"))
        req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["path": path])
        URLSession.shared.dataTask(with: req) { data, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if err != nil || code != 200 {
                // Fallback: open directly without the server.
                let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/open"); p.arguments = ["-a", intellijApp + ".app", path]; try? p.run()
            }
        }.resume()
    }
    @objc private func openUI() { NSWorkspace.shared.open(serverURL) }
    @objc private func doRefresh() { refresh() }
    @objc private func startServer() {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["kickstart", "-k", "gui/\(getuid())/com.flatpay.worktree-manager"]; try? p.run(); p.waitUntilExit()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.refresh() }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
