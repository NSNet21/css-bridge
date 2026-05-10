import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getAttributeAtCursor } from '../parsers/jsxParser';
import { findCssLocations } from '../utils/findLocations';
import { getCssVarAtCursor, findVarUseLocations } from './definition';
import { parseVars } from '../parsers/cssParser';
import { findScopeBoundary, globFiles } from '../utils/scopeBoundary';
import { logV } from '../extension';

/**
 * Hover preview — show the matching CSS rule body in a tooltip without
 * stealing focus or opening another tab. Reuses `findCssLocations`, so it
 * inherits direct-import-first / workspace-fallback behavior automatically.
 *
 * Multi-match: render every matching rule, headed with the source filename.
 */
export class CssBridgeHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | null {
    const attr = getAttributeAtCursor(document, position);
    logV(`[hover] pos=${position.line}:${position.character} attr=${JSON.stringify(attr)}`);
    if (!attr) return null;

    const locations = findCssLocations(document, attr);
    logV(`[hover] found ${locations.length} location(s)`);
    if (locations.length === 0) return null;

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    for (const loc of locations) {
      const body = readRuleBody(loc.uri.fsPath, loc.range.start.line);
      if (!body) continue;
      md.appendMarkdown(`**${path.basename(loc.uri.fsPath)}** &middot; line ${loc.range.start.line + 1}\n`);
      md.appendCodeblock(body, 'css');
    }
    if (md.value.length === 0) return null;

    return new vscode.Hover(md, attr.range);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// v1.3.0: CSS-side hover for `var(--foo)` and `--foo:` definitions.
// ───────────────────────────────────────────────────────────────────────────
// Registered on `language: 'css'` only — JSX hover above is unchanged.
//
// On a *use* (`var(--foo)`) we list every definition we can see in scope so
// users can spot multi-theme overrides at a glance (e.g. `:root` light vs
// `.theme-dark`). On a *def* we summarize how many places consume it — useful
// for "is this var actually used anywhere?" grep-replacement.

const HOVER_USE_LIMIT = 8;

export class CssBridgeCssHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | null {
    const cssVar = getCssVarAtCursor(document, position);
    logV(`[hover-css] pos=${position.line}:${position.character} var=${JSON.stringify(cssVar)}`);
    if (!cssVar) return null;

    if (cssVar.type === 'var-use') {
      const matches = collectVarDefs(document.fileName, cssVar.name);
      if (matches.length === 0) return null;

      const md = new vscode.MarkdownString();
      md.isTrusted = true;
      md.appendMarkdown(`**\`--${cssVar.name}\`** &middot; ${matches.length} definition${matches.length === 1 ? '' : 's'}\n\n`);
      for (const m of matches) {
        // Backticks around selector + value keep theme names like `.theme-dark`
        // and color codes readable in the markdown render.
        md.appendMarkdown(
          `- \`${m.selector}\` → \`${m.value}\` &middot; ${path.basename(m.filePath)}:${m.line}\n`
        );
      }
      return new vscode.Hover(md, cssVar.range);
    }

    // var-def: surface usage count + first few sites
    const uses = findVarUseLocations(document.fileName, cssVar.name);
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    if (uses.length === 0) {
      md.appendMarkdown(`**\`--${cssVar.name}\`** &middot; *no usages found in scope*`);
      return new vscode.Hover(md, cssVar.range);
    }
    md.appendMarkdown(`**\`--${cssVar.name}\`** &middot; used in ${uses.length} location${uses.length === 1 ? '' : 's'}\n\n`);
    const max = Math.min(uses.length, HOVER_USE_LIMIT);
    for (let i = 0; i < max; i++) {
      const u = uses[i];
      md.appendMarkdown(`- ${path.basename(u.uri.fsPath)}:${u.range.start.line + 1}\n`);
    }
    if (uses.length > max) {
      md.appendMarkdown(`- … (${uses.length - max} more)\n`);
    }
    return new vscode.Hover(md, cssVar.range);
  }
}

interface VarMatch {
  selector: string;
  value: string;
  filePath: string;
  line: number;
}

function collectVarDefs(cssFilePath: string, name: string): VarMatch[] {
  const scope = findScopeBoundary(cssFilePath);
  const files = globFiles(scope, ['.css']);
  const matches: VarMatch[] = [];
  for (const fp of files) {
    const { defs } = parseVars(fp);
    for (const d of defs) {
      if (d.name === name) {
        matches.push({ selector: d.selector, value: d.value, filePath: fp, line: d.line });
      }
    }
  }
  return matches;
}

/**
 * Read the rule starting at `selectorLine` and return the full text including
 * selector and braces. Stops at the closing `}` (depth-tracked so nested rules
 * inside `@media`/`@supports` survive).
 */
function readRuleBody(filePath: string, selectorLine: number): string | null {
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  } catch {
    return null;
  }
  if (selectorLine >= lines.length) return null;

  const collected: string[] = [];
  let depth = 0;
  let started = false;

  for (let i = selectorLine; i < lines.length; i++) {
    const line = lines[i];
    collected.push(line);
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') depth--;
    }
    if (started && depth === 0) break;
    // Safety: don't preview unreasonably long rules
    if (collected.length > 40) {
      collected.push('  /* ... truncated */');
      break;
    }
  }

  return collected.join('\n');
}
