---
name: plugin-builder
description: Author, package, and debug NextCoWork plugins — the single entry point. Covers the manifest (package.json) and the permission model with per-call capability gates, custom editors / views / the ncw:doc document channel, agent tools with their result / live-progress / interactive cards, the nextcowork runtime API namespaces, the sandbox and isolation model, build + ZIP + market publishing rules, and the shipped examples. Use for scaffolding a plugin package, choosing which resource type to contribute, writing or reviewing a manifest, picking or debugging a permission, taking over a file type, giving the agent new tools, calling host capabilities, or fixing a plugin that builds, installs, activates, renders, or publishes wrong. The detailed material lives in references/ next to this file.
---

# NextCoWork Plugin Builder

Build plugins that extend the NextCoWork desktop app and its AI agent. A plugin is a self-contained package that runs **sandboxed** and talks to the host over a small, permissioned RPC surface.

## Read the reference you need — this page is the map

The details live in `references/`, next to this `SKILL.md`. Read the file that matches the task; this page alone is not enough to write a working plugin.

| Task | Reference |
|---|---|
| Manifest fields, the permission model, what needs which capability | `references/manifest-permissions.md` |
| Method → permission, one row per RPC | `references/permission-map.md` |
| Taking over file types (custom editors), views, the document channel | `references/custom-editors.md` |
| Contributing agent tools, result / live / interactive cards | `references/agent-tools.md` |
| Runtime API namespaces (workspace / net / process / storage / secrets / window / tabs / …) | `references/runtime-api.md` |
| Build, ZIP layout, installer checks, market publish | `references/packaging.md` |

How to open them: the paths above are relative to **this Skill's own package directory** — the directory holding this `SKILL.md`. Bundled Skills are installed into the app's global Skill root (`<userData>/skills/plugin-builder/`), which differs between dev and packaged builds; if you don't know it, locate the package first (for example a Glob search for `**/skills/plugin-builder/SKILL.md`) and read the reference by its absolute path. Do **not** look for them relative to the user's workspace — they are not part of it.

## The isolation model (read this first)

Every plugin runs with **no access to the host DOM or Node**. Two surfaces exist:

- **Background host window** — a hidden `BrowserWindow` (`sandbox`, `contextIsolation`, `nodeIntegration:false`) on a dedicated session partition, serving your `main` ESM entry from `ncw-plugin://<publisher>.<name>/`. This is where `activate()` and your tool/command handlers run.
- **View / card iframes** — your HTML (`contributes.views`, `contributes.customEditors`, `contributes.cardViews`) rendered in a cross-origin `ncw-plugin://` iframe inside the main window. Sandboxed: no popups, no modals, no top-navigation. Views **cannot import `nextcowork`** — that shim only loads in the host window; views talk to the host exclusively through the document channel and the theme shim (see `references/custom-editors.md`).

You reach the host **only** through the `nextcowork` module API (host window side). Every capability is gated by a permission the user granted, plus an argument gate (path inside the workspace, host in `hostPermissions`, command in `allowedCommands`).

## Package anatomy

```
<publisher>.<name>/
├── package.json            # the manifest (required)
├── dist/
│   ├── extension.js        # single-file ESM entry (manifest.main)
│   ├── views/*.html        # view / cardView HTML (optional)
│   └── ...
├── l10n/                   # zh-CN.json + en-US.json (required if you use %keys%)
└── icon.png                # optional (≤256 KB)
```

Install by ZIP (top-level single dir named `<publisher>.<name>`), from a directory in dev, or from the market.

## The smallest plugin is zero code

If all you want is to bring a website in ("open Bilibili in a tab"), you do **not** need an
entry module, a bundler, or a host process. Declare `"kind": "webapp"` and one `webApps`
entry — that's the whole package:

```jsonc
{
  "publisher": "ncw", "name": "bilibili", "kind": "webapp",
  "displayName": "哔哩哔哩", "description": "…", "version": "0.1.0",
  "engines": { "nextcowork": "^0.3.0" }, "l10n": "./l10n",
  "permissions": [],
  "hostPermissions": ["https://www.bilibili.com/*"],
  "contributes": { "webApps": [
    { "id": "home", "title": "%app.home%", "icon": "tv", "url": "https://www.bilibili.com/" }
  ] }
}
```

Installing it puts an entry in the sidebar; clicking it opens the site in a workspace tab,
signed in already (it shares the workspace browser session). Full rules —
including why `main` in a webapp manifest is an error rather than an ignored field —
in `references/manifest-permissions.md`. Working example: `examples/ncw.bilibili`.

## Minimal working plugin (with code)

`package.json`:

```jsonc
{
  "publisher": "acme", "name": "hello", "displayName": "Hello", "description": "demo",
  "version": "0.1.0", "engines": { "nextcowork": "^0.3.0" }, "main": "./dist/extension.js",
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
        return { content: [{ text: `Hello, ${input.name}!` }] }
      }
    })
  )
}
```

`l10n/zh-CN.json` → `{ "plugin.acme.hello.tool.hello": "打个招呼" }`, `l10n/en-US.json` → `{ "plugin.acme.hello.tool.hello": "Say hello" }`.

## Activation model

Declared plugins wake lazily on the first matching event. Waking a plugin **wakes its declared dependencies first**.

- `onStartup` — wakes at launch. **The market rejects this by default** (memory risk). Avoid unless essential.
- `onCommand:<commandId>`, `onCustomEditor:<viewType>`, `onTool:<toolName>`, `onView:<viewId>`, `onWorkspaceContains:<glob>`

★ The event you declare must be one the host actually dispatches: `onCommand:` fires when the user runs the command; `onCustomEditor:` fires when a tab opens for that viewType — the host wakes the plugin **before** mounting the view iframe, because view files are only servable for plugins that have been spawned at least once (an unwoken plugin's iframe is a bare 403 "forbidden"). Prefer these specific events over `onStartup`.

Idle plugins sleep after ~5 minutes; the next event re-wakes them. Sleeping stops your background code but does **not** stop serving your view files.

## Gotchas that bite every new author

- Titles/messages are **l10n keys**, not text — ship both locales or install fails.
- The **manifest is the capability ceiling**; `permissions.request()` for anything outside `permissions ∪ optionalPermissions` is silently denied. See `references/manifest-permissions.md` for what each capability unlocks, per API call.
- Contributing a resource (view / custom editor / command / tool registration) itself needs **no permission** — permissions gate the runtime RPCs you call, not the contribution points. A pure custom editor that saves via the document channel needs **zero** permissions.
- Tool `inputSchema` is not validated by the host — validate `input` yourself.
- Result/live/interactive cards are **UI-only**; the model only ever sees `content` text.
- `connect()` needs both the `plugins` permission and a declared `dependencies` entry.
- `nextcowork` must be **external** in the host-side bundle; views must bundle **everything** (CSP gives no network). See `references/packaging.md`.

Inspect the host implementation when behavior is unclear: manifest schema `src/shared/plugin/manifest.ts`, RPC + permissions `src/shared/plugin/protocol.ts`, permission model `src/shared/plugin/permission.ts`, contribution points `src/shared/plugin/contribution.ts`, custom editor matching `src/shared/plugin/custom-editor.ts`, lifecycle `src/main/plugin/manager.ts`, protocol/CSP `src/main/plugin/protocol.ts`, cards `src/renderer/src/views/chat/CardRenderer.tsx`, full typed API `packages/plugin-api/nextcowork.d.ts`.

Plugin views (custom editors) are React-ready: the host serves `react`, `react-dom` and its own control kit as `nextcowork/ui` over an injected import map, so a view bundle carries neither. Mark them external, import `Button` / `Dialog` / `TextArea` from `nextcowork/ui` and the document channel from `nextcowork/view`. See `references/custom-editors.md`.

Working examples live in `examples/` — `ncw.bilibili` (zero-code web app: three files, no JavaScript), `acme.note-editor` (React view on the host kit, zero dependencies), `acme.excalidraw` (custom editor + command + `onStartup`), `acme.image-studio` (image editor over the document channel's base64 branch, zero permissions), `acme.markdown-studio` (editor + rich split view, zero permissions, code-split chunks).
