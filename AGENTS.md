# Frontend implementation rules

- All user-visible frontend copy, including button labels, headings, empty states, placeholders, tooltips, accessibility labels, status text, errors shown in the UI, and interpolated messages, must be provided through the renderer i18n layer in `src/renderer/src/i18n/`.
- Do not add Chinese or English UI strings directly in JSX/TSX. Add a stable namespaced translation key to both supported locales (`zh-CN` and `en-US`) and use `useI18n().t(...)` (or a dedicated i18n-aware component).
- Keep domain values, user content, model names, file names, provider names, tool names, and protocol identifiers untranslated. Translate only the surrounding UI copy.
- When adding a locale, update `SUPPORTED_LOCALES`, both catalogs, settings validation, and the locale selector; run typecheck and tests.
