# Plugin Manifest & Permissions

> Reference document of the **plugin-builder** Skill; its siblings are the other `references/*.md` files in the same package, and every path below is relative to that package root. The Skill body does not repeat this material — read the file you need.

Authoritative reference for `package.json` (the manifest) and for how plugin capabilities are granted, checked, and escalated.

## Manifest reference

```jsonc
{
  "publisher": "acme",                 // ^[a-z0-9][a-z0-9-]{0,63}$
  "name": "tasks",                     // same shape; id = "acme.tasks"
  "kind": "extension",                 // optional: "extension" (default) | "webapp" — see below
  "displayName": "Acme Tasks",
  "description": "…",
  "version": "1.2.0",                  // semver
  "license": "MIT",                    // optional
  "icon": "./icon.png",                // optional, package-relative, ≤256 KiB, png/jpg/webp
  "categories": ["Productivity"],      // optional, ≤8
  "keywords": ["tasks"],               // optional, ≤16
  "engines": { "nextcowork": "^0.3.0" },   // ^x.y.z | ~x.y.z | >=x.y.z | exact — no compound ranges
  "main": "./dist/extension.js",       // single-file ESM; must exist — omit it only for "webapp"
  "l10n": "./l10n",                    // optional; needs BOTH zh-CN.json and en-US.json
  "activationEvents": ["onCommand:acme.tasks.new"],
  "permissions": ["workspace.read"],           // required capabilities (granted at install)
  "optionalPermissions": ["net"],              // requestable at runtime
  "hostPermissions": ["https://api.acme.com/*"],  // net + in-app browser allow-list, https only
  "allowedCommands": ["git"],                  // process.exec allow-list, bare executable names
  "dependencies": { "acme.core": "^1.0.0" },   // other plugins you connect() to; same range syntax
  "contributes": { /* commands / menus / views / customEditors / cardViews / tools / webApps / … */ }
}
```

### ★ `engines.nextcowork` is the **plugin API version**, not the app version

The host declares which plugin API it implements (currently `0.3.0`, see
`src/shared/plugin/api-version.ts`); `engines` is matched against **that**, never against
the app's own version. These two were once conflated — the host compared `^0.2.0` against
`app.getVersion()` (2.x), so every plugin written from the official template installed as
**"load failed"**. Write `^0.3.0`. Manifests declaring `^0.2.0` still load, with a
deprecation diagnostic.

### `kind: "webapp"` — a plugin with no code at all

The smallest useful plugin is "bring a website in": an icon plus a URL. Declaring
`"kind": "webapp"` means the package has **no `main`**, and the host never starts a
process for it.

```jsonc
{
  "publisher": "ncw", "name": "bilibili", "kind": "webapp",
  "displayName": "哔哩哔哩", "version": "0.1.0",
  "engines": { "nextcowork": "^0.3.0" },
  "l10n": "./l10n",
  "permissions": [],
  "hostPermissions": ["https://www.bilibili.com/*"],
  "contributes": {
    "webApps": [{
      "id": "home", "title": "%app.home%", "icon": "tv",
      "url": "https://www.bilibili.com/",
      "open": "tab",        // "tab" (default) | "right"; "feature" falls back to a tab for now
      "entry": "sidebar"    // "sidebar" (default) puts an entry in the sidebar | "none"
    }]
  }
}
```

- Shipping `main` in a webapp manifest is an **error, not an ignored field** — ignoring it
  would leave the author debugging an `activate()` that never runs.
- A webapp cannot contribute `commands` / `tools` / `customEditors` / `menus` / `views`:
  with no code those would be registrations with no handler behind them.
- `webApps[].url` is checked at **load time** (https, no credentials). A bad URL fails the
  whole manifest instead of producing a sidebar entry that does nothing when clicked.
- Navigation stays inside `hostPermissions`; off-site links are handed to the system browser.
- Login state is shared with the user's own browser tabs (same per-workspace session
  partition) — that's what makes "install it and you're already signed in" work.
- Working example: `examples/ncw.bilibili` (three files, zero JavaScript).

Rules that bite:

- Every contributed `title` / `displayName` must be an `%l10nKey%` reference, never literal copy. Both locale files must ship — one missing → install refused.
- `hostPermissions` with no `net` (or `tabs.browser`), or `allowedCommands` with no `process`, are warnings with **no effect**.
- `dependencies` self-reference is an error; you can only `connect()` to declared dependencies.
- `engines` supports exactly four range shapes; `^0.x.y` locks to the minor (pre-1.0 semver). An unreadable range fails install, an unsatisfied one marks the plugin `error` with a diagnostic.

## The permission model — how a call actually gets through

Three separate questions, in order:

1. **Is the method on the whitelist?** Every RPC must exist in `src/shared/plugin/protocol.ts` (`PluginMethodMap`). Unknown method → `unknown_method`. This is why the typed `nextcowork.d.ts` is also the capability surface: nothing compiles that would be rejected here.
2. **Is the capability granted?** Each method maps to one permission or `null` (see the map below and `references/permission-map.md`). `null` = no permission needed. Not granted → `permission_denied`.
3. **Does the argument pass its gate?** Even with the capability, arguments are narrowed per call: workspace paths must stay inside the workspace root (realpath-normalized, symlinks rejected), `net.fetch` URLs must be HTTPS and match `hostPermissions` entry by entry, `process.exec` argv[0] must match an `allowedCommands` stem. Write-type calls additionally ride the same approval chain as the agent's own tools.

### The ceiling rule (why manifests matter)

`request()` can only ask for `permissions ∪ optionalPermissions`. Anything outside is **denied silently, without a prompt** — deliberately: the market reviews and the user installs against exactly those two arrays; if runtime could exceed them, a silent auto-update could turn a read-only plugin into one that runs commands. The ceiling is enforced by `canRequest` in `src/shared/plugin/permission.ts`.

Runtime flow: `permissions.contains(p)` → check without prompting. `permissions.request(perms, reasonKey)` → prompts the user (reasonKey is an l10n key). `permissions.remove(perms)` → drop voluntarily.

### Required vs optional vs granted

- `permissions` (required) — must be granted for the plugin to activate; unapproved → status `pending-approval`, plugin inert.
- `optionalPermissions` — declared in the ceiling, granted only when the user agrees at runtime.
- Upgrade **escalation** is computed from *required* only: a new required permission the previous version didn't have → plugin pauses as `disabled-pending-approval` until re-approved. Optional growing is not escalation (still needs a runtime yes).
- Write-type capabilities (`workspace.write`, `process`, `scm.write`) go through the host's approval chain on each use — same path as the agent's own mutating tools.

## Permission catalog

| Permission | Unlocks (host-window RPCs) | Argument gate |
|---|---|---|
| `workspace.read` | `workspace.folders/readFile/stat/findFiles`, `tabs.openCustomEditor` | paths inside workspace root, symlink-normalized |
| `workspace.write` | `workspace.fs.writeFile/delete` | approval chain; delete goes to trash, never unlinks |
| `process` | `process.exec` (and streaming variants) | argv[0] ∈ `allowedCommands` |
| `net` | `net.fetch` | HTTPS only, per-URL `hostPermissions`, no intranet/loopback |
| `storage` | `storage.global/workspace` get/set/keys | 5 MB per plugin |
| `secrets` | `secrets.get/set` | keys auto-prefixed `plugin:<id>:`, encrypted at rest |
| `scm.read` | `scm.status/diff/log/branches` | workspace repo only |
| `scm.write` | `scm.stage/commit/createBranch/checkout` | approval chain |
| `agent.intercept` | register a tool-call interceptor | can only tighten decisions, never widen |
| `agent.context` | register a per-turn context provider | length-capped, visible in UI |
| `clipboard` | `env.clipboard.readText/writeText` | read additionally needs a one-time confirm |
| `window.notify` | `window.showMessage` | rate-limited |
| `tabs.browser` | `tabs.openBrowser` (in-app web view) | per-URL `hostPermissions` as a second gate |
| `plugins` | `plugins.connect/invoke` + event bus emit/subscribe | target must be a declared `dependency` |

`exposeApi` (offering your own API) needs **no** permission — providing is not consuming.

For the method-by-method map (including every `null` method), read `references/permission-map.md`. When the host repo is available, treat the `PERMISSION`-style table in `src/shared/plugin/protocol.ts` as the live truth — methods are added there first.

## What needs **zero** permissions

- Contributing anything: commands, menus, keybindings, views, custom editors, card views, tools, themes, configuration, **web apps**. Contribution points are declarative; the user saw them at install.
- The **document channel** used by custom editors (read/write the one bound file via `ncw:doc:*` postMessage) — the host proxies it, the path never appears in messages. This is why a pure custom editor (image/markdown/excalidraw-style) needs an empty `permissions` array.
- `env.appInfo`, `env.openExternal` (https only), `appearance.get/onDidChange`, `permissions.*`, `diagnostics.log`, `window.showQuickPick/showInputBox/showConfirm/progress*/setStatusBarItem`, `tabs.openWebApp` (the URL is fixed in the manifest), `configuration.get`, `commands.register/execute` (own), `tools.register/unregister`, `tool.progress`, `customEditors.setDirty`, `plugins.expose`.

Rule of thumb: **declare permissions for what your host-side code calls at runtime, not for what your manifest contributes.** When debugging "it does nothing", check in order: activation event dispatchable → status in the plugin detail page → activity log verdict (`denied` shows which gate).
