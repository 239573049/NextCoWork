# Agent Markdown

`src/renderer/src/components/markdown/` is the shared rendering boundary for Agent text. Chat replies (both live and persisted), expanded reasoning, interaction questions/plans, and the workspace Markdown preview use `AgentMarkdown`.

## Public API

```tsx
import { AgentMarkdown, MarkdownProvider } from '../components/markdown'

<MarkdownProvider value={{ onCopyCode, onOpenExternal, resolveLink, onOpenFile, loadImage }}>
  <AgentMarkdown content={text} streaming={isReceiving} variant="response" />
</MarkdownProvider>
```

`variant` is `response`, `compact`, or `document`. It affects typography only. The content model and parser stay identical. `streaming` describes presentation state; the component never edits the transcript or synthesizes content for the next model request. CommonMark accepts incomplete fences, and rich code renderers wait until their fence closes. Stopping a stream preserves all received text. The thread anchors each assistant reply to its preceding message and uses the same keyed block components before and after commit, preserving wrapping, preview controls, image consent and anchor IDs across completion.

`MarkdownProvider` injects host capabilities instead of tying the renderer to session or tab stores. `WorkspaceMarkdownProvider` adapts the existing IPC services: relative links resolve against the document directory (or workspace root for chat), images use protected workspace reads, links open file tabs or the system browser, and code copying uses the host clipboard. The main process remains responsible for filesystem boundaries and symlink checks.

To add a trusted custom renderer, register a language in `codeRenderers`. A renderer receives `{ code, language, meta, streaming }`. The surrounding code block keeps source display, copying and wrapping available. Registration is application code; a model's fence language cannot register components, execute a tool, or write a file.

```tsx
<MarkdownProvider value={{ codeRenderers: { chart: ChartPreview } }}>
  <AgentMarkdown content={result} />
</MarkdownProvider>
```

## Supported content

- CommonMark headings, emphasis, paragraphs and breaks, ordered/nested lists, quotes, rules, reference/inline links, inline/fenced/indented code, and images.
- GFM tables (including column alignment), task lists, strikethrough, automatic links, and footnotes.
- Inline `$…$` and display `$$…$$` math via KaTeX, including accessible MathML.
- Mermaid fences with diagram/source switching, theme updates, and source fallback for incomplete or invalid diagrams.
- Lazy syntax highlighting using the same language grammars as the editor, with static selectable DOM. Unknown languages and snippets above 100,000 characters use plain escaped code.
- Local headings and footnotes scoped to each component instance. Identical headings in separate Agent turns do not create duplicate document IDs.

Code blocks and tables scroll horizontally within the available width. Copy returns the original code, without labels or highlighting markup. Body, compact, and document variants use the existing theme tokens. Control copy and accessibility labels live in both locale catalogs under `markdown.*`.

## Content policy

Raw HTML is skipped; MDX/JSX, scripts, and arbitrary embedded HTML are not executed. URL handling allows HTTP(S), scoped anchors and workspace files; other schemes and paths escaping the workspace are blocked. External images show a placeholder until the user chooses to load them. Image requests omit the referrer, and the production CSP permits HTTP(S) for images only; script and connection rules are unchanged.

KaTeX runs with `trust: false` and bounded macro expansion. Mermaid runs only for a complete fence, loads on demand, has strict security and text/edge limits, and presents its result as an SVG image rather than inserting interactive SVG into the message. Diagrams with image nodes, resource CSS, embedded HTML (except line breaks), or configuration directives use the source fallback so their layout cannot initiate hidden resource requests. Invalid diagrams also fall back to readable/copyable source. Mermaid rendering is serialized because its configuration is shared across instances.

Tool output is not assumed to be Markdown. Terminal output, JSON and file diffs retain their existing presenters. A future tool that explicitly returns Markdown can reuse this component with the appropriate host adapter.

## Verification

Unit coverage lives in `components/markdown/__tests__/agent-markdown.test.ts` and the workspace Markdown tests. It includes all incremental prefixes of a response, nested/incomplete code fences, math, multiple message anchors/footnotes, language highlighting, both locales, and unsafe content.

Run `npm run build && node scripts/agent-markdown-qa.mjs` for desktop acceptance against an isolated local provider. The script retains screenshots and fixtures in its printed temporary directory and never uses a real provider key. The workspace-file acceptance script also verifies the shared Markdown preview and syntax highlighting.
