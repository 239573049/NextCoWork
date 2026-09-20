# Method → Permission Map

> Reference document of the **plugin-builder** Skill; its siblings are the other `references/*.md` files in the same package, and every path below is relative to that package root. The Skill body does not repeat this material — read the file you need.

Authoritative source: the permission column in `src/shared/plugin/protocol.ts` (`PluginMethodMap`).
This file is a stable snapshot; when the host repo is at hand, diff against the source table —
new methods appear there first. `null` = no capability needed (whitelist still applies).

## No permission required

| Method | Notes |
|---|---|
| `env.appInfo` | app name/version/language |
| `env.openExternal` | host asks the user before opening |
| `appearance.get` / `appearance.subscribe` | light/dark, no user data |
| `permissions.contains` / `request` / `remove` | the ceiling rule still applies to `request` |
| `commands.register` / `unregister` / `execute` | execute is own-commands only |
| `tools.register` / `unregister`, `tool.progress` | registration ≠ invocation; RPCs inside the tool still gate |
| `customEditors.register` / `setDirty` | registration + dirty tracking |
| `tabs.openCustomEditor` | **exception**: needs `workspace.read` (see below) |
| `tabs.openWebApp` | only for web apps statically declared in the manifest — the user already saw them at install |
| `window.showQuickPick` / `showInputBox` / `showConfirm` / `progressStart` / `progressUpdate` / `progressEnd` / `setStatusBarItem` | host-rendered UI; ≤3 status bar slots, l10n keys only |
| `configuration.get` | read-only merged plugin settings |
| `diagnostics.log` | plugin activity log |
| `plugins.expose` | offering an API is not consuming one |

## Capability-gated

| Permission | Methods |
|---|---|
| `workspace.read` | `workspace.folders`, `workspace.readFile`, `workspace.stat`, `workspace.findFiles`, `workspace.subscribeChanges`, `workspace.unsubscribeChanges`, `customEditors.register`, `tabs.openCustomEditor` |
| `workspace.write` | `workspace.writeFile` (optimistic `revision`), `workspace.deleteFile` (trash, never unlink) |
| `process` | `process.exec`, `process.execStream`, `process.execAbort` — argv[0] stem ∈ `allowedCommands` |
| `net` | `net.fetch` — HTTPS, per-URL `hostPermissions`, loopback/intranet refused |
| `storage` | `storage.get/set/keys` (global + workspace scopes, 5 MB quota) |
| `secrets` | `secrets.get/set` (safeStorage-encrypted, auto key prefix) |
| `scm.read` | `scm.status`, `scm.diff`, `scm.log`, `scm.branches` |
| `scm.write` | `scm.stage`, `scm.commit`, `scm.createBranch`, `scm.checkout` |
| `agent.intercept` | `agent.registerInterceptor` — decisions can only tighten |
| `agent.context` | `agent.registerContextProvider` — length-capped, wrapped, UI-visible |
| `clipboard` | `env.clipboardRead` (plus one-time confirm), `env.clipboardWrite` |
| `window.notify` | `window.showMessage` |
| `tabs.browser` | `tabs.openBrowser` — URL also matched against `hostPermissions` |
| `plugins` | `plugins.invoke`, `plugins.emitEvent`, `plugins.subscribeEvent`, `plugins.unsubscribeEvent` — target must be in `dependencies` |

## Reading a denial

- `unknown_method` → the method isn't whitelisted (host older than the API, or a typo).
- `permission_denied` → capability missing **or** the argument failed its gate. The activity log
  (`diagnostics` tab in the plugin detail page) records which, with a per-capability summary
  (path / host / command) — parameters themselves are never logged.
