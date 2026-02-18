import Cocoa

class TrayDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let url: URL

    init(url: URL) {
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

        // Monitor stdin — when the parent process dies the pipe closes, so we exit too.
        let stdinSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        stdinSource.setEventHandler {
            // Try reading; EOF (0 bytes) means parent is gone.
            var buf = [UInt8](repeating: 0, count: 64)
            let n = read(STDIN_FILENO, &buf, buf.count)
            if n <= 0 {
                NSApplication.shared.terminate(nil)
            }
        }
        stdinSource.setCancelHandler {}
        stdinSource.resume()
    }

    @objc func openBrowser() {
        NSWorkspace.shared.open(url)
    }

    @objc func quitApp() {
        // Signal the parent (Bun) process via stdout, then exit.
        print("quit")
        fflush(stdout)
        NSApplication.shared.terminate(nil)
    }
}

// --- Main ---

var urlString = "http://127.0.0.1:8671"
let args = CommandLine.arguments
if let idx = args.firstIndex(of: "--url"), idx + 1 < args.count {
    urlString = args[idx + 1]
}

guard let url = URL(string: urlString) else {
    fputs("Invalid URL: \(urlString)\n", stderr)
    exit(1)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // No dock icon
let delegate = TrayDelegate(url: url)
app.delegate = delegate
app.run()
