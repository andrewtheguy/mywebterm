import Cocoa
import Foundation

class TrayDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let serverProcess: Process
    private let url: URL

    init(serverProcess: Process, url: URL) {
        self.serverProcess = serverProcess
        self.url = url
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if let button = statusItem.button {
            if let image = NSImage(systemSymbolName: "terminal", accessibilityDescription: "MyWebTerm") {
                image.isTemplate = true
                button.image = image
            } else {
                button.title = ">_"
            }
        }

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open MyWebTerm", action: #selector(openBrowser), keyEquivalent: "o"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    func applicationWillTerminate(_ notification: Notification) {
        if serverProcess.isRunning {
            serverProcess.terminate()
        }
    }

    @objc func openBrowser() {
        NSWorkspace.shared.open(url)
    }

    @objc func quitApp() {
        if serverProcess.isRunning {
            serverProcess.terminate()
        }
        NSApplication.shared.terminate(nil)
    }
}

// --- Main ---

let args = CommandLine.arguments

// Parse --port / -p from CLI args to construct URL (default 8671)
var port = 8671
if let idx = args.firstIndex(of: "--port") ?? args.firstIndex(of: "-p"), idx + 1 < args.count {
    if let p = Int(args[idx + 1]), p >= 1, p <= 65535 {
        port = p
    }
}

let urlString = "http://127.0.0.1:\(port)"
guard let url = URL(string: urlString) else {
    fputs("Invalid URL: \(urlString)\n", stderr)
    exit(1)
}

// Find the server binary next to this executable in the app bundle
let trayBin = URL(fileURLWithPath: CommandLine.arguments[0])
let serverBin = trayBin.deletingLastPathComponent().appendingPathComponent("mywebterm")

guard FileManager.default.isExecutableFile(atPath: serverBin.path) else {
    fputs("Server binary not found at: \(serverBin.path)\n", stderr)
    exit(1)
}

// Pass through all CLI args to the server binary, injecting --no-auth by default
var serverArgs = Array(args.dropFirst())
if !serverArgs.contains("--no-auth") {
    serverArgs.append("--no-auth")
}

let serverProcess = Process()
serverProcess.executableURL = serverBin
serverProcess.arguments = serverArgs

// When the server dies, exit the tray app too
serverProcess.terminationHandler = { _ in
    DispatchQueue.main.async {
        NSApplication.shared.terminate(nil)
    }
}

do {
    try serverProcess.run()
} catch {
    fputs("Failed to start server: \(error)\n", stderr)
    exit(1)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // No dock icon
let delegate = TrayDelegate(serverProcess: serverProcess, url: url)
app.delegate = delegate
app.run()
