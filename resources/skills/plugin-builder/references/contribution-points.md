# Contribution Points

> Reference document of the **plugin-builder** Skill; its siblings are the other `references/*.md` files in the same package, and every path below is relative to that package root. The Skill body does not repeat this material — read the file you need.

Everything a plugin can declare in `contributes`, what the host actually does with it, and — for four keys plus one option — what it deliberately does *not* do yet.

Contributing is **declarative and needs no permission**. Permissions gate the runtime RPCs your code calls, never the contribution points themselves (see `manifest-permissions.md`).

## The full table — check `Status` before you build on it

| Key | What it gives the user | Status |
|---|---|---|
| `commands` | A named action, runnable from the command palette | **live** |
| `menus` | That command placed in a specific host menu | **live** |
| `keybindings` | A working shortcut for that command | **live** (built-ins win conflicts) |
| `customEditors` | Your UI takes over a file type | **live** |
| `views` | The HTML behind a custom editor (`location: "editor"`) | **live** |
| `views` with `location: "sidebar"` / `"panel"` | A standalone panel | ⚠️ **parsed, never opens** |
| `webApps` | A website as a first-class entry, zero code | **live** |
| `tools` | A new tool the agent can call | **live** |
| `cardViews` | Custom HTML for a tool's `frame` result card | **live** |
| `configuration` | Typed settings rendered in the plugin's detail page | **live** |
| `skills` | Bundled Skills injected into the model's catalog | **live** |
| `slashCommands` | `/name` in the chat composer | ⚠️ **parsed, composer ignores it** |
| `agents` | Bundled sub-agents | ⚠️ **parsed, scanner ignores it** |
| `modes` | Bundled modes | ⚠️ **parsed, scanner ignores it** |
| `themes` | Bundled appearance themes | ⚠️ **parsed, settings ignore it** |

**The ⚠️ rows install cleanly and do nothing.** They validate, they ship, and the plugin detail page shows a diagnostic saying so — but no user-facing surface reads them. Declare them only to be forward-compatible; never as the feature you promised. The live list is `SUPPORTED_CONTRIBUTION_KEYS` in `src/shared/plugin/manifest.ts`; the inactive list with its reasons is `ACCEPTED_BUT_INACTIVE` in `src/main/plugin/unsupported.ts`. A key in **neither** list is reported as `unsupported` and ignored entirely.

`kind: "webapp"` packages may only contribute the code-free keys — `webApps`, `skills`, `themes`, `agents`, `modes`. Anything needing a handler behind it (`commands`, `tools`, `customEditors`, `menus`, `views`) is rejected at parse time rather than silently dropped.

---

## commands, menus, keybindings

The three go together: a command is the unit of action, menus and keybindings are ways to reach it.

```jsonc
"commands": [
  { "command": "acme.tasks.new", "title": "%cmd.new%", "icon": "plus" }
],
"menus": {
  "tabBar/new":     [{ "command": "acme.tasks.new", "group": "create@10" }],
  "explorer/context": [{ "command": "acme.tasks.new", "when": "resourceExtname == .md" }]
},
"keybindings": [
  { "command": "acme.tasks.new", "key": "CmdOrCtrl+Shift+T" }
]
```

- Menu mount points are a **closed set**: `tabBar/new`, `tabBar/context`, `explorer/context`, `explorer/new`, `sidebar/nav`, `chat/composer`, `commandPalette` (`MENU_IDS` in `src/shared/plugin/contribution.ts`). An unrecognized id becomes a diagnostic, not a crash — and your item simply never appears.
- `group` is `<group>@<order>`, VS Code style. Groups are `view` / `create` / `tools` / `plugin`. **Separators are generated from group boundaries**, so there is no "separator" item to add. Plugin items are clamped after built-in ones regardless of the order you pick — you cannot outrank a host action.
- Icon names come from a fixed set; anything unrecognized falls back to `puzzle` ("this is a plugin") rather than rendering blank.
- Register the handler with `ncw.commands.registerCommand(id, fn)` and declare `onCommand:<id>` so the host can wake you. A declared command with no registered handler is the classic "menu item does nothing" bug.
- Disabled, failed and unapproved plugins contribute **no** commands at all — a palette entry that does nothing when clicked reads as a broken app, so the host would rather not show it.
- `key` is **Electron accelerator syntax**: `CmdOrCtrl` / `Cmd` / `Ctrl` / `Alt` / `Option` / `Shift` joined by `+`. Write `CmdOrCtrl` for the cross-platform modifier — it renders as `⌘` on macOS and `Ctrl` elsewhere. A word outside that set (`mod`, say) is neither translated nor matched: it renders verbatim in the palette and the shortcut never fires.
- **Built-in shortcuts win.** The keymap takes the first command claiming a combination and built-ins are merged ahead of plugins, so you cannot take over `⌘N`. Shortcuts are also suppressed while the user is typing in an input.

## customEditors + views

Take over a file type. Full treatment — the `ncw:doc` document channel, save conflicts, dirty tracking, writing the view in React against the host's `nextcowork/ui` kit — is in **`custom-editors.md`**. In short:

```jsonc
"customEditors": [
  { "viewType": "acme.note.editor", "displayName": "%editor.name%",
    "selector": [{ "filenamePattern": "*.note" }], "priority": "default" }
],
"views": [
  { "id": "acme.note.editor", "title": "%editor.name%", "icon": "file-pen",
    "path": "dist/view/editor.html" }
]
```

- `views[].location` defaults to `"editor"` and **must stay that way today**. `sidebar` and `panel` parse but cannot be opened: a plugin view not bound to a file has no tab kind to live in. For a standalone surface use `webApps` instead.
- `priority` ranks claimants when several plugins match the same file: `"default"` (the default) sorts ahead of `"option"`, ties broken by plugin id so the winner is the same on every machine. Disabled, failed and unapproved plugins never claim — otherwise disabling a plugin would leave its file type unopenable.
- Never use `*` as a `filenamePattern` — you would take over source files too.

## webApps

A website as a first-class entry, with **no code at all**. The whole package can be three files. Full rules in `manifest-permissions.md` (`kind: "webapp"`); working example `examples/ncw.bilibili`.

```jsonc
"webApps": [{
  "id": "home", "title": "%app.home%", "icon": "tv",
  "url": "https://www.bilibili.com/",
  "open": "tab",      // "tab" (default) | "right"; "feature" falls back to a tab for now
  "entry": "sidebar"  // "sidebar" (default) | "none"
}]
```

The URL is **fixed in the manifest**, which is exactly why this needs no `tabs.browser` permission — the user saw the destination on the install screen. Dynamic navigation (`tabs.openBrowser`) is the one that needs the capability plus a per-URL gate. A malformed or non-https URL fails the **whole manifest** at load time, rather than producing a sidebar entry that does nothing when clicked.

## tools + cardViews

Give the agent something new to call. Full treatment — `inputSchema` responsibilities, the `readOnly`/`destructive`/`needsNetwork` flags, result / live-progress / interactive cards — is in **`agent-tools.md`**.

```jsonc
"tools": [{
  "name": "say_hello", "title": "%tool.hello%", "shape": "orchestration",
  "card": { "title": "%tool.hello.card%", "summary": "%tool.hello.summary%" }
}],
"cardViews": [
  { "viewType": "acme.chart", "path": "dist/cards/chart.html" }
]
```

- `shape` picks the collapsed-card icon and the expanded renderer: `reasoning` / `read` / `mutate` / `search` / `command` / `network` / `orchestration` / `external` (default). It is **presentation only** — it does not change what the tool may do.
- `card.title` / `card.summary` are `%l10nKey%` values interpolated with `{param}` after translation. During streaming the input may be half-parsed JSON; the renderer falls back to the static title rather than showing stray braces.
- `cardViews` is deliberately **separate** from `views`: cards are inline, scroll with the chat, take data one-way, and are recyclable — a different lifecycle from a resident view.

## configuration

Typed settings, rendered as real controls in the plugin's detail page — no settings UI to write.

```jsonc
"configuration": {
  "title": "%config.title%",
  "properties": {
    "apiBase":  { "type": "string",  "title": "%config.apiBase%", "default": "https://api.acme.com" },
    "verbose":  { "type": "boolean", "title": "%config.verbose%", "default": false },
    "retries":  { "type": "number",  "title": "%config.retries%", "default": 3 },
    "mode":     { "type": "enum",    "title": "%config.mode%", "enum": ["fast", "thorough"], "default": "fast" }
  }
}
```

Read them with `ncw.configuration.get()` — **no permission needed**. It takes no arguments and resolves the whole record: your manifest defaults with the user's edits applied on top.

★ There is **no setter**, deliberately. Settings are the user's intent, not the plugin's — with a write path, "I turned that off and it came back" becomes a symptom nobody can explain. Treat every read as untrusted input and keep working when a value is missing or nonsense.

## skills

Bundled Skills that join the model's catalog while your plugin is enabled. This is the only contribution point whose effect is present in **every later turn of every conversation** — which is why the market shows the names on the card, and the install dialog lists them before the user commits.

```jsonc
"contributes": {
  "skills": [{ "path": "skills/pdf-tools" }]
}
```

```
acme.pdf/
└── skills/
    └── pdf-tools/
        ├── SKILL.md          # required
        └── scripts/check.py  # optional assets, referenced from the body
```

Rules, each of which exists because of a specific silent failure:

- **The path must be exactly `skills/<name>` — two segments.** The packager copies a fixed set of directories (`package.json`, `dist`, `l10n`, `assets`, `skills`, `themes`), so a skill declared under `my-stuff/` works on your machine and is **absent from the published ZIP**. The manifest parser rejects it so you find out before packaging, and the market rejects it again on upload.
- **`<name>` must match `^[a-z0-9][a-z0-9-]{0,63}$`** — it reaches the model verbatim as the Skill name.
- **`SKILL.md` must exist and its frontmatter must have a `description`.** A skill without a description is voided entirely by the scanner (under progressive disclosure the description is the model's only basis for choosing it). The installer refuses the package rather than letting you ship a skill that silently never loads.
- **The name and description come from the frontmatter, not the manifest.** Declaring them twice would let the two drift, and after they drift neither one is authoritative — the market would advertise A while the model sees B.

How it behaves once installed:

- Directories are handed to the scanner as **absolute paths** when the plugin is **enabled**, and withdrawn the moment it is disabled or uninstalled. The model's catalog tracks the plugin's state with no restart.
- **Plugin skills have the lowest priority**: a same-named skill in the user's global or project Skill root wins. Yours is a sensible default; anything the user wrote themselves overrides it.
- If two enabled plugins contribute the same skill name, the first (ordered by plugin id, so it is deterministic across machines) wins and the other gets a diagnostic — it does not silently vanish.
- When the model invokes a plugin skill locally, the tool result includes the **absolute package directory**, so body text like "run `scripts/check.py`" resolves. On an SSH workspace a skill that ships assets is marked unavailable instead: the files are on the client and the commands run on the server.
- The plugin detail page lists the skills that actually loaded, and separately lists any that were declared but never showed up — that is where a name clash or a missing description surfaces.

## agents, modes, themes ⚠️

Same shape as `skills` (`[{ "path": "…" }]`), validated and installed, **and read by nothing**. The plugin detail page shows a diagnostic for each. Ship them only as forward-compatibility; do not describe them as features of your plugin.

★ A second trap on top of that: the packager only copies `package.json`, `dist`, `l10n`, `assets`, `skills`, `themes`. **`agents/` and `modes/` are not copied**, so even once the host learns to read them, a package built today ships without those directories. When they go live, rebuild — don't assume your existing ZIP carries them.

## slashCommands ⚠️

Parsed and validated, but the composer does not offer plugin commands yet.

```jsonc
"slashCommands": [
  { "name": "tasks", "command": "acme.tasks.new", "title": "%cmd.new%" }
]
```

`command` must reference a command declared in the **same manifest** — a slash command is a second way to reach an existing command, not a separate registration channel. `name` must match `^[a-z0-9][a-z0-9-]{0,31}$` because it appears verbatim in the input box. Today the underlying command still works from the command palette and from `menus`, so declaring both gives users a working path now and the slash command later.

---

## Debugging "I declared it and nothing happened"

In this order:

1. **Is the key live?** Check the table above. Four contribution points parse and do nothing.
2. **Is it in the plugin detail page's diagnostics?** Unsupported keys, inactive contributions, unrecognized menu ids and failed skills all report there.
3. **Is there an activation event the host dispatches?** The full set is `onCommand:` / `onView:` / `onCustomEditor:` / `onTool:` / `onWebApp:` / `onSlashCommand:` / `onWorkspaceContains:`, plus the literal `onStartup` (which the market rejects by default). A contribution whose plugin never wakes does nothing.
4. **Did you register the handler?** Declaring `commands` / `tools` is half the job; `activate()` must call `registerCommand` / `registerTool`.
5. **Are both locale files present with every `%key%` you used?** A missing key fails install outright, but a key present in only one locale surfaces as raw `%key%` text in the other language.
