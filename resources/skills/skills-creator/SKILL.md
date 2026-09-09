---
name: skills-creator
description: Create, install, validate, update, and diagnose NextCoWork Skills. Use when authoring a SKILL.md package, installing a global or workspace Skill, packaging a Skill ZIP, or fixing Skill discovery, activation, or diagnostics.
---

# NextCoWork Skill Creator

Create Skills as small, portable workflow packages that extend the NextCoWork agent. Keep the package self-contained, deterministic where possible, safe to install, and easy to discover from the desktop Skills view.

## Use this Skill when

- Creating a new Skill from a workflow brief or an existing reference Skill.
- Updating an installed Skill while preserving its existing behavior.
- Installing a local ZIP or a marketplace Skill into the global Skill directory.
- Deciding whether a Skill belongs globally or only in one workspace.
- Debugging Skill discovery, frontmatter, activation, package validation, or diagnostics.
- Preparing a Skill for publication through the Skills market.

## Renderer conventions

Use the application's global Skill root, `<appData>/skills`, resolved from `getHost().paths.userData()`. In development this is `<app working directory>/.next-cowork/skills`; packaged builds use the application's per-user data directory. Do not assume that app data lives in the user's home directory. Treat `<workspace>/.next-cowork/skills` as the workspace-local root when a workflow must be isolated to one project. Keep global Skills available across workspaces; keep workspace-local Skills available only to the owning workspace.

Bundled Skills live in the NextCoWork repository at `resources/skills/<skill-name>/SKILL.md`. On application startup, each missing bundled Skill directory is copied into the global Skill root with its supporting resources. Existing installations are preserved.

Inspect the existing implementation before changing behavior:

- Skill domain types: `src/shared/domain/skill.ts`
- Skill IPC handlers: `src/main/ipc/skills.ts`
- Skill registry and discovery: `src/main/kernel/skill/registry.ts`
- Skill loading and frontmatter parsing: `src/main/kernel/skill/load.ts`
- Installation and ZIP handling: `src/main/kernel/skill/install.ts`
- Bundled Skill installation: `src/main/kernel/skill/bundled.ts`
- Renderer service API: `src/renderer/src/services/skills.ts`
- Skills screen: `src/renderer/src/views/skills/SkillsFeature.tsx`
- Skills state: `src/renderer/src/stores/skills.ts`
- Existing Skill tests: `src/main/kernel/skill/__tests__/`, `src/renderer/src/views/skills/use-skill.test.ts`

Use the renderer's existing UI components, theme tokens, and i18n catalog. Add user-visible copy to both supported locales through `src/renderer/src/i18n/`; do not add literal Chinese or English UI strings inside TSX.

## Package anatomy

Create this minimum structure:

```text
<skill-name>/
└── SKILL.md
```

Add resources only when they reduce repeated work or provide domain knowledge:

```text
<skill-name>/
├── SKILL.md
├── scripts/       # deterministic helpers that can be executed repeatedly
├── references/    # detailed material loaded only when needed
└── assets/        # templates, icons, examples, or other output resources
```

Use a lowercase hyphenated directory name. Keep it between 1 and 64 characters and use only `a-z`, `0-9`, and `-`. Make the directory name, frontmatter `name`, and package root agree exactly.

## Write SKILL.md

Start with YAML frontmatter:

```yaml
---
name: example-skill
description: Explain what the Skill does and the requests that should activate it.
---
```

Write the body in imperative or infinitive form. State the purpose, trigger conditions, workflow, inputs, outputs, constraints, and validation checks. Keep the body concise; move large schemas, API notes, and examples into `references/` and link them from the body.

Prefer this order:

1. Purpose and activation conditions.
2. Required inputs and expected outputs.
3. Ordered workflow with decision points.
4. Renderer-specific integration notes.
5. Safety, privacy, and failure handling.
6. Validation and test commands.

Avoid vague instructions such as “handle the request carefully.” Name the file, command, endpoint, state, or observable result that proves each step is complete.

## Create workflow

1. Extract concrete request examples and identify the repeated work.
2. Inspect the renderer service, IPC contract, registry, and related tests before designing new conventions.
3. Decide which information belongs in `SKILL.md`, `references/`, `scripts/`, or `assets/`.
4. Create the package under a temporary working directory, then validate its frontmatter and root name.
5. Add or update focused tests for parsing, discovery, installation, scope, and failure behavior.
6. Package the Skill as a ZIP while preserving the top-level `<skill-name>/` directory.
7. Install it into `<appData>/skills` for global use, or the workspace-local root for isolated use.
8. Reload the registry and verify that the Skills view lists the Skill with the correct name, category, scope, and activation state.

## Installation and scope

Use the existing renderer service functions instead of writing a second installer:

- `pickSkillZip()` to select a local package.
- `installSkillZip(path, workspaceId, scope)` to install a local package.
- `installMarketSkill(slug, version, workspaceId, scope)` to install a marketplace version.
- `setSkillGlobalEnabled(skillId, enabled)` to change the global activation state.
- `setSkillWorkspaceActive(skillId, workspaceId, active)` to change workspace activation.

Default to global scope when the user says “install this Skill” without naming a workspace. Ask for or infer workspace scope only when the request explicitly limits the Skill to a project. Never silently replace an existing Skill with a different package; show the conflict and preserve the installed copy until the user chooses an update.

## Validation checklist

Before installation or publication, verify:

- Frontmatter parses and includes `name` and `description`.
- The frontmatter name matches the package directory name.
- The package has no path traversal, absolute paths, duplicate entries, or symbolic links.
- Scripts do not depend on undeclared working directories or secrets.
- References and assets are linked from the instructions when they are required.
- The Skill can be discovered from the global root and, when applicable, the workspace root.
- Global and workspace activation states remain independent.
- A malformed or oversized ZIP produces a user-readable localized error and leaves no partial installation.
- Diagnostics report the actual file and reason, without exposing credentials or private file contents.

Run the narrowest relevant tests first, then the renderer typecheck and test suite. For changes to discovery or installation, cover both global and workspace-local roots and include a regression test for the failure that prompted the change.

## Publication checklist

Prepare a Skill for the market only after local installation succeeds. Include a clear display name, one-sentence description, category, version, changelog, and any required assets. Keep secrets, API keys, private user data, and machine-specific absolute paths out of the ZIP. Verify that a fresh install into `<appData>/skills` works without manual edits.

## Failure handling

Return a stable, localized error key from renderer code and map it in both locale catalogs. Preserve the original package when an update fails. Clean up temporary archives and partially copied directories. Record actionable diagnostics for developers while keeping user-facing messages short and safe.

## Icon guidance

Use a square raster icon for Skill cards. Prefer a 1:1 crop, clear subject at small sizes, simple background, no embedded text, no watermark, and a final file under 256 KB. Store project-bound examples in `assets/`; use the upload flow when publishing so the image is stored as a Skill resource rather than embedded as a large data URL in metadata.

When working in the NextCoWork source repository, the optional reference icon is `src/renderer/assets/skills/skill-creator-icon.jpg`. Use it as the visual direction for Skill Creator surfaces: a centered geometric toolbox-and-document mark, deep green and warm gold accents, a quiet background, and enough contrast for a 48–64 px card. This renderer asset is not part of the installed Skill; never require it for Skill discovery or installation.

When calling an image generation interface for a Skill logo, generate from a logo-specific prompt rather than a scene prompt:

```text
为 NextCoWork 的 <Skill 名称> 设计一个专业软件产品 Logo 图标。用 <核心符号> 表达 <Skill 能力>。正方形 1:1 构图，单一居中主体，适合 48px 到 64px 的桌面端 Skill 卡片，品牌色 <颜色>，轻微半立体或扁平矢量质感，边缘清晰，高对比度，干净纯色背景。只生成图形 Logo，不要人物、场景、道具堆叠、文字、字母、数字、边框或水印。
```

For the bundled Skill Creator example, use a magic toolbox, document page, and sparkle motif in deep green and warm gold. Request a square output when the provider supports it; otherwise crop the generated image around the single mark and keep the final file under 256 KB.
