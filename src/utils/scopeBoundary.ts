import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const BUILD_TOOL_CONFIGS = [
  'vite.config.js',  'vite.config.ts',  'vite.config.mjs',  'vite.config.cjs',
  'next.config.js',  'next.config.ts',  'next.config.mjs',
  'remix.config.js', 'remix.config.mjs',
  'rsbuild.config.js', 'rsbuild.config.ts',
  'webpack.config.js', 'webpack.config.ts',
];

function hasBuildToolConfig(dir: string): boolean {
  return BUILD_TOOL_CONFIGS.some(name => fs.existsSync(path.join(dir, name)));
}

function isProjectBoundary(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'tsconfig.json')) ||
    fs.existsSync(path.join(dir, 'jsconfig.json')) ||
    fs.existsSync(path.join(dir, 'package.json')) ||
    hasBuildToolConfig(dir)
  );
}

function getWorkspaceFolderRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
}

/**
 * Find the nearest project boundary directory walking up from a file.
 *
 * Boundary signals (any one):
 *   - tsconfig.json / jsconfig.json
 *   - package.json
 *   - Vite/Next/Remix/Rsbuild/Webpack config
 *
 * Hard-stops at a workspace folder root so we never walk into the user's whole
 * drive. Replaces the v1.0.x `findScopeBoundary` which only looked at package.json
 * — it missed Vite/Next monorepos where the leaf has tsconfig but the `react`
 * dep is hoisted upward by workspaces.
 *
 * Returns the boundary directory; if none is found before the workspace root,
 * returns the file's own directory (defensive — keeps callers working on
 * out-of-workspace files, e.g. opened via Open Recent).
 */
export function findScopeBoundary(filePath: string): string {
  let dir = path.dirname(filePath);
  const wsRoots = getWorkspaceFolderRoots();
  const fsRoot = path.parse(dir).root;

  while (true) {
    if (isProjectBoundary(dir)) return dir;
    if (wsRoots.includes(dir)) return dir;
    if (dir === fsRoot) return path.dirname(filePath);

    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(filePath);
    dir = parent;
  }
}

/**
 * Walk dir recursively, collecting files with the given extensions.
 * Stops descending into nested project boundaries (sub-projects) and node_modules.
 *
 * "Nested boundary" matches whatever `findScopeBoundary` recognises — so a child
 * dir with its own tsconfig, jsconfig, package.json, or build-tool config carves
 * out its own scope and is excluded from the parent's results.
 */
export function globFiles(dir: string, exts: string[]): string[] {
  const results: string[] = [];

  function walk(current: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Don't cross into a nested project boundary
        if (full !== dir && isProjectBoundary(full)) continue;
        walk(full);
      } else if (exts.includes(path.extname(entry.name))) {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}
