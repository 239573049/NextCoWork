# Plugin Agent Tools & Cards

> Reference document of the **plugin-builder** Skill; its siblings are the other `references/*.md` files in the same package, and every path below is relative to that package root. The Skill body does not repeat this material — read the file you need.

Give the agent new tools whose calls and results render as cards in chat.

## Declare then register

The tool must appear in the manifest **and** be registered at runtime — the name must match or registration is ignored:

```jsonc
"contributes": { "tools": [{
  "name": "create_task",
  "title": "%tool.createTask%",
  "icon": "plus",
  "shape": "mutate",
  "card": { "title": "%tool.createTask.card%", "summary": "%tool.createTask.sum%" }
}] }
```

```ts
ncw.tools.registerTool('create_task', {
  description: 'Create a task in the current board.',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  readOnly: false, destructive: false, needsNetwork: false, interactive: false,
  async invoke({ input, callId, progress, onAction }) {
    return { content: [{ text: `Created "${input.title}"` }] }
  }
})
```

- Tools join the same registry as built-in and MCP tools; the host prefixes external names (`plugin__…`) so two plugins' `search` don't collide. The model and transcripts store the prefixed name; the UI maps back via the catalog.
- **The host does not validate `inputSchema`** — it goes to the model verbatim and comes back as `input` unvalidated. Validate and narrow yourself; never trust shapes.
- Flags: `readOnly` / `destructive` feed approval decisions; `needsNetwork` signals network use; `interactive: true` relaxes the call timeout to the interactive cap (see below).
- Registering a tool needs **no permission**; the RPCs you call inside `invoke` gate normally (see `references/manifest-permissions.md`).
- Activation: declare `onTool:<name>` so the plugin wakes when the tool is first used.

## `shape` and `card` templates

- `tool.shape` picks the folded-card icon/renderer: `reasoning | read | mutate | search | command | network | orchestration | external` (default `external`).
- `card.title/summary` are `%l10nKey%` templates interpolated with the tool's input. While parameters are still streaming (half-formed JSON), the host falls back to the static title — never leak literal `{param}`.

## Result cards (UI-only)

Return a `card` next to `content`. **The model only ever sees `content` text — the card is UI-only and never enters the transcript.**

Declarative blocks (sanitized by the host; unknown blocks dropped, oversize cards dropped, schemes checked):

- `keyValue` `{ rows: [{ label, value, tone? }] }`
- `table` `{ columns, rows }`
- `status` `{ label, tone? }` — tone `neutral | info | ok | warn | danger`
- `text` `{ value }`, `code` `{ value, language? }`
- `image` `{ dataRef, alt? }` — `dataRef` must be `data:` or `ncw://`
- `progress` `{ fraction, label? }`
- `link` `{ href, label? }` — https only, opened by the system browser
- `button` `{ actionId, label, tone? }` — interactive only (below)

Frame card — your own HTML for arbitrary UI:

```ts
card: { kind: 'frame', viewType: 'acme.tasks.card', data: { taskId: 42 } }
```

`viewType` must be declared in `contributes.cardViews`. The card HTML is served from `ncw-plugin://<id>/<path>`; the host pushes `{ type: 'ncw:card:data', data, callId, pluginId }` once ready (one-way, read-only), you post `{ type: 'ncw:card:height', height }` to negotiate size and `{ type: 'ncw:card:action', actionId, value }` for actions. Cards mount only when expanded.

## Live progress cards

While the tool runs:

```ts
progress({ message: 'Fetching…', card: { kind: 'declarative', blocks: [{ type: 'progress', fraction: 0.5 }] } })
```

`progress.card` is volatile (not persisted) and auto-expands the tool card; the final result `card` replaces it. Throttle updates — one per meaningful step, not per chunk.

## Interactive cards (buttons)

Set `interactive: true`, push a card with `button` blocks, and suspend until a click:

```ts
async invoke({ input, progress, onAction }) {
  const action = await new Promise((resolve) => {
    onAction(resolve)
    progress({ card: { kind: 'declarative', blocks: [
      { type: 'text', value: `Delete ${input.count} tasks?` },
      { type: 'button', actionId: 'approve', label: 'Approve', tone: 'ok' },
      { type: 'button', actionId: 'cancel', label: 'Cancel', tone: 'danger' }
    ] } })
  })
  if (action.actionId !== 'approve') return { content: [{ text: 'Cancelled by user' }] }
  return { content: [{ text: 'Deleted' }] }
}
```

The click routes host-side back to your still-running tool. Buttons on a finished tool's card are inert; the user can always cancel (= abort).

## Checklist

- Name declared in manifest `contributes.tools` == `registerTool` name; `onTool:<name>` in `activationEvents`.
- `inputSchema` is JSON Schema and self-describing — it's the model's only contract.
- Return `{ content: [{ text }] }`; everything the model must know goes in that text.
- Card templates are l10n keys; both locales shipped.
- `readOnly`/`destructive` set honestly — they drive approval UX.
