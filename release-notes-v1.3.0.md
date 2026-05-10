# CSS Bridge v1.3.0 — CSS variable jump

`F12` and `Ctrl+Click` now navigate between `var(--foo)` calls and `--foo:` definitions, with multi-theme disambiguation, hover preview, and full reverse-lookup.

## What's new

### CSS variable jump (#2)

- **Forward jump** — `F12` / `Ctrl+Click` on `var(--primary)` lands on its `--primary:` definition. If multiple themes define the same name (`:root` light + `.theme-dark` etc.), the QuickPick disambiguator lists all of them so you can pick the one you want.
- **Reverse navigation** — `F12` on a `--primary:` definition lists every `var(--primary)` site across the project.
- **Hover on `var(--foo)`** — shows every definition: `selector → value · file:line`.
- **Hover on `--foo:`** — summarizes how many places consume it, with the first eight sites listed inline. Shows `*no usages found in scope*` when the variable is orphaned (handy for dead-code detection).
- **Fallback & nested forms** — `var(--primary, blue)` and `var(--a, var(--b))` resolve correctly. The fallback text isn't treated as a separate variable.
- **Multi-theme disambiguation** reuses the existing QuickPick UI; selector path and var path live side-by-side without conflict.

### Diagnose

`CSS Bridge: Diagnose` now reports per-file `Var defs` / `Var uses` counts plus the cursor-detected variable with its forward/reverse target list — so you can verify scope and lookup without having to F12 manually.

## Internals

- New `parseVars(filePath)` in [`src/parsers/cssParser.ts`](src/parsers/cssParser.ts):
  - Definitions via postcss `walkDecls(/^--/)` so the parent rule's selector (`:root` / `.theme-dark`) is captured for theming context.
  - Usages via regex over comment-stripped content; comments are replaced with same-length whitespace so absolute offsets stay accurate.
  - Cached separately from `parseSelectors` (mtime-keyed, independent map) — keeps the v1.0–v1.2 selector path completely untouched.
- New CSS-only `CssBridgeCssHoverProvider` in [`src/providers/hover.ts`](src/providers/hover.ts) — registered on `language: 'css'` only; the JSX hover provider is unchanged.
- `getCssVarAtCursor` in [`src/providers/definition.ts`](src/providers/definition.ts) anchors detection on the `--` prefix so cursor anywhere from the leading `-` through the last name char resolves to the same range.
- `cssWatcher.onDidChange/onDidDelete` now also invalidates the var cache.
- `showDisambiguationPick` gained a `previewMode: 'next' | 'same'` option — selectors keep the existing "next-line" preview (so the rule body is shown), variables use "same-line" so the declaration itself is the visible preview.

## Backward compatibility

- ✅ **Untouched:** all v1.0/v1.1/v1.2 features. `parseSelectors` signature unchanged. `getCssTokenAtCursor` unchanged. JSX hover provider unchanged.
- ⚠️ **Refactored but invisible:** `cssParser.ts` adds new exports + new cache map. `definition.ts provideDefinition` adds a new branch — only fires when cursor is on `var()` or a `--def`; existing logic for `.foo` / `#bar` runs after and is unaffected.
- 🎯 **Intentional behavior change:** F12 on `var(--foo)` previously fell through to VS Code's default; now CSS Bridge intercepts and jumps. F12 on `--foo:` previously fell through; now finds usages. Hover on `var(--foo)` adds CSS Bridge's tooltip alongside VS Code's color preview — they coexist without conflict.

## Verified

- 13/13 cases pass on `node scripts/smokeVars.js` (single :root / multi-theme / fallback / nested / block-comment / local def+use / orphan / whitespace / multi-line / kebab-case / @media wrap)
- Part A fixture tests N1-N13 ✅ (incl. multi-theme QuickPick + Esc cancel + tooltip rendering + orphan empty-state + cache invalidation on save)
- Part B regression R1-R9 ✅ (className jump, dynamic className 15 attr-expr, hover multi-match, reverse-nav, atomic rename `totalEdits=2`, JSX/CSS autocomplete, Code Action `Create rule`)

## Lessons learned

1. **Nested CSS block comments don't work** — writing the literal `*/` sequence inside a `/* ... */` description silently breaks postcss parsing. Caught the bug in our own fixture mid-test (defs=0, uses=12 with one false-positive). Same-length whitespace replacement preserves offsets when stripping comments.
2. **`showDisambiguationPick` previews the line *below*** by design (selectors land on `.foo {` and the body is the meaningful preview). For variables the location *is* the declaration line, so the off-by-one preview showed the next line. Added `previewMode` option to handle both.
3. **`globFiles(scope)` carries scope-isolation for free** — the same function powers selector reverse-nav (verified 32-package monorepo in v1.2). Var jump inherits boundary detection without any new logic.

## How to install

- VSIX: download `css-bridge-1.3.0.vsix` from this release and install via `Extensions → ... → Install from VSIX...`
- Or via Marketplace: `nsnet.css-bridge` (will publish shortly)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
