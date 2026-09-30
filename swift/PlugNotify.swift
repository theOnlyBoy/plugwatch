// PlugNotify.swift — macOS notification helper for PlugWatch.
//
// Two modes:
//   * Informational — title + body only. Posts and exits immediately.
//   * Actionable    — title, body, then `id:Title` buttons. Stays alive until the
//                     user picks one (then prints the chosen id and exits) or
//                     until the 5-minute timeout.
//
// Must be run from inside the app bundle (PlugNotify.app/Contents/MacOS/PlugNotify):
// UserNotifications refuses to post from a bare executable that has no
// CFBundleIdentifier. See scripts/build-notify.sh.
//
// Usage:
//   PlugNotify <title> <body> [<id:Title> ...]
//   PlugNotify --clear          remove every notification this app delivered
//
// Actionable notifications never time out: they stay until the user picks a
// button, dismisses them, or a newer notification supersedes them (the caller
// kills the old helper). macOS owns how long the *banner* lingers — that is a
// per-app system setting and cannot be controlled from here.
//
// Examples:
//   PlugNotify "plugwatch started" "Watching power state."
//   PlugNotify "Start LM Studio?" "On AC power" start:Start skip:Skip
//
// Exit codes / output contract (consumed by src/notify.ts):
//   0  posted (informational), or an action was chosen — the id is printed on stdout
//   1  setup error (permission denied, bad arguments)
//   3  dismissed / clicked without choosing a button

import AppKit
import Foundation
import UserNotifications

func fail(_ message: String, code: Int32) -> Never {
	FileHandle.standardError.write(Data((message + "\n").utf8))
	exit(code)
}

let argv = Array(CommandLine.arguments.dropFirst())

// `--clear` withdraws everything this app has delivered or scheduled. The watcher
// calls it before posting fresh controls and when it shuts down: a notification
// left over from a previous run belongs to a watcher that no longer exists, so
// clicking its buttons would print to a dead stdout and silently do nothing.
if argv.first == "--clear" {
	let center = UNUserNotificationCenter.current()
	center.removeAllDeliveredNotifications()
	center.removeAllPendingNotificationRequests()
	center.setNotificationCategories([])
	// The removals are asynchronous; give usernoted a moment to receive them.
	Thread.sleep(forTimeInterval: 0.25)
	exit(0)
}

guard argv.count >= 2 else {
	fail("usage: PlugNotify <title> <body> [<id:Title> ...] | --clear", code: 2)
}

let title = argv[0]
let body = argv[1]

struct Action {
	let id: String
	let title: String
}

var actions: [Action] = []
for spec in argv.dropFirst(2) {
	guard let colon = spec.firstIndex(of: ":"), colon != spec.startIndex else {
		fail("bad action spec (want id:Title): \(spec)", code: 2)
	}
	let id = String(spec[spec.startIndex ..< colon])
	let actionTitle = String(spec[spec.index(after: colon)...])
	guard !actionTitle.isEmpty else {
		fail("empty action title in: \(spec)", code: 2)
	}
	actions.append(Action(id: id, title: actionTitle))
}

let hasActions = !actions.isEmpty
let categoryId = "PLUGWATCH_" + actions.map(\.id).joined(separator: "_")

final class Delegate: NSObject, UNUserNotificationCenterDelegate {
	func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		didReceive response: UNNotificationResponse,
		withCompletionHandler completionHandler: @escaping () -> Void
	) {
		completionHandler()
		let id = response.actionIdentifier
		switch id {
		case UNNotificationDefaultActionIdentifier:
			// Body click without a button — no decision.
			exit(3)
		case UNNotificationDismissActionIdentifier:
			exit(3)
		default:
			print(id)
			fflush(stdout)
			exit(0)
		}
	}

	func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		willPresent notification: UNNotification,
		withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
	) {
		completionHandler([.banner, .sound])
	}
}

let center = UNUserNotificationCenter.current()
let delegate = Delegate() // strong reference for the process lifetime
center.delegate = delegate

let sem = DispatchSemaphore(value: 0)
center.requestAuthorization(options: [.alert, .sound]) { granted, error in
	defer { sem.signal() }
	guard granted else {
		fail("notification permission denied: \(String(describing: error))", code: 1)
	}
}
sem.wait()

let content = UNMutableNotificationContent()
content.title = title
content.body = body
content.sound = .default

if hasActions {
	let category = UNNotificationCategory(
		identifier: categoryId,
		actions: actions.map { UNNotificationAction(identifier: $0.id, title: $0.title, options: []) },
		intentIdentifiers: [],
		options: [.customDismissAction]
	)
	center.setNotificationCategories([category])
	content.categoryIdentifier = categoryId
}

let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
center.add(request) { error in
	if let error {
		fail("add error: \(error)", code: 1)
	}
	// Informational notification: posted, nothing to wait for.
	if !hasActions { exit(0) }
}

// Keep the process alive so the delegate (and the add completion) can run. An
// actionable notification waits here indefinitely — only a response, a
// dismissal, or the caller killing us ends it.
dispatchMain()
