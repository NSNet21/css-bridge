import * as vscode from 'vscode';
import { stripComments } from '../utils/stripComments';

export interface AttributeInfo {
  type: 'class' | 'id';
  value: string;       // the specific token at cursor e.g. "btn-primary"
  range: vscode.Range; // range of that token in the document
}

export function getAttributeAtCursor(
  document: vscode.TextDocument,
  position: vscode.Position
): AttributeInfo | null {
  const wordRange = document.getWordRangeAtPosition(position, /[\w-]+/);
  if (!wordRange) {
    return null;
  }
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
    return { type: 'class', value: word, range: wordRange };
  }
  if (idMatch) {
    return { type: 'id', value: word, range: wordRange };
  }

  return null;
}
