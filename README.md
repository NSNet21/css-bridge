# CSS Bridge

Navigate, create, and rename CSS rules directly from your JSX/TSX — without leaving your editor.

![CSS Bridge demo](https://raw.githubusercontent.com/NSNet21/css-bridge/main/images/demo.gif)

---

## Features

**Jump & Peek** — `F12` on any `className` or `id` to jump to the CSS rule. Split panel by default. `Ctrl+K Ctrl+P` to peek inline. If multiple CSS files match, a picker lets you choose.

**Reverse Navigation** — `F12` on a `.selector` inside a CSS file to find every JSX/TSX file that uses it.

**Auto-create** — `Ctrl+.` on a missing class or id to create the rule (or the whole CSS file + import) and land your cursor inside the block.

**Autocomplete** — Type inside `className=""` for selector suggestions from your imported CSS. Type `.` at the start of a CSS line for class names from your JSX files.

---

## Project-wide Rename

![Rename demo](https://raw.githubusercontent.com/NSNet21/css-bridge/main/images/rename.gif)

`Alt+R` or `F2` on any class or id — renames across all CSS and JSX/TSX files at once. Scoped to the nearest `package.json` so sub-packages are never touched.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `F12` | Jump to CSS rule |
| `Ctrl+K Ctrl+P` | Peek CSS rule |
| `Ctrl+.` | Quick Fix — create rule / create file |
| `Alt+R` / `F2` | Rename project-wide |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `cssBridge.openLocation` | `beside` | `beside` = split panel, `active` = replace current tab |
| `cssBridge.autoCreateImport` | `true` | Allow auto-creating CSS file and import |

---

## Known Limitations

- Dynamic `className` expressions (`` className={`card--${size}`} ``) are not supported
- `Ctrl+Space` required after `#` for id completion in CSS (VS Code color picker limitation)
- `Ctrl+Click` always opens in same group — use `F12` instead

---

## Release Notes

### 1.1.0

**New features:**
- **Workspace CSS Union** — child components now see CSS imported by ancestors. Common case: `App.tsx` imports `globals.css`, child component uses `className="container"` without re-importing. F12 / Hover / Autocomplete / Code Action all work across the project. Toggle via `cssBridge.includeWorkspaceCss` (default `true`).
- **Aliased imports** — `import '@/styles/globals.css'` (or any path alias) now resolves through `tsconfig.json` / `jsconfig.json` `compilerOptions.paths`.
- **Hover preview** — hover any `className` / `id` to see the matching CSS rule body without leaving the editor. Multi-match preview shows every source.
- **Better project detection** — recognizes Vite / Next / Remix / Rsbuild / Webpack monorepos where `react` is hoisted by workspaces. Replaces the v1.0.x package.json-only boundary check.

**Setting:**
- `cssBridge.includeWorkspaceCss` — `true` to include CSS imported anywhere in the project; `false` for strict per-file imports only.

**New commands:**
- `CSS Bridge: Show Output Log` — open the extension's output channel.
- `CSS Bridge: Diagnose` — dump scope detection, resolved imports, alias config, workspace CSS pool, and cursor context to the output channel. Paste it when reporting bugs to short-circuit "F12 doesn't jump" speculation.

### 1.0.1

- **Fix:** `data-id`, `aria-id`, and other `*-id` attributes are no longer falsely matched as `id=`. Same fix prevents `myCustomClassName=` from being treated as `className=`. Affects Jump, Peek, Autocomplete, and Rename.
- **Fix:** Reverse navigation (CSS → JSX, F12 on a `.selector`) and Rename no longer match attribute-shaped text inside JS/JSX comments.
- **Fix:** CSS-side autocomplete on `#` now returns id suggestions correctly. Items also keep their `.`/`#` prefix on accept (no more dropped or duplicated trigger char).
- **Feat:** `Ctrl+K Ctrl+P` (Peek) now also works *from* a CSS file — peeks JSX usages of the selector under the cursor.
- **Perf:** Cache JSX/TSX import resolution by mtime — no more re-parsing with Babel on every cursor move.

### 1.0.0

Initial release.
