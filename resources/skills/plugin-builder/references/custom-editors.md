# Plugin Custom Editors & Views

> Reference document of the **plugin-builder** Skill; its siblings are the other `references/*.md` files in the same package, and every path below is relative to that package root. The Skill body does not repeat this material — read the file you need.

Own what happens when the user opens a file of a given type, and ship the UI as a sandboxed view.

## Declare the takeover

```jsonc
"contributes": {
  "customEditors": [{
    "viewType": "image-studio.editor",
    "displayName": "%editor.displayName%",
    "selector": [
      { "filenamePattern": "*.png" }, { "filenamePattern": "*.jpg" }
    ],
    "priority": "default"
  }],
  "views": [{ "id": "image-studio.editor", "title": "%editor.displayName%", "icon": "image", "path": "dist/view/index.html" }]
}
```

- `filenamePattern` supports `*` only (no `?`, no `{a,b}`); a pattern containing `/` matches the whole path, otherwise just the filename; matching is case-insensitive. List one selector per extension.
- `priority: "default"` claims the file over the built-in viewer; `option` makes you an alternative. Two `default` plugins claiming the same pattern resolve deterministically (priority, then plugin id).
- The host picks the **first entry in `contributes.views`** as the editor's HTML — `customEditors` says *which files*, `views` says *where the UI lives*. Both must be present or the tab degrades to a read-only fallback.
- `engines` floors — **the range compares against the plugin API version (`shared/plugin/api-version.ts`), not the app version** — set it to the highest constraint you use: opening a tab requires a host that dispatches `onCustomEditor:` (API ≥ 0.3.1); the document channel's image branch (dataUrl delivery + base64 save) also lands in API 0.3.1; the text channel is older (API ≤ 0.2.x). A floor below a feature you use ships a plugin that opens blank — or 403 — on older hosts.

## Activation — the 403 lesson

`activationEvents` must include `onCustomEditor:<viewType>`. When a tab for that viewType opens, the host **wakes the plugin first, then mounts the iframe** — view files are only servable for a plugin that has been spawned at least once. Skipping the declaration (or a host without the wake step) yields a tab that renders a bare `403 forbidden` with **zero console errors**.

- Do **not** reach for `onStartup` to "fix" this — it's a memory-cost event the market rejects by default; the specific event is the correct one.
- Sleeping (idle ~5 min) stops your background code but keeps serving view files, including lazily-loaded chunks.

## The document channel — your only file access

View iframes cannot import `nextcowork`. They exchange the bound file with the host over postMessage, and **the path is never in any message** — the host uses the tab's binding, so the channel's power ceiling is exactly "this one file":

```
view ──ncw:doc:ready──▶ host ──workspace:readFile──▶ main
view ◀─ncw:doc:open──── host   { path, data, mime? }
view ──ncw:doc:save───▶ host ──workspace:writeFile─▶ main   { data, encoding? }
view ◀─ncw:doc:saved / ncw:doc:saveFailed──
```

Semantics:

- **Open**: `data` is the UTF-8 text for text files, a `data:` URL for images (with `mime`), or `''` when the file can't be previewed (too large / undecodable) — draw your own empty state.
- **Save (text)**: `{ type: 'ncw:doc:save', data }` — host writes UTF-8; binary content is rejected.
- **Save (image/binary)**: `{ type: 'ncw:doc:save', data: <base64>, encoding: 'base64' }` — allowed only when the current file classifies as an image; strictly validated base64. Host floor `0.2.0`.
- **Conflict detection**: every save carries the revision from the last read/write. If the agent or an external editor changed the file meanwhile, you get `ncw:doc:saveFailed` — never a silent overwrite. On failure: stop auto-retrying, surface a retry affordance.
- Skip no-op saves (content unchanged) — otherwise merely opening a file bumps its mtime and the agent misreads "recently modified".
- `ncw:doc:dirty` exists in the message set but is not surfaced as a tab marker by the host; treat unsaved-state retention as your own responsibility (autosave debounced + `pagehide` flush is the established pattern — see `examples/acme.markdown-studio/view/main.tsx`).

Only messages with `event.source === window.parent` are trusted; verify before acting.

## Write the view in React, without shipping React

The host serves React and its own UI kit to every plugin view over an injected import map. Mark them **external** and your view bundle stays in the single-digit KB range, looks exactly like the app, and follows theme changes for free.

```tsx
// view/editor.tsx — no react in package.json, no CSS import
import { useState } from 'react'
import { Button, TextArea, Dialog, EmptyState, cn } from 'nextcowork/ui'
import { mount, onDocument, saveDocument, setDirty, useTheme } from 'nextcowork/view'

mount(<Editor />)
```

```js
// esbuild / rollup
external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'nextcowork/ui', 'nextcowork/view']
```

Or let the CLI do it — add a `views` map to `package.json` and `nextcowork-plugin build` compiles it with those externals and code splitting already set:

```jsonc
"views": { "view/editor.tsx": "dist/view/editor.js" }
```

`npx @aidotnet/create-nextcowork-plugin --view` scaffolds exactly this.

What the host injects into every view HTML response (you write **none** of it): the import map, the theme shim, and `<link rel="stylesheet" href="/__ui.css">`.

Rules that bite:

- **Never bundle `react` yourself.** Two React instances produce `Invalid hook call`, and the stack points at *your* component — you will not guess the cause.
- **Never bundle `nextcowork/view`.** It still runs, but its postMessage channel has nobody on the other end: the editor opens blank, error-free.
- `nextcowork/ui` renders *the host's own components*, so stick to its props rather than re-styling internals; override layout through `className` + the exported `cn()` (string concatenation leaves conflicting Tailwind classes and the winner depends on build order).
- Toast is deliberately absent from the kit (it needs the host window's store). Show messages from the extension side with `ncw.window.showMessage()`.
- Views have **no i18n**: `l10n/` serves the manifest and host-rendered surfaces, not the iframe. Branch on `document.documentElement.lang` if you must.

Reference implementation: `examples/acme.note-editor` — zero dependencies, 1.3 KB view bundle.

## The view iframe environment

- CSP is injected by the host's protocol handler: `script-src 'self'`, `style-src 'unsafe-inline'`, `img-src 'self' data: blob:`, `connect-src` closed. Bundle **everything** except the host-served modules above; a CDN reference fails silently as a blank area.
- Lazy-loaded chunks (esbuild `splitting`) are fine — they resolve to relative `ncw-plugin://` URLs. Ship every chunk in the ZIP; a missing chunk shows up as a feature that never loads, error-free.
- Theme: the host injects a shim that writes the color tokens as **both** `--ncw-<token>` (the public name, use it in your own CSS) and `--color-<token>` (what the host-served `ui.css` reads), and syncs `data-theme` on `<html>`. Read `globalThis.__ncwTheme` synchronously (no first-frame flash), listen for the `ncw:theme` window event, or call `useTheme()`. Don't read `prefers-color-scheme` — the app theme can differ from the OS.
- No popups, no modals, no top navigation: links don't navigate (offer copy-to-clipboard on ⌘/ctrl-click), and workspace-relative image paths cannot resolve (the channel delivers only the bound file). Design for these limits instead of promising controls that can't work.
- Don't write a `<meta>` CSP — the response-header one is authoritative.
- Paths beginning `/__` are host-owned (`/__ui.js`, `/__react.js`, …) and take precedence over files in your package; a file you name `__ui.js` is unreachable.

## The extension side

Usually near-empty: reading/writing is proxied by the host, so your `activate()` typically registers nothing (see `examples/acme.image-studio/src/extension.ts`). Declare `onCustomEditor:<viewType>` and keep `main` pointing at a minimal bundle.

Reference implementations: `examples/acme.note-editor` (host React + UI kit, zero deps), `examples/acme.excalidraw` (JSON via text channel), `examples/acme.image-studio` (image via base64 channel), `examples/acme.markdown-studio` (rich text editor, code-split view).
