import * as fs from 'fs';
import * as path from 'path';
import { parse } from '@babel/parser';

export function resolveCssImports(filePath: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  let ast;
  try {
    ast = parse(content, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
    });
  } catch {
    return [];
  }

  const dir = path.dirname(filePath);
  const cssFiles: string[] = [];

  for (const node of ast.program.body) {
    if (
      node.type === 'ImportDeclaration' &&
      node.source.value.endsWith('.css')
    ) {
      const resolved = path.resolve(dir, node.source.value);
      cssFiles.push(resolved);
    }
  }

  return cssFiles;
}
