import * as fs from 'fs';
import * as path from 'path';

export function findScopeBoundary(filePath: string): string {
  let dir = path.dirname(filePath);
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return path.dirname(filePath);
}

// Walk dir recursively, collecting files with the given extensions.
// Stops descending into nested package boundaries (sub-projects) and node_modules.
export function globFiles(dir: string, exts: string[]): string[] {
  const results: string[] = [];

  function walk(current: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Don't cross into a nested package boundary
        if (full !== dir && fs.existsSync(path.join(full, 'package.json'))) continue;
        walk(full);
      } else if (exts.includes(path.extname(entry.name))) {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}
