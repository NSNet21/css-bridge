import * as vscode from 'vscode';

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

  // Scan backwards from cursor (up to 10 lines) to find opening attribute
  const searchStart = Math.max(0, position.line - 10);
  let textBefore = '';
  for (let i = searchStart; i <= position.line; i++) {
    const line = document.lineAt(i).text;
    textBefore += i === position.line
      ? line.substring(0, position.character)
      : line + '\n';
  }

  // Check if cursor is inside className="..." or id="..."
  // The pattern ensures no closing quote exists between the opening quote and cursor
  const classMatch = /className\s*=\s*["']([^"']*)$/.test(textBefore);
  const idMatch = /\bid\s*=\s*["']([^"']*)$/.test(textBefore);

  if (classMatch) {
    return { type: 'class', value: word, range: wordRange };
  }
  if (idMatch) {
    return { type: 'id', value: word, range: wordRange };
  }

  return null;
}
