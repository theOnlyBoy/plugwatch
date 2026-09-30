# Changelog

## 0.1.0

- Initial release.
- Watches AC/battery transitions and starts/stops the configured targets, asking first through an
  actionable notification (Start/Skip, Stop/Keep) instead of acting silently.
- Hysteresis (`delay.acSec` / `delay.batterySec`) plus idempotency, so a brief unplug/re-plug cannot
  thrash and steady state does nothing.
- `activeHours` window — outside it the service never auto-starts; stopping on battery still applies.
- Startup controls: the service offers Start/Stop buttons for the configured apps when it starts and
  after a long system sleep, so apps can be driven without unplugging.
- Informational notification when the service stops.
- Config-driven targets: any number of apps, each with an ordered `start`/`stop` command list,
  optional `bin` override (accepts `~`), `detached` mode, and per-target `env`/`timeoutMs`/`enabled`.
  `lms` and `ollama` are auto-detected, so configs carry no absolute paths or usernames.
- configurable notification timeout (`PLUGNOTIFY_TIMEOUT_SEC`), a caller-side watchdog so a wedged
  helper cannot stall the watcher, and sleep/wake detection that restarts an unobserved hold.
- Swift `PlugNotify` helper with a generated app icon, built at install time into `PlugNotify.app`.
- CLI: `start`, `stop`, `restart`, `status`, `logs`, `init`, `install`, `uninstall`, plus `--once`,
  `--simulate ac|battery`, `--no-notify`, `--status`, `--purge`, `--force`.
- launchd LaunchAgent install/uninstall.
