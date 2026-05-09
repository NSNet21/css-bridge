import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CssBridgeDefinitionProvider, getCssTokenAtCursor, findJsxLocationsForSelector } from './providers/definition';
import { CssBridgeCodeActionProvider } from './providers/codeAction';
import { JsxCompletionProvider, CssCompletionProvider } from './providers/completion';
import { CssBridgeRenameProvider } from './providers/rename';
import { CssBridgeHoverProvider } from './providers/hover';
import { peekCssRule } from './providers/peek';
import { getAttributeAtCursor } from './parsers/jsxParser';
import { findCssLocations } from './utils/findLocations';
import { showDisambiguationPick } from './utils/quickPick';
import { invalidateCache, parseSelectors } from './parsers/cssParser';
import { invalidateImportCache, resolveCssImports } from './parsers/importResolver';
import { invalidateWorkspaceCssCache, resolveWorkspaceCss } from './utils/resolveWorkspaceCss';
import { findScopeBoundary } from './utils/scopeBoundary';
import { findNearestTsConfig } from './utils/tsconfigResolver';
import { openInLocation } from './utils/openFile';

const DOC_SELECTOR: vscode.DocumentSelector = [
  { language: 'javascript' },
  { language: 'typescript' },
  { language: 'javascriptreact' },
  { language: 'typescriptreact' },
];

export const out = vscode.window.createOutputChannel('CSS Bridge');

// Verbose logging — providers call `logV()` for chatty traces. Gated on
// `cssBridge.verboseLogging` so the default channel stays readable. The
// flag is refreshed via onDidChangeConfiguration so toggling Settings
// takes effect without reload.
let verboseLogging = false;
export function logV(msg: string): void {
  if (verboseLogging) out.appendLine(msg);
}

export function activate(context: vscode.ExtensionContext) {
  out.appendLine('CSS Bridge activated');
  context.subscriptions.push(out);

  // Initial settings snapshot + refresh on change so toggles take effect
  // without a window reload. Done here (top of activate) so anything below
  // that reads these flags sees a sane initial value.
  const refreshSettings = () => {
    const cfg = vscode.workspace.getConfiguration('cssBridge');
    verboseLogging = cfg.get<boolean>('verboseLogging', false);
  };
  refreshSettings();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('cssBridge')) refreshSettings();
    })
  );

  // F12 / Ctrl+Click — Go to Definition (JSX/TSX→CSS and CSS→JSX via Ctrl+Click)
  // Note: for #id selectors in CSS, Ctrl+Click shows 2 results (CSS rule + JSX) because
  // VS Code's built-in CSS provider also returns the CSS self-reference — unavoidable.
  // F12 in CSS uses the jumpToRule command override instead, which shows JSX only.
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      [
        { language: 'javascript' },
        { language: 'typescript' },
        { language: 'javascriptreact' },
        { language: 'typescriptreact' },
        { language: 'css' },
      ],
      new CssBridgeDefinitionProvider()
    )
  );

  // CodeAction — create rule / create CSS file + import
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      DOC_SELECTOR,
      new CssBridgeCodeActionProvider()
    )
  );

  // Peek CSS (Alt+F12 / Ctrl+K Ctrl+P)
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      'cssBridge.peekRule',
      (editor) => peekCssRule(editor, editor.selection.active)
    )
  );

  // Explicit Jump — respects openLocation setting + custom QuickPick for disambiguation
  // Overrides F12 in JSX/TSX/CSS; falls through to built-in when not on className/id/selector
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      'cssBridge.jumpToRule',
      async (editor) => {
        const config = vscode.workspace.getConfiguration('cssBridge');
        const openLocation = config.get<string>('openLocation', 'beside');

        // CSS → JSX: F12 on .selector / #selector in a CSS file
        if (editor.document.languageId === 'css') {
          const token = getCssTokenAtCursor(editor.document, editor.selection.active);
          if (!token) {
            await vscode.commands.executeCommand('editor.action.revealDefinition');
            return;
          }
          logV(`[jump] CSS→JSX ${token.type}="${token.value}"`);
          const locs = findJsxLocationsForSelector(editor.document.fileName, token.type, token.value);
          logV(`[jump] CSS→JSX found ${locs.length} location(s)`);
          if (locs.length === 0) return;
          const target = locs.length === 1 ? locs[0] : await showDisambiguationPick(locs);
          if (!target) return;
          await openInLocation(target.uri, target.range.start, openLocation);
          return;
        }

        // JSX/TSX → CSS
        const attr = getAttributeAtCursor(editor.document, editor.selection.active);
        if (!attr) {
          await vscode.commands.executeCommand('editor.action.revealDefinition');
          return;
        }

        const locations = findCssLocations(editor.document, attr);
        if (locations.length === 0) return;

        const target = locations.length === 1
          ? locations[0]
          : await showDisambiguationPick(locations);

        if (!target) return;
        await openInLocation(target.uri, target.range.start, openLocation);
      }
    )
  );

  // Execute: append rule to existing CSS file + jump cursor into block
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cssBridge.createRule',
      async (cssFile: string, selector: string) => {
        const uri = vscode.Uri.file(cssFile);
        const doc = await vscode.workspace.openTextDocument(uri);

        const endPos = doc.lineAt(doc.lineCount - 1).range.end;
        // Always prepend "\n" — combined with the file's trailing newline this
        // yields exactly one blank line between the previous rule and the new
        // one (CSS convention). Files without a trailing newline get the rule
        // adjacent to the last content, which is acceptable.
        const rule = `\n${selector} {\n\t\n}\n`;
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, endPos, rule);
        await vscode.workspace.applyEdit(edit);
        invalidateCache(cssFile);

        // Do NOT save here — format-on-save would strip the empty indent line,
        // shifting the cursor onto `}` instead of inside the block.
        // Search backwards in the post-edit live doc for the selector we added.
        let cursorLine = Math.min(endPos.line + 2, doc.lineCount - 1); // safe fallback
        for (let i = doc.lineCount - 1; i >= 0; i--) {
          if (doc.lineAt(i).text.trimEnd() === `${selector} {`) {
            cursorLine = Math.min(i + 1, doc.lineCount - 1);
            break;
          }
        }

        const indentLen = doc.lineAt(cursorLine).text.length;
        const cursorPos = new vscode.Position(cursorLine, indentLen);
        const config = vscode.workspace.getConfiguration('cssBridge');
        const openLocation = config.get<string>('openLocation', 'beside');
        await openInLocation(uri, cursorPos, openLocation);
      }
    )
  );

  // Execute: create new CSS file + add import + append rule + jump
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cssBridge.createFileAndImport',
      async (jsxFile: string, cssFile: string, selector: string) => {
        // Create CSS file with initial rule
        const rule = `${selector} {\n\t\n}\n`;
        fs.writeFileSync(cssFile, rule, 'utf-8');

        // Add import to JSX file (after last existing import line)
        const jsxDoc = await vscode.workspace.openTextDocument(jsxFile);
        const jsxText = jsxDoc.getText();
        const lines = jsxText.split('\n');
        let lastImportLine = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trimStart().startsWith('import ')) lastImportLine = i;
        }
        const insertLine = lastImportLine + 1;
        const importStatement = `import './${path.basename(cssFile)}';\n`;

        const edit = new vscode.WorkspaceEdit();
        edit.insert(
          vscode.Uri.file(jsxFile),
          new vscode.Position(insertLine, 0),
          importStatement
        );
        await vscode.workspace.applyEdit(edit);

        // Open CSS file and place cursor inside the rule block
        const cssUri = vscode.Uri.file(cssFile);
        const cursorPos = new vscode.Position(1, 1); // inside selector { | }
        const config = vscode.workspace.getConfiguration('cssBridge');
        const openLocation = config.get<string>('openLocation', 'beside');
        await openInLocation(cssUri, cursorPos, openLocation);
      }
    )
  );

  // F2 — Project-wide Rename (JSX/TSX and CSS, scoped to nearest package.json)
  context.subscriptions.push(
    vscode.languages.registerRenameProvider(
      [
        { language: 'javascript' },
        { language: 'typescript' },
        { language: 'javascriptreact' },
        { language: 'typescriptreact' },
        { language: 'css' },
      ],
      new CssBridgeRenameProvider()
    )
  );

  // Autocomplete — JSX/TSX: suggest selectors from imported CSS files
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      DOC_SELECTOR,
      new JsxCompletionProvider(),
      '"', "'"
    )
  );

  // Autocomplete — CSS: suggest class/id names from JSX/TSX/JS/TS files in workspace
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: 'css' },
      new CssCompletionProvider(),
      '.', '#'
    )
  );

  // Hover — preview matching CSS rule body inside JSX/TSX without opening a tab
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      DOC_SELECTOR,
      new CssBridgeHoverProvider()
    )
  );

  // Show Output Log — surfaces the same channel `out` writes to
  context.subscriptions.push(
    vscode.commands.registerCommand('cssBridge.showOutput', () => {
      out.show(true);
    })
  );

  // Diagnose — dump everything the extension would use for the active editor.
  // Mirrors roseline's `diagnose` command: gives users a single button to paste
  // when reporting bugs ("F12 doesn't jump"), and short-circuits speculation
  // about whether scope/alias/workspace-union/cache are working.
  //
  // Two flavours:
  //   - Full   (manual via Cmd Palette) — also scans workspace for tsconfig/jsconfig/package.json
  //   - Quick  (auto on editor change)  — only the per-file context, no findFiles
  context.subscriptions.push(
    vscode.commands.registerCommand('cssBridge.diagnose', async () => {
      await runDiagnose({ full: true });
    })
  );

  // Auto-quick-diagnose on editor change. Off by default — opt-in via setting
  // for users actively debugging. No findFiles → ~5ms cost, safe for typical
  // tab-switching cadence.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async editor => {
      if (!editor) return;
      const cfg = vscode.workspace.getConfiguration('cssBridge');
      if (!cfg.get<boolean>('autoDiagnoseOnEditorChange', false)) return;
      const lang = editor.document.languageId;
      // Only fire for files we actually act on — avoids noise when bouncing
      // through Settings, Output, Markdown previews, etc.
      const supported = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'css'];
      if (!supported.includes(lang)) return;
      await runDiagnose({ full: false, editor });
    })
  );

  // Invalidate CSS cache when files change
  const cssWatcher = vscode.workspace.createFileSystemWatcher('**/*.css');
  context.subscriptions.push(
    cssWatcher,
    cssWatcher.onDidChange(uri => invalidateCache(uri.fsPath)),
    cssWatcher.onDidDelete(uri => invalidateCache(uri.fsPath)),
  );

  // Invalidate JSX/TS import cache when source files change. Workspace CSS
  // cache uses fingerprint (mtime+count) so it self-heals on next call —
  // we still nuke it on file create/delete to skip the recompute on first hit.
  const jsxWatcher = vscode.workspace.createFileSystemWatcher('**/*.{js,ts,jsx,tsx}');
  context.subscriptions.push(
    jsxWatcher,
    jsxWatcher.onDidChange(uri => invalidateImportCache(uri.fsPath)),
    jsxWatcher.onDidDelete(uri => {
      invalidateImportCache(uri.fsPath);
      invalidateWorkspaceCssCache();
    }),
    jsxWatcher.onDidCreate(() => invalidateWorkspaceCssCache()),
  );
}

export function deactivate() {}

interface DiagnoseOpts {
  full: boolean;
  editor?: vscode.TextEditor;
}

async function runDiagnose(opts: DiagnoseOpts): Promise<void> {
  const tag = opts.full ? 'DIAGNOSE' : 'AUTO-DIAGNOSE';
  out.show(true);
  out.appendLine(`─── ${tag} START ───────────────────────────────────────`);

  if (opts.full) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    out.appendLine(`Workspace folders (${folders.length}):`);
    for (const f of folders) out.appendLine(`  • ${f.name} → ${f.uri.fsPath}`);

    const tsUris  = await vscode.workspace.findFiles('**/tsconfig.json',  '**/node_modules/**');
    const jsUris  = await vscode.workspace.findFiles('**/jsconfig.json',  '**/node_modules/**');
    const pkgUris = await vscode.workspace.findFiles('**/package.json',   '**/node_modules/**');
    out.appendLine(`\ntsconfig.json (${tsUris.length}):`);
    for (const u of tsUris) out.appendLine(`  • ${u.fsPath}`);
    out.appendLine(`jsconfig.json (${jsUris.length}):`);
    for (const u of jsUris) out.appendLine(`  • ${u.fsPath}`);
    out.appendLine(`package.json (${pkgUris.length}):`);
    for (const u of pkgUris) out.appendLine(`  • ${u.fsPath}`);
  }

  const editor =
    opts.editor ??
    vscode.window.activeTextEditor ??
    vscode.window.visibleTextEditors.find(e => !e.document.isUntitled);
  const activeFp = editor?.document.uri.fsPath;
  out.appendLine(`\nActive editor: ${activeFp ?? '(none — open a JSX/TSX/CSS file and re-run for full context)'}`);

  if (editor && activeFp) {
    const scope = findScopeBoundary(activeFp);
    out.appendLine(`  scope (project boundary): ${scope}`);

    const tsconfig = findNearestTsConfig(activeFp);
    out.appendLine(`  nearest tsconfig dir    : ${tsconfig.configDir}`);
    out.appendLine(`  baseUrl                 : ${tsconfig.baseUrl ?? '(none)'}`);
    out.appendLine(`  paths aliases           : ${tsconfig.paths ? JSON.stringify(tsconfig.paths) : '(none)'}`);

    const direct = resolveCssImports(activeFp);
    out.appendLine(`\n  Direct CSS imports (${direct.length}):`);
    for (const f of direct) out.appendLine(`    - ${f}`);

    const config = vscode.workspace.getConfiguration('cssBridge');
    const includeWs = config.get<boolean>('includeWorkspaceCss', true);
    out.appendLine(`\n  cssBridge.includeWorkspaceCss = ${includeWs}`);
    if (opts.full) {
      out.appendLine(`  cssBridge.openLocation       = ${config.get<string>('openLocation', 'beside')}`);
      out.appendLine(`  cssBridge.autoCreateImport   = ${config.get<boolean>('autoCreateImport', true)}`);
      out.appendLine(`  cssBridge.verboseLogging     = ${config.get<boolean>('verboseLogging', false)}`);
    }

    if (includeWs) {
      const wsCss = resolveWorkspaceCss(activeFp);
      const extra = wsCss.filter(f => !direct.includes(f));
      out.appendLine(`\n  Workspace CSS pool (${wsCss.length} total, ${extra.length} extra beyond direct):`);
      for (const f of extra) out.appendLine(`    - ${f}`);
    }

    const attr = getAttributeAtCursor(editor.document, editor.selection.active);
    out.appendLine(`\n  Cursor at ${editor.selection.active.line}:${editor.selection.active.character}`);
    out.appendLine(`  Detected attribute: ${attr ? `${attr.type}="${attr.value}"` : '(none — not on a className/id token)'}`);

    if (attr) {
      const allCss = includeWs ? resolveWorkspaceCss(activeFp) : direct;
      const hits: string[] = [];
      for (const cssFile of allCss) {
        for (const sel of parseSelectors(cssFile)) {
          if (sel.type === attr.type && sel.rawName === attr.value) {
            hits.push(`${cssFile}:${sel.line}`);
          }
        }
      }
      out.appendLine(`  Matching CSS rules (${hits.length}):`);
      for (const h of hits) out.appendLine(`    - ${h}`);
    }
  }

  out.appendLine(`─── ${tag} END ─────────────────────────────────────────\n`);
}
