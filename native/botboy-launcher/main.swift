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
//  GENERIC: the launcher is one fixed, prebuilt binary (native/prebuilt-manifest.json)
//  that serves every checkout, so nothing about THIS Mac is compiled into it. It
//  learns which BotBoy folder to open at run time, from a small file OUTSIDE the
//  bundle that start.sh and scripts/make-app-bundle.mjs keep up to date:
//
//      ~/.personal-productivity-tracker/app-checkout.v1
//          checkout=/Users/maria/botboy-app
//          written=2026-10-13T10:05:00
//
//  Resolution order:
//    1. BOTBOY_APP_START_SCRIPT, an absolute path to a start.sh (tests only;
//       production never sets it).
//    2. `checkout=` in that file; the script is <checkout>/start.sh.
//    3. Neither: show the "launcher is stale" alert, which names the next step.
//  HOME is read from the environment first: NSHomeDirectory() ignored $HOME in
//  the prototype (design-evidence E18), and a launchd user job does receive it.
//
//  Validation: the file is read only up to 8 KB; `checkout=` must be absolute, shorter
//  than 4096 characters, with no control characters; the target must be an
//  executable regular file. Anything else counts as "not recorded". The launcher
//  only ever executes <checkout>/start.sh, never a command taken from the file.
//
//  Test hook: BOTBOY_APP_PRINT_TARGET=1 prints `target=<path>` (exit 0) or
//  `target=none (<detail>)` (exit 3) and exits BEFORE any application object is
//  created. scripts/native-prebuilt.mjs runs it to prove the file loads and
//  resolves before it replaces a working launcher.
//

import AppKit

/// The outcome of looking for start.sh.
struct StartTarget {
    /// Absolute path of an executable start.sh, when one was found.
    var path: String?
    /// Why not, in words the alert can show ("no BotBoy folder is recorded", ...).
    var detail: String
    /// The path that was tried but is not usable (for the alert), when there was one.
    var tried: String?
}

let maxRecordFileBytes = 8 * 1024
let maxCheckoutLength = 4096

func environmentHome() -> String {
    if let home = ProcessInfo.processInfo.environment["HOME"], !home.isEmpty { return home }
    return NSHomeDirectory()
}

/// `checkout=` from the recorded file, validated; nil when not recorded.
func recordedCheckout(home: String) -> String? {
    let file = home + "/.personal-productivity-tracker/app-checkout.v1"
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: file),
          let size = attributes[.size] as? NSNumber, size.intValue <= maxRecordFileBytes,
          let data = FileManager.default.contents(atPath: file),
          let text = String(data: data, encoding: .utf8) else { return nil }
    for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
        guard line.hasPrefix("checkout=") else { continue }
        let value = String(line.dropFirst("checkout=".count))
        guard value.hasPrefix("/"), value.count < maxCheckoutLength else { return nil }
        if value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) { return nil }
        return value
    }
    return nil
}

func isExecutableRegularFile(_ path: String) -> Bool {
    var isDirectory: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
        && !isDirectory.boolValue
        && FileManager.default.isExecutableFile(atPath: path)
}

func resolveStartTarget() -> StartTarget {
    let environment = ProcessInfo.processInfo.environment
    if let override = environment["BOTBOY_APP_START_SCRIPT"], override.hasPrefix("/") {
        if isExecutableRegularFile(override) { return StartTarget(path: override, detail: "from BOTBOY_APP_START_SCRIPT", tried: nil) }
        return StartTarget(path: nil, detail: "BOTBOY_APP_START_SCRIPT is not an executable file", tried: override)
    }
    guard let checkout = recordedCheckout(home: environmentHome()) else {
        return StartTarget(path: nil, detail: "no BotBoy folder is recorded", tried: nil)
    }
    let script = checkout + "/start.sh"
    if isExecutableRegularFile(script) { return StartTarget(path: script, detail: "recorded folder", tried: nil) }
    return StartTarget(path: nil, detail: "start.sh is missing or not executable in the recorded folder", tried: script)
}

// Test hook: report the target and leave before anything GUI exists.
if ProcessInfo.processInfo.environment["BOTBOY_APP_PRINT_TARGET"] == "1" {
    let target = resolveStartTarget()
    if let path = target.path {
        print("target=\(path)")
        exit(0)
    }
    print("target=none (\(target.detail))")
    exit(3)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var tracker: Process?
    private var startScript = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        let target = resolveStartTarget()
        guard let script = target.path else {
            let alert = NSAlert()
            alert.messageText = "BotBoy launcher is stale"
            let what = target.tried.map { "BotBoy could not find start.sh at:\n\($0)" } ?? "No BotBoy folder is recorded for this app."
            alert.informativeText = "\(what)\n\nOpen Terminal, go to your BotBoy folder (for example: cd ~/botboy-app) and run ./start.sh. That reconnects this app."
            alert.alertStyle = .critical
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        startScript = script

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
        guard !startScript.isEmpty else { return true }
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
