import * as vscode from 'vscode';
import { stripComments } from '../utils/stripComments';
import { indexJsxText, findTokenAtOffset } from './jsxClassIndex';

export interface AttributeInfo {
  type: 'class' | 'id';
  value: string;       // the specific token at cursor e.g. "btn-primary"
  range: vscode.Range; // range of that token in the document
  /**
   * Where the token came from. Surfaced so providers (Diagnose, verbose log)
   * can distinguish the cheap regex hit from the AST-fallback that handles
   * `className={...}` and `clsx(...)`.
   */
  source: 'attr-string' | 'attr-expr' | 'helper';
}

/**
 * Cache the per-document AST walk so providers (hover, definition, rename,
 * codeAction) called on every cursor move don't re-parse the active buffer
 * on every keystroke. Keyed by file path; the cached entry tracks both the
 * doc version and the wall-clock time of the parse so we can short-circuit
 * during fast typing.
 */
const liveDocCache = new Map<
  string,
  { version: number; tokens: ReturnType<typeof indexJsxText>; parsedAt: number }
>();

// Floor between live parses. While typing fires codeAction on every keystroke,
// the doc version bumps each time and would otherwise cause a re-parse per
// character. 80 ms ≈ 12 parses/second cap; results are at most 80 ms stale,
// well under human perception for hover/F12 latency.
const LIVE_PARSE_THROTTLE_MS = 80;

function getLiveTokens(document: vscode.TextDocument) {
  const key = document.uri.fsPath;
  const cached = liveDocCache.get(key);
  const now = Date.now();

  if (cached) {
    // Same version — content is identical, cache is canonical.
    if (cached.version === document.version) return cached.tokens;
    // Newer version but we just parsed — return last tokens (slightly stale).
    // The next request after the throttle window expires will catch up.
    if (now - cached.parsedAt < LIVE_PARSE_THROTTLE_MS) return cached.tokens;
  }

  const tokens = indexJsxText(document.getText());
  liveDocCache.set(key, { version: document.version, tokens, parsedAt: now });
  return tokens;
}

export function invalidateLiveDocCache(filePath: string): void {
  liveDocCache.delete(filePath);
}

/**
 * Force a parse of the document and seed the live cache, so the next cursor
 * lookup inside a `className={...}` or `clsx(...)` doesn't pay the Babel cost
 * inline. Call from `onDidOpenTextDocument` (and once at activation, for
 * editors already open) — the parse is non-blocking either way because the
 * caller schedules it via `setImmediate`.
 */
export function prewarmLiveDocCache(document: vscode.TextDocument): void {
  if (document.uri.scheme !== 'file') return;
  const key = document.uri.fsPath;
  const cached = liveDocCache.get(key);
  if (cached && cached.version === document.version) return;
  const tokens = indexJsxText(document.getText());
  liveDocCache.set(key, { version: document.version, tokens, parsedAt: Date.now() });
}

export interface GetAttributeOptions {
  /**
   * Skip the @babel/parser fallback when set. Intended for keystroke-frequent
   * callers (codeAction's lightbulb) where paying a parse on every cursor
   * move inside `className={...}` would visibly drag typing. Hover, F12, and
   * Rename all leave this off — they're explicit user actions and a one-time
   * parse is acceptable.
   */
  fastOnly?: boolean;
}

export function getAttributeAtCursor(
  document: vscode.TextDocument,
  position: vscode.Position,
  options: GetAttributeOptions = {}
): AttributeInfo | null {
  // ── Fast path ────────────────────────────────────────────────────────────
  // 99% of className lookups happen inside `className="..."`. The regex below
  // catches that without touching @babel/parser, keeping keystroke-frequent
  // events (codeAction lightbulb, hover) snappy on big files.
  const fast = getAttributeAtCursorFast(document, position);
  if (fast) return fast;

  if (options.fastOnly) return null;

  // ── AST fallback ─────────────────────────────────────────────────────────
  // Cursor is somewhere a regex couldn't classify — typically inside
  // `className={...}` or a `clsx(...)` call argument. Pay one Babel parse
  // (cached by document.version + 80 ms throttle) to find the enclosing
  // string literal.
  const offset = document.offsetAt(position);
  const tokens = getLiveTokens(document);
  const hit = findTokenAtOffset(tokens, offset);
  if (!hit) return null;

  return {
    type: hit.type,
    value: hit.value,
    range: new vscode.Range(
      document.positionAt(hit.start),
      document.positionAt(hit.end),
    ),
    source: hit.source,
  };
}

/**
 * Original v1.0/v1.1 detection: regex over the current line context. Fast,
 * allocation-light, but only fires on `className="..."` / `id="..."` shaped
 * source. Returns null for anything dynamic.
 */
function getAttributeAtCursorFast(
  document: vscode.TextDocument,
  position: vscode.Position
): AttributeInfo | null {
  const wordRange = document.getWordRangeAtPosition(position, /[\w-]+/);
  if (!wordRange) return null;
  const word = document.getText(wordRange);

  // Strip comments on the full document first so an unclosed block comment
  // before the cursor still gets blanked, then take the slice up to cursor.
  // 10-line backward window keeps the regex test cheap on huge files.
  const cursorOffset = document.offsetAt(position);
  const stripped = stripComments(document.getText());
  const searchStart = Math.max(0, position.line - 10);
  const startOffset = document.offsetAt(new vscode.Position(searchStart, 0));
  const textBefore = stripped.substring(startOffset, cursorOffset);

  // Check if cursor is inside className="..." or id="..."
  // The pattern ensures no closing quote exists between the opening quote and cursor.
  // Lookbehind (?<![\w-]) prevents false-positives like myClassName=, data-id=, aria-id=.
  const classMatch = /(?<![\w-])className\s*=\s*["']([^"']*)$/.test(textBefore);
  const idMatch = /(?<![\w-])id\s*=\s*["']([^"']*)$/.test(textBefore);

  if (classMatch) {
    return { type: 'class', value: word, range: wordRange, source: 'attr-string' };
  }
  if (idMatch) {
    return { type: 'id', value: word, range: wordRange, source: 'attr-string' };
  }

  return null;
}
