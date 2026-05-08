import * as vscode from 'vscode';
import { getAttributeAtCursor } from '../parsers/jsxParser';
import { findCssLocations } from '../utils/findLocations';
import { out } from '../extension';

export class CssBridgeDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Definition | null {
    const attr = getAttributeAtCursor(document, position);
    out.appendLine(`[definition] pos=${position.line}:${position.character} attr=${JSON.stringify(attr)}`);
    if (!attr) return null;

    const locations = findCssLocations(document, attr);
    out.appendLine(`[definition] found ${locations.length} location(s)`);
    if (locations.length === 0) return null;

    return locations;
  }
}
