//
//  BotBoy launcher — a minimal AppKit host so the tracker has a real macOS
//  presence: its own name and icon in the Dock for as long as it runs.
//
//  Why this exists: the previous launcher was a shell script inside an .app
//  bundle. It started the tracker fine, but macOS never registered it as a
//  running application (zero entries in `lsappinfo`), so the Dock icon vanished
//  the instant the script exited — leaving only Chrome's icon to represent
//  BotBoy. An AppleScript applet doesn't fix it either: osacompile can't set
//  the "stay open" flag, so the applet quits after its run handler.
//
//  This process:
//    • runs `start.sh --foreground` as a child and lives as long as it does
//    • quits itself when the tracker exits (no orphaned Dock icon)
//    • on Quit (Cmd-Q / Dock menu), sends SIGINT so the server's own shutdown
//      handler flushes SQLite and stops the monitors
//    • on Dock-icon click, re-opens/focuses the dashboard window
//
//  START_SCRIPT is injected at build time by scripts/make-app-bundle.mjs.
//

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var tracker: Process?
    private let startScript = START_SCRIPT

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard FileManager.default.isExecutableFile(atPath: startScript) else {
            let alert = NSAlert()
            alert.messageText = "BotBoy launcher is stale"
            alert.informativeText = "start.sh was not found at:\n\(startScript)\n\nRegenerate the app with: npm run app:bundle"
            alert.alertStyle = .critical
            alert.runModal()
            NSApp.terminate(nil)
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: startScript)
        process.arguments = ["--foreground"]
        // Detach stdio: the tracker appends to /tmp/ppt.log itself.
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { _ in
            // Tracker is gone — don't leave a Dock icon behind.
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }

        do {
            try process.run()
            tracker = process
        } catch {
            let alert = NSAlert()
            alert.messageText = "BotBoy failed to start"
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .critical
            alert.runModal()
            NSApp.terminate(nil)
        }
    }

    /// Dock-icon click while already running → bring the dashboard forward.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        let opener = Process()
        opener.executableURL = URL(fileURLWithPath: startScript)
        opener.arguments = ["--open-window"]
        opener.standardOutput = FileHandle.nullDevice
        opener.standardError = FileHandle.nullDevice
        try? opener.run()
        return true
    }

    /// Quit → stop the tracker gracefully, then exit.
    func applicationWillTerminate(_ notification: Notification) {
        guard let process = tracker, process.isRunning else { return }
        // SIGINT: start.sh traps it and forwards to the node server, which
        // closes the DB cleanly. SIGTERM/SIGKILL would risk a dirty SQLite.
        kill(process.processIdentifier, SIGINT)
        // Give the shutdown handler a moment; don't hang the Dock forever.
        let deadline = Date().addingTimeInterval(8)
        while process.isRunning && Date() < deadline {
            usleep(100_000)
        }
    }

    /// No windows of our own — the UI is the Chrome app window.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// .regular = show in Dock and app switcher (the whole point of this launcher).
app.setActivationPolicy(.regular)
app.run()
