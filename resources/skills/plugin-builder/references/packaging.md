# Plugin Packaging & Publishing

> Reference document of the **plugin-builder** Skill; its siblings are the other `references/*.md` files in the same package, and every path below is relative to that package root. The Skill body does not repeat this material — read the file you need.

## Two bundles, two rules

| Artifact | Form | `nextcowork` |
|---|---|---|
| `dist/extension.js` | single-file ESM (`manifest.main`) | **external** — the host injects the real implementation via import map |
| `dist/view/**` | entry + chunks (esbuild `splitting` ok) | **bundle everything** |

- Bundling `nextcowork` into the extension makes every API call return `undefined` — keep it external.
- View iframes run under a host-injected CSP (`script-src 'self'`, `connect-src` closed): one CDN byte = a silently blank area. React, fonts, grammars, everything ships in the package. KaTeX-style fonts can inline as `data:` URLs (`font-src 'self' data:` allows them).
- `splitting: true` gives you lazy chunks (mermaid, per-language grammars) — all chunks must land in the ZIP; a missing chunk is a feature that never loads, error-free. Ship the whole `dist/view` directory.
- CSS imported from the view entry comes out as `main.css` next to `main.js` — remember the `<link>` (symptom of forgetting: everything works, nothing is styled).
- Don't write a `<meta>` CSP in view HTML; the response-header CSP is authoritative.

## ZIP rules (installer-enforced)

- Top-level directory named exactly `<publisher>.<name>`, containing `package.json`.
- Limits: ≤20 MB transfer, ≤50 MB unpacked, ≤2000 files, ≤12 dirs deep, **no symlinks**; `icon` ≤256 KiB (png/jpg/webp).
- The installer verifies every referenced path exists: `main`, both `l10n` locales, view / cardView / theme / skill paths, `icon`. Ship a **clean manifest** in the ZIP — strip `devDependencies`, `scripts`, dev-only fields.
- Case-insensitive path dedup: `Foo.js` and `foo.js` collide.

## Validation before shipping

1. Install the exact ZIP through the real installer in dev (directory install also works for iteration).
2. Exercise the activation path: the event you declare must actually fire (`onCommand:` via its menu, `onCustomEditor:` by opening a file). An unwakeable plugin is a 403 view, error-free.
3. Check the plugin detail page: status, diagnostics, activity log verdicts.
4. `examples/` carry package-level acceptance tests you can mirror (`src/main/plugin/__tests__/*-example.test.ts` — they run the real `installPluginZip` and assert selectors, view files, chunks, l10n, icon).

## `engines`

Four range shapes only: `^` / `~` / `>=` / exact (`^0.x.y` locks the minor pre-1.0). **The range compares against the plugin API version (`shared/plugin/api-version.ts`), not the app version** — the market filters listings by it, and a floor above a client's API hides the plugin there (better than visible-but-broken), while a floor below the features you use ships a plugin that blanks on older hosts. Set the floor to the **highest** constraint you use:

- custom editor whose tab must open (host dispatches `onCustomEditor:`): `>=0.3.1`
- document channel image branch (dataUrl open + base64 save): `>=0.3.1`
- text-only document channel: `>=0.2.0` (or the scaffold default `^0.3.0`)

## Dev install vs market

- Dev: install from a directory or ZIP via the plugins panel; local installs are marked non-market (updates only replace market-sourced plugins).
- Market versioning: `(plugin_id, version)` and `(plugin_id, sha256)` are unique — bump `package.json` `version` every publish, or the server answers 409.

## Publishing to the market

Author flow (server repo ships `packages/nextcowork-plugin`, a login/package/publish CLI mirroring the server's `InspectPackage`):

1. `login` — browser OAuth (PKCE), same session model as the desktop client.
2. `publish <dir> --changelog "…"` — the CLI packages, creates the listing if new (`POST /api/plugins`), uploads (`POST /api/plugins/{id}/versions`, multipart `file` + `changelog`), and submits for review (`POST /api/plugins/{id}/submit`).
3. Review — approve/reject sets the version `published`; only published versions appear in listings and updates. A version adding required permissions is flagged `permissionEscalated`, and installed users must re-approve on update.

Notes:

- The listing's category should be one of the server's categories (fetch `/api/plugins/categories`).
- The package icon is extracted from the ZIP at upload and attached to the listing.
- Never ship secrets or API keys in the package — store user credentials via `secrets` after install.
- Updates compute added permissions against the last **published** version, so keep changelogs honest about new capabilities.

## Common failure → cause

| Symptom | Cause |
|---|---|
| Install refused: "icon not in package" | `assets/` missing from the ZIP (build script didn't copy it) |
| Tab shows bare `forbidden` | plugin never woke — undeclared/undispatchable activation event |
| View blank, zero errors | missing chunk/CSS in package, or CDN reference under CSP |
| Every API call returns `undefined` | `nextcowork` bundled instead of external |
| Save always fails on images | binary save needs `encoding: 'base64'` + host ≥0.2.0 |
| Market 409 on upload | version or content hash already published — bump `version` |
| Plugin hidden in market | `engines` above the querying client version |
