# Plugin Runtime API (`nextcowork`)

> Reference document of the **plugin-builder** Skill; its siblings are the other `references/*.md` files in the same package, and every path below is relative to that package root. The Skill body does not repeat this material — read the file you need.

The host-side API surface — imported from the bare module `nextcowork` in your `main` entry only (views can't use it; see `references/custom-editors.md`).

```ts
import * as ncw from 'nextcowork'
export function activate(context) { /* register; push disposables to context.subscriptions */ }
export function deactivate() {}
```

★ Push every registration into `context.subscriptions` — disposables left outside survive sleep (idle ~5 min) and get registered **again** on re-wake, duplicating listeners.

Every namespace below notes its permission; the full method-level map lives in `references/permission-map.md`.

## No permission

- `env.appInfo()` — `{ appName, appVersion, language }`.
- `env.openExternal(url)` — system browser; the host asks the user.
- `appearance.get()` / `appearance.onDidChange(cb)` — light/dark. Callbacks don't fire while asleep; re-`get()` after wake instead of counting callbacks.
- `permissions.contains / request / remove` — request is ceiling-bound (`permissions ∪ optionalPermissions`; outside → silent deny, no prompt).
- `commands.registerCommand(id, handler)` — id must be a declared contribution (undeclared ids are silently ignored, so a plugin can't hijack another's command). `commands.executeCommand` executes **own** commands only.
- `tools.registerTool / unregister` (see `references/agent-tools.md`).
- `window.showQuickPick(items, placeholderKey?)` — host-rendered picker; items carry `labelKey`s, not literals. Plugin pages can't draw their own menus (cross-origin iframe).
- `window.showInputBox / showConfirm / progressStart / progressUpdate / progressEnd` — host-rendered prompts.
- `window.setStatusBarItem(id, textKey, options?)` — ≤3 slots; `textKey` is an l10n key; `command` must be your own contribution.
- `tabs.openWebApp(id)` — one of your own statically declared web apps (`contributes.webApps`). The URL is fixed in the manifest, which is why this needs no capability.
  There is **no `tabs.openView`**: a plugin view that isn't bound to a file has no tab kind yet, so sidebar/panel views are parsed but not openable (the plugin detail page shows a diagnostic saying so).
- `configuration.get()` — merged user settings + manifest defaults. **Read-only**: settings are the user's.
- `diagnostics.log(level, message)` — plugin activity log; for authors, not end users.

## `workspace.read`

- `workspace.folders()`, `fs.readFile(path, encoding?)`, `fs.stat(path)`, `findFiles(glob, limit)` — prefix globs only (`src/**`, `docs/*.md`); stronger matching: fetch and filter yourself.
- Paths are **workspace-relative**; absolute paths are rejected. Realpath-normalized; symlink escapes rejected.
- `readFile(path, 'base64')` returns base64 — the honest way to read binary. (Writing binary via `writeFile` is supported with `{ encoding: 'base64' }` on hosts that ship it; check your `engines` floor.)
- `tabs.openCustomEditor(viewType, path)` — open your own editor for a workspace file; no close counterpart (closing is the user's action).

## `workspace.write`

- `fs.writeFile(path, data, { revision? })` — optimistic locking: pass the `revision` from the previous read/write; on-disk changes reject the write instead of being overwritten.
- `fs.delete(path)` — trash, never unlink; failures throw rather than degrade to permanent deletion.

## `process`

- `process.exec(command, args?, { cwd?, timeoutMs? })` — non-interactive; no `ChildProcess` handle, only `{ code, stdout, stderr }`. `argv[0]` must match a bare stem from `allowedCommands` (no paths, no `.exe`), every call rides the full approval chain — same as a user-typed command. Declare the capability **and** the list; the list without the capability is a no-op warning.

## `net`

- `net.fetch(url, init?)` — HTTPS only; per-URL match against `hostPermissions` (`https://host/path*`; `*` only in the path, never in the host); loopback/intranet refused. Returns parsed data (`{ status, headers, body }`), not a `Response` — no stream handles. Views' pages cannot fetch the network at all (CSP); route network through the host window.

## `storage` / `secrets`

- `storage.global` (per machine) / `storage.workspace` (per workspace): string KV, 5 MB quota.
- `secrets.get/set` — safeStorage-encrypted; keys auto-prefixed `plugin:<id>:` so plugins can't collide. Never ship API keys in the package; store user keys here (see the secrets handling pattern in `references/packaging.md`).

## `clipboard` / `window.notify` / `tabs.browser`

- `env.clipboard.readText/writeText` — read additionally needs a one-time confirm.
- `window.showMessage(kind, messageKey, params?)` — system notification, rate-limited, l10n key only.
- `tabs.openBrowser(url, options?)` — in-app web view; URL also matched against `hostPermissions` (two gates, both required).

## `plugins` — inter-plugin communication

- `plugins.exposeApi(methods)` — offer an API; **no permission needed** to offer.
- `plugins.connect(pluginId)` — proxy calling the target's exposed methods. Needs the `plugins` permission **and** the target declared in `dependencies` (missing either → `null`). Sleeping targets are woken automatically; dependencies wake before you do.
- `plugins.events.emit(topic, payload?)` / `on(topic, handler)` — loose-coupled bus; namespace topics (`acme.tasks.updated`). Fans out to running subscribers only, never echoes to the sender. Subscriptions and exposed APIs clear on disable.
- `dependencies` values use the same range syntax as `engines`; self-dependency is an install error.

## l10n-key rule (host-rendered surfaces)

Every string the **host** renders for you — status bar text, quick-pick labels, notifications, permission reasons — is an l10n key resolved against your bundle (`plugin.<id>.<key>`). Literal text shows up as the raw key. In your own iframes you render your own copy (bundle your own dictionary — see the examples' `view/i18n.ts` pattern).
