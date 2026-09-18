---
name: plugin-builder
description: Author, package, and debug NextCoWork plugins end to end. Use when writing a plugin package.json manifest, contributing commands / menus / views / custom editors / agent tools, rendering result cards (declarative or iframe), building live and interactive tool cards, wiring inter-plugin communication (dependencies, exposed APIs, event bus), or fixing plugin activation, permissions, and packaging.
---

# NextCoWork Plugin Builder

Build plugins that extend the NextCoWork desktop app and its AI agent. A plugin is a self-contained package that runs **sandboxed** and talks to the host over a small, permissioned RPC surface. This Skill is the complete authoring reference: manifest, permissions, contribution points, the `nextcowork` runtime API, agent tools, result/live/interactive cards, inter-plugin communication, and packaging.

## Use this Skill when

- Scaffolding a new plugin `package.json` manifest and entry module.
- Contributing commands, menus, keybindings, sidebar views, custom editors, themes, skills, or configuration.
- Contributing **agent tools** and shaping how their calls and results look in chat.
- Returning **result cards** (declarative primitives or a plugin-owned iframe) from a tool.
- Pushing **live progress cards** while a tool runs, or **interactive cards** with buttons the user clicks.
- Wiring **inter-plugin communication**: declaring dependencies, exposing an API, calling another plugin, or using the event bus.
- Debugging activation, permission denials, tool naming, card sanitization, or packaging.

## The isolation model (read this first)

Every plugin runs with **no access to the host DOM or Node**. Two surfaces exist:

- **Background host window** — a hidden `BrowserWindow` (`sandbox`, `contextIsolation`, `nodeIntegration:false`) on a dedicated session partition, serving your `main` ESM entry from `ncw-plugin://<publisher>.<name>/`. This is where `activate()` and your tool/command handlers run.
- **View / card iframes** — your HTML (`contributes.views`, `contributes.customEditors`, `contributes.cardViews`) rendered in a cross-origin `ncw-plugin://` iframe inside the main window. Sandboxed: no popups, no modals, no top-navigation. Network `connect-src` is closed — all HTTP must go through `ncw.net.fetch`.

You reach the host **only** through the `nextcowork` module API. Every capability is gated by a permission the user granted, plus an argument gate (path inside the workspace, host in `hostPermissions`, command in `allowedCommands`).

Inspect the host implementation when behavior is unclear:

- Manifest schema + validation: `src/shared/plugin/manifest.ts`
- RPC methods + permissions: `src/shared/plugin/protocol.ts`
- Permission model: `src/shared/plugin/permission.ts`
- Contribution points (menus/icons/when): `src/shared/plugin/contribution.ts`
- Custom editor matching: `src/shared/plugin/custom-editor.ts`
- Result cards: `src/shared/agent/tool-card.ts`
- Lifecycle + RPC gate + broker: `src/main/plugin/manager.ts`
- Plugin tool bridge: `src/main/plugin/tools.ts`
- Runtime shim + protocol handler: `src/main/plugin/protocol.ts`
- Card rendering: `src/renderer/src/views/chat/CardRenderer.tsx`, `PluginCardFrame.tsx`
- Full typed API surface: `packages/plugin-api/nextcowork.d.ts`

## Package anatomy

```
<publisher>.<name>/
├── package.json            # the manifest (required)
├── dist/
│   ├── extension.js        # single-file ESM entry (manifest.main)
│   ├── views/*.html        # view / cardView HTML (optional)
│   └── ...
├── l10n/                   # zh-CN.json + en-US.json (required if you use %keys%)
│   ├── zh-CN.json
│   └── en-US.json
└── icon.png                # optional
```

The entry must be a **single-file ESM `.js`** (bundle your dependencies). Install by ZIP (top-level single dir named `<publisher>.<name>`) or from a directory in dev.

## Manifest reference (`package.json`)

```jsonc
{
  "publisher": "acme",                 // ^[a-z0-9][a-z0-9-]{0,63}$
  "name": "tasks",                     // same shape; id = "acme.tasks"
  "displayName": "Acme Tasks",
  "description": "…",
  "version": "1.2.0",                  // semver
  "license": "MIT",                    // optional
  "icon": "./icon.png",                // optional, package-relative
  "categories": ["Productivity"],      // optional, ≤8
  "keywords": ["tasks"],               // optional, ≤16
  "engines": { "nextcowork": "^0.2.0" },   // ^x.y.z | ~x.y.z | >=x.y.z | exact
  "main": "./dist/extension.js",       // single-file ESM
  "l10n": "./l10n",                    // optional; needs zh-CN.json + en-US.json
  "activationEvents": ["onCommand:acme.tasks.new"],
  "permissions": ["workspace.read"],           // required capabilities
  "optionalPermissions": ["net"],              // requestable at runtime
  "hostPermissions": ["https://api.acme.com/*"],  // net allow-list
  "allowedCommands": ["git"],                  // process.exec allow-list (bare names)
  "dependencies": { "acme.core": "^1.0.0" },   // other plugins you connect() to
  "contributes": { /* see below */ }
}
```

Rules that bite:

- Every contributed `title` / `displayName` must be an `%l10nKey%` reference, never literal copy. Provide the key in **both** `l10n/zh-CN.json` and `l10n/en-US.json` (shipping only one locale fails install).
- `hostPermissions` with no `net`, or `allowedCommands` with no `process`, are warnings (no effect).
- `dependencies` values use the same range syntax as `engines`; self-dependency is an error. You can only `connect()` to plugins listed here.
- The manifest is the **capability ceiling**. `permissions.request()` for anything outside `permissions ∪ optionalPermissions` is silently denied.

## Permissions

| Permission | Grants |
|---|---|
| `workspace.read` | `workspace.fs.readFile/stat/findFiles`, folders |
| `workspace.write` | `workspace.fs.writeFile/delete` (delete goes to trash; write runs the host approval chain) |
| `process` | `process.exec` — `argv[0]` must be in `allowedCommands` |
| `net` | `net.fetch` — HTTPS only, each URL matched against `hostPermissions`, no intranet |
| `storage` | key-value store (5 MB/plugin) |
| `secrets` | encrypted key-value (safeStorage), keys auto-prefixed |
| `scm.read` / `scm.write` | git status/diff / commit/branch |
| `agent.intercept` | tool-call interceptor (can only tighten) |
| `agent.context` | inject per-turn context (length-capped) |
| `clipboard` | clipboard read/write |
| `window.notify` | system notifications |
| `plugins` | inter-plugin `connect()` + event bus (target must also be a declared dependency) |

Query/request at runtime: `permissions.contains(p)`, `permissions.request(perms, reasonKey)`, `permissions.remove(perms)`.

## Activation events

Declared plugins wake lazily on the first matching event. Waking a plugin **wakes its declared dependencies first**.

- `onStartup` — wakes at launch. **The market rejects this by default** (memory risk). Avoid unless essential.
- `onCommand:<commandId>`, `onView:<viewId>`, `onCustomEditor:<viewType>`, `onTool:<toolName>`, `onWorkspaceContains:<glob>`

Idle plugins sleep after ~5 minutes; the next event re-wakes them.

## Contribution points (`contributes`)

```jsonc
"contributes": {
  "commands": [{ "command": "acme.tasks.new", "title": "%cmd.new%", "icon": "plus" }],
  "menus": {
    "tabBar/new": [{ "command": "acme.tasks.new", "group": "create@20", "when": "…" }]
  },
  "keybindings": [{ "command": "acme.tasks.new", "key": "cmd+shift+t" }],
  "views": [{ "id": "acme.tasks.board", "title": "%view.board%", "path": "dist/views/board.html", "icon": "table" }],
  "customEditors": [{
    "viewType": "acme.tasks.editor",
    "displayName": "%editor.tasks%",
    "selector": [{ "filenamePattern": "*.tasks" }],
    "priority": "default"
  }],
  "cardViews": [{ "viewType": "acme.tasks.card", "path": "dist/views/card.html" }],
  "tools": [{
    "name": "create_task",
    "title": "%tool.createTask%",
    "icon": "plus",
    "shape": "mutate",                                  // folded-card shape (see below)
    "card": { "title": "%tool.createTask.card%", "summary": "%tool.createTask.sum%" }
  }],
  "themes": [{ "path": "dist/themes/dark.json" }],
  "skills": [{ "path": "dist/skills/my-skill" }],
  "configuration": {
    "title": "%config.title%",
    "properties": { "acme.tasks.autoAssign": { "type": "boolean", "title": "%config.autoAssign%", "default": false } }
  }
}
```

- **Icons** are a fixed whitelist (see `contribution.ts` `MENU_ICON_NAMES`): file, folder, image, pen-tool, pencil, eye, search, terminal, globe, git-branch, clock, settings, play, square, plus, download, upload, package, puzzle, sparkles, wrench, bug, chart, table, link, bookmark, shield, …
- **Menu ids**: `tabBar/new`, `tabBar/context`, `explorer/context`, `explorer/new`, `sidebar/nav`, `chat/composer`, `commandPalette`. Plugin items always sort after built-ins in the same group; ≤3 show inline, the rest collapse.
- **`configuration` is read-only** to the plugin (`configuration.get()`); the user owns the switches.
- **`tool.shape`** picks the folded-card icon/renderer: `reasoning | read | mutate | search | command | network | orchestration | external` (default `external`). `tool.card.title/summary` are `%l10nKey%` templates interpolated with the tool's input; when a param is missing (streaming), the host falls back to the static title — never leak `{param}`.

## The `nextcowork` runtime API

Import from the bare module `nextcowork` (mapped by the host):

```ts
import * as ncw from 'nextcowork'
export function activate(context) { /* register things; push disposables to context.subscriptions */ }
export function deactivate() {}
```

Namespaces:

- `env` — `appInfo()`, `openExternal(url)`, `clipboard.readText/writeText` (needs `clipboard`).
- `appearance` — `get()`, `onDidChange(cb)` (light/dark; no permission).
- `permissions` — `contains`, `request`, `remove`.
- `workspace` — `folders()`, `fs.readFile/writeFile/delete/stat`, `findFiles(glob, limit)`. Paths are workspace-relative; writes carry an optimistic `revision`.
- `process.exec(command, args?, options?)` — non-interactive; `command` must be in `allowedCommands`.
- `net.fetch(url, init?)` — HTTPS only, per-URL `hostPermissions` check.
- `storage.global` / `storage.workspace` — `get/set/keys`. `secrets.get/set`.
- `window` — `showMessage(kind, messageKey, params?)`, `showQuickPick(items, placeholderKey?)`, `setStatusBarItem(id, textKey, options?)`. All use l10n keys, not literals.
- `commands` — `registerCommand(id, handler)` (id must be declared), `executeCommand(id, args?)` (own commands only).
- `tabs.openCustomEditor(viewType, path)`; `customEditors.setDirty(documentId, path, dirty)`.
- `tools.registerTool(name, tool)` — contribute an agent tool (name must be declared).
- `diagnostics.log(level, message)` — write to the plugin's activity log.
- `plugins` — inter-plugin comm (see below).

## Authoring an agent tool

```ts
ncw.tools.registerTool('create_task', {
  description: 'Create a task in the current board.',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  readOnly: false,
  destructive: false,
  needsNetwork: false,
  interactive: false,               // set true if you await user input (see interactive cards)
  async invoke({ input, callId, progress, onAction }) {
    // return a string, or { content: [{ text }], isError?, card? }
    return { content: [{ text: `Created "${input.title}"` }] }
  }
})
```

- `inputSchema` is JSON Schema, passed to the model **verbatim** — the host does not validate it; you validate `input` yourself.
- Tools join the same registry as built-in and MCP tools; the host prefixes the name (`plugin__…`) to avoid collisions.
- The model sees only `content` text. The result **card is UI-only and never sent to the model**.

### Result cards

Return a `card` to render a rich result instead of a JSON dump:

```ts
return {
  content: [{ text: 'Task created' }],
  card: {
    kind: 'declarative',
    blocks: [
      { type: 'keyValue', rows: [{ label: 'Title', value: input.title }, { label: 'Status', value: 'open', tone: 'ok' }] },
      { type: 'status', label: 'Assigned to you', tone: 'info' },
      { type: 'progress', fraction: 0.2, label: '1/5 done' }
    ]
  }
}
```

Declarative `CardBlock` primitives (all sanitized by the host; unknown blocks are dropped, oversize cards are dropped, images/links are scheme-checked):

- `keyValue` `{ rows: [{ label, value, tone? }] }`
- `table` `{ columns: string[], rows: string[][] }`
- `status` `{ label, tone? }` — tone: `neutral | info | ok | warn | danger`
- `text` `{ value }`, `code` `{ value, language? }`
- `image` `{ dataRef, alt? }` — `dataRef` must be `data:` or `ncw://`
- `progress` `{ fraction, label? }`
- `link` `{ href, label? }` — `https` only, opened via the system browser
- `button` `{ actionId, label, tone? }` — interactive (see below)

**Frame card** — render arbitrary UI in your own iframe (declare it in `contributes.cardViews`):

```ts
card: { kind: 'frame', viewType: 'acme.tasks.card', data: { taskId: 42 } }
```

The card HTML is served from `ncw-plugin://<id>/<path>`. The host pushes `{ type:'ncw:card:data', data, callId, pluginId }` once ready; you post `{ type:'ncw:card:height', height }` to negotiate size and `{ type:'ncw:card:action', actionId, value }` to send an action back. Data is one-way and read-only. Only mounted when the card is expanded.

### Live progress cards

While a tool runs, push a card via `progress`:

```ts
async invoke({ input, progress }) {
  progress({ message: 'Fetching…', card: { kind: 'declarative', blocks: [{ type: 'progress', fraction: 0.5 }] } })
  // …
  return { content: [{ text: 'done' }] }
}
```

`progress.card` is volatile (not persisted) and auto-expands the tool card in chat. It is replaced by the final result `card` when the tool returns.

### Interactive cards (buttons the user clicks)

Set `interactive: true` (relaxes the tool timeout to a host cap; the user can always cancel = abort), push a card with `button` blocks, and await the action:

```ts
async invoke({ input, progress, onAction }) {
  const action = await new Promise((resolve) => {
    onAction(resolve)
    progress({
      message: 'Waiting for approval',
      card: { kind: 'declarative', blocks: [
        { type: 'text', value: `Delete ${input.count} tasks?` },
        { type: 'button', actionId: 'approve', label: 'Approve', tone: 'ok' },
        { type: 'button', actionId: 'cancel', label: 'Cancel', tone: 'danger' }
      ] }
    })
  })
  if (action.actionId !== 'approve') return { content: [{ text: 'Cancelled by user' }] }
  return { content: [{ text: 'Deleted' }] }
}
```

The click routes host-side back to your still-running tool. Buttons on a finished tool's card are inert.

## Inter-plugin communication

Requires the `plugins` permission. You can only reach plugins you list in `dependencies`.

**Expose an API** (no permission needed to offer):

```ts
ncw.plugins.exposeApi({
  getBoard() { return currentBoard },
  addTask(title) { return createTask(title) }
})
```

**Call another plugin** (needs `plugins` + a declared dependency on it; the target is auto-woken):

```ts
const core = ncw.plugins.connect('acme.core')   // proxy
const board = await core.getBoard()             // routed through the host broker
```

**Event bus** (loose coupling; namespace your topics):

```ts
ncw.plugins.events.emit('acme.tasks.updated', { id: 42 })
const sub = ncw.plugins.events.on('acme.tasks.updated', (payload, from) => { /* … */ })
```

Events fan out only to **running** subscribers and never echo to the sender. Subscriptions and exposed APIs are cleared when the plugin is disabled.

## Custom editors & views

- A `customEditor` binds a `filenamePattern` to a `viewType`; opening a matching file mounts your `views/<file>.html` iframe as a Tab. The host proxies the document over `ncw:doc:ready` / `ncw:doc:open` / `ncw:doc:save` — **the path is never in the message** (the host uses the Tab-bound file), and saves carry a `revision` for conflict detection.
- Sidebar `views` mount similarly. Theme is synced to iframes via `ncw:theme` postMessage (24 color tokens + `data-theme`).

## Packaging & install

- ZIP: a single top-level dir named exactly `<publisher>.<name>`, containing `package.json`. Limits: ≤20 MB transfer, ≤50 MB unpacked, ≤2000 files, ≤12 dirs deep, **no symlinks**.
- The installer validates that every file referenced by `contributes` (view/cardView/theme/skill paths, `icon`, `main`, both `l10n` locales) exists.
- Market installs verify a `sha256`; local ZIP/dir installs (dev) do not. Updates only replace market-sourced plugins.

## Gotchas

- Titles/messages are **l10n keys**, not text — provide both locales.
- The **manifest is the capability ceiling**; runtime requests can't exceed it.
- Tool `inputSchema` is not validated by the host — validate input yourself.
- Result/live/interactive cards are **UI-only**; the model only ever sees `content` text.
- `connect()` needs both the `plugins` permission and a declared `dependencies` entry, or it returns `null`.
- Prefer specific `activationEvents` over `onStartup`.

## Minimal working plugin

`package.json`:

```jsonc
{
  "publisher": "acme", "name": "hello", "displayName": "Hello", "description": "demo",
  "version": "0.1.0", "engines": { "nextcowork": "^0.2.0" }, "main": "./dist/extension.js",
  "l10n": "./l10n", "activationEvents": ["onTool:say_hello"],
  "permissions": [],
  "contributes": { "tools": [{ "name": "say_hello", "title": "%tool.hello%", "shape": "orchestration" }] }
}
```

`dist/extension.js`:

```ts
import * as ncw from 'nextcowork'
export function activate(context) {
  context.subscriptions.push(
    ncw.tools.registerTool('say_hello', {
      description: 'Greet someone.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      readOnly: true, destructive: false, needsNetwork: false,
      async invoke({ input }) {
        return {
          content: [{ text: `Hello, ${input.name}!` }],
          card: { kind: 'declarative', blocks: [{ type: 'status', label: `Greeted ${input.name}`, tone: 'ok' }] }
        }
      }
    })
  )
}
```

`l10n/zh-CN.json` → `{ "plugin.acme.hello.tool.hello": "打个招呼" }`, `l10n/en-US.json` → `{ "plugin.acme.hello.tool.hello": "Say hello" }`.
