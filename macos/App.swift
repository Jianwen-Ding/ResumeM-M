import AppKit
import WebKit

struct Configuration: Decodable {
    let node: String
    let path: String
    let dataDir: String
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var process: Process?
    private var input: Pipe?
    private var log: FileHandle?
    private var config: Configuration!
    private var quitting = false
    private var connected = false
    private let baseURL = URL(string: "http://127.0.0.1:4600")!
    private let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/ResumeM-M/server.log")

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let webConfig = WKWebViewConfiguration()
        webConfig.userContentController.add(self, name: "chooseProjectFolder")
        webView = WKWebView(frame: .zero, configuration: webConfig)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1380, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "ResumeM-M"
        window.minSize = NSSize(width: 1000, height: 650)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("ResumeM-M Main Window")
        showWindow()
        webView.loadHTMLString("<html><body style='font:16px -apple-system;background:#f8f9fa;color:#5f6368;display:grid;place-items:center;height:90vh'>Opening your resume workspace…</body></html>", baseURL: nil)
        do {
            let url = Bundle.main.resourceURL!.appendingPathComponent("configuration.json")
            config = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: url))
            probe { [weak self] result in
                guard let self = self else { return }
                switch result {
                case .ready: self.loadWorkspace()
                case .unavailable: self.startServer()
                case .conflict: self.fail("Port 4600 is already used by another app or a different save. Quit that server and reopen ResumeM-M.")
                }
            }
        } catch { fail(error.localizedDescription) }
    }

    private enum Health { case ready, unavailable, conflict }
    private func probe(_ completion: @escaping (Health) -> Void) {
        var request = URLRequest(url: baseURL.appendingPathComponent("health"))
        request.timeoutInterval = 1
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { data, response, error in
            var result = Health.unavailable
            if error == nil, let response = response as? HTTPURLResponse {
                result = .conflict
                if response.statusCode == 200, let data = data,
                   let health = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   health["service"] as? String == "resumem-m", health["ok"] as? Bool == true {
                    if health["projectOpen"] as? Bool == false {
                        result = .ready
                    } else if let dataDir = health["dataDir"] as? String,
                              URL(fileURLWithPath: dataDir).resolvingSymlinksInPath() == URL(fileURLWithPath: self.projectDirectory).resolvingSymlinksInPath() {
                        result = .ready
                    }
                }
            }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    private func startServer() {
        do {
            guard FileManager.default.isExecutableFile(atPath: config.node) else {
                fail("Node.js could not be found at \(config.node). Reinstall Node.js, then run npm run mac:install from the ResumeM-M project.")
                return
            }
            let runtime = Bundle.main.resourceURL!.appendingPathComponent("server")
            let child = Process()
            child.executableURL = URL(fileURLWithPath: config.node)
            child.arguments = [runtime.appendingPathComponent("bootstrap.mjs").path]
            child.currentDirectoryURL = runtime
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = config.path
            environment["RMM_DATA"] = projectDirectory
            environment["PORT"] = "4600"
            child.environment = environment
            try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil)
            }
            log = try FileHandle(forWritingTo: logURL)
            log?.seekToEndOfFile()
            child.standardOutput = log
            child.standardError = log
            input = Pipe()
            child.standardInput = input
            child.terminationHandler = { [weak self] child in
                DispatchQueue.main.async {
                    guard let self = self, !self.quitting else { return }
                    self.fail("The local server stopped (exit \(child.terminationStatus)). See \(self.logURL.path) for details.")
                }
            }
            process = child
            try child.run()
            awaitServer(until: Date().addingTimeInterval(30))
        } catch { fail(error.localizedDescription) }
    }

    private func awaitServer(until deadline: Date) {
        guard !quitting, !connected else { return }
        probe { [weak self] health in
            guard let self = self, !self.quitting else { return }
            switch health {
            case .ready: self.loadWorkspace()
            case .conflict: self.fail("Another service is using port 4600. Quit that service and reopen ResumeM-M.")
            case .unavailable:
                if Date() >= deadline { self.fail("The server did not start within 30 seconds. See \(self.logURL.path) for details.") }
                else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.awaitServer(until: deadline) } }
            }
        }
    }

    private func loadWorkspace() {
        connected = true
        webView.load(URLRequest(url: baseURL))
    }

    private func fail(_ message: String) {
        guard !quitting else { return }
        quitting = true
        let alert = NSAlert()
        alert.messageText = "ResumeM-M couldn’t open"
        alert.informativeText = message
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        // Only stop a server we started. A pre-existing CLI server belongs to
        // its terminal session and must survive quitting this window.
        try? input?.fileHandleForWriting.close()
        if let process = process, process.isRunning { process.terminate() }
        try? log?.close()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    @objc private func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc private func reload() { if connected { webView.reload() } }
    @objc private func openBrowser() { if connected { NSWorkspace.shared.open(baseURL) } }
    private var projectDirectory: String {
        let prefs = ProcessInfo.processInfo.environment["RMM_PROJECTS_FILE"] ??
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".resumem-m/projects.json").path
        if let data = FileManager.default.contents(atPath: prefs),
           let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let selected = value["defaultFolder"] as? String { return selected }
            if let active = value["active"] as? String { return active }
        }
        return config.dataDir
    }
    @objc private func openStore() {
        URLSession.shared.dataTask(with: baseURL.appendingPathComponent("health")) { data, _, _ in
            guard let data = data, let health = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let dir = health["dataDir"] as? String else { return }
            DispatchQueue.main.async { NSWorkspace.shared.open(URL(fileURLWithPath: dir)) }
        }.resume()
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "chooseProjectFolder", message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url, isLocal(url) else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose Save Folder"
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let path = panel.url?.path,
                  let data = try? JSONSerialization.data(withJSONObject: [path]),
                  let json = String(data: data, encoding: .utf8) else { return }
            self.webView.evaluateJavaScript("window.rmmFolderChosen(\(json)[0])", completionHandler: nil)
        }
    }

    private func buildMenu() {
        let menu = NSMenu()
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem()
            item.title = title
            let child = NSMenu(title: title)
            item.submenu = child
            menu.addItem(item)
            return child
        }
        func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String = "", target: AnyObject? = nil) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.target = target
            menu.addItem(item)
        }
        let appMenu = submenu("ResumeM-M")
        add(appMenu, "About ResumeM-M", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), target: NSApp)
        appMenu.addItem(.separator())
        add(appMenu, "Hide ResumeM-M", #selector(NSApplication.hide(_:)), "h", target: NSApp)
        appMenu.addItem(.separator())
        add(appMenu, "Quit ResumeM-M", #selector(NSApplication.terminate(_:)), "q", target: NSApp)
        let file = submenu("File")
        add(file, "Show Save Folder", #selector(openStore), target: self)
        add(file, "Open in Browser", #selector(openBrowser), target: self)
        file.addItem(.separator())
        add(file, "Close Window", #selector(NSWindow.performClose(_:)), "w")
        let edit = submenu("Edit")
        for (title, selector, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            add(edit, title, NSSelectorFromString(selector), key)
        }
        let view = submenu("View")
        add(view, "Reload", #selector(reload), "r", target: self)
        let windows = submenu("Window")
        add(windows, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
        add(windows, "Show ResumeM-M", #selector(showWindow), target: self)
        NSApp.windowsMenu = windows
        NSApp.mainMenu = menu
    }

    private func isLocal(_ url: URL) -> Bool {
        url.scheme == baseURL.scheme && url.host == baseURL.host && url.port == baseURL.port
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if !isLocal(url) && url.scheme != "blob" {
            if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        } else if action.shouldPerformDownload { decisionHandler(.download) }
        else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, isLocal(url) { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { result in completionHandler(result == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
