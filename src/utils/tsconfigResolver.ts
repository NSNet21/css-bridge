// Tsconfig path-alias resolver — adapted from `roseline` extension
// (e:/Vscode PJ/AI AGENT Work Space/Component Navigator/roseline/src/tsconfig-resolver.ts)
//
// Walks up from a source file looking for the nearest project boundary, reading
// `tsconfig.json` / `jsconfig.json` to extract `baseUrl` + `paths`. Used to
// resolve aliased CSS imports like `import '@/styles/globals.css'` so CSS Bridge
// can navigate to them the same as relative imports.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface TsConfigInfo {
  configDir: string;
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

const BUILD_TOOL_CONFIGS = [
  'vite.config.js',  'vite.config.ts',  'vite.config.mjs',  'vite.config.cjs',
  'next.config.js',  'next.config.ts',  'next.config.mjs',
  'remix.config.js', 'remix.config.mjs',
  'rsbuild.config.js', 'rsbuild.config.ts',
  'webpack.config.js', 'webpack.config.ts',
];

function isWorkspaceFolder(dir: string): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some(
    f => f.uri.fsPath === dir
  );
}

/**
 * Walk up from `filePath` looking for the nearest project boundary.
 * Resolution order at each directory:
 *   1. tsconfig.json — full alias support
 *   2. jsconfig.json — same shape as tsconfig
 *   3. package.json / build-tool config / workspace folder root — boundary only,
 *      relative imports still work, no alias config available
 * Hard-stops on workspace folder root so we never walk past the user's project.
 */
export function findNearestTsConfig(filePath: string): TsConfigInfo {
  let dir = path.dirname(filePath);
  while (true) {
    const ts = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(ts)) return readAliasConfig(ts, dir);

    const js = path.join(dir, 'jsconfig.json');
    if (fs.existsSync(js)) return readAliasConfig(js, dir);

    if (
      fs.existsSync(path.join(dir, 'package.json')) ||
      BUILD_TOOL_CONFIGS.some(cfg => fs.existsSync(path.join(dir, cfg)))
    ) {
      return { configDir: dir };
    }

    if (isWorkspaceFolder(dir)) return { configDir: dir };

    const parent = path.dirname(dir);
    if (parent === dir) return { configDir: dir };
    dir = parent;
  }
}

function readAliasConfig(configPath: string, dir: string): TsConfigInfo {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    // Try plain JSON first — covers the 99% case where tsconfig has no
    // comments. Avoids tripping the JSONC stripper on glob patterns like
    // `"include": ["src/**/*"]` whose `**/*` looks identical to a comment
    // close (`*/`) when we're not string-aware.
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      json = JSON.parse(stripJsonc(raw));
    }
    const opts = json.compilerOptions ?? {};
    const baseUrl = opts.baseUrl ? path.resolve(dir, opts.baseUrl) : dir;
    return { configDir: dir, baseUrl, paths: opts.paths };
  } catch {
    return { configDir: dir };
  }
}

/**
 * String-aware JSONC stripper. Skips comment patterns inside string literals
 * so glob values (`"src/**\/*"`) and aliases containing `/*` survive intact.
 *
 * Replaced an earlier naive `replace` chain that ate everything between the
 * first `/*` (in `"@/*"`) and the next `*\/` (inside `"src/**\/*"`),
 * collapsing the whole compilerOptions block into garbage.
 */
function stripJsonc(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // String literal — copy verbatim until closing quote, honouring escapes
    if (c === '"') {
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\' && i + 1 < src.length) {
          out += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    // Block comment
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    // Line comment
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i + 2);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    out += c;
    i++;
  }
  // Trailing commas
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Resolve an import specifier to an absolute filesystem path.
 *   - Relative imports (`./foo`, `../bar/baz`) → resolve from `fromFile` dir
 *   - Aliased imports matching `paths` → expand using config
 *   - Bare imports with `baseUrl` → resolve from baseUrl
 *   - Otherwise return as-is (caller handles non-existence)
 *
 * Returns the resolved path WITHOUT extension — caller appends `.css` etc.
 */
export function resolveImportPath(
  importPath: string,
  fromFile: string,
  config: TsConfigInfo
): string {
  if (importPath.startsWith('.')) {
    return path.resolve(path.dirname(fromFile), importPath);
  }

  if (config.paths) {
    for (const [alias, targets] of Object.entries(config.paths)) {
      if (alias.endsWith('/*')) {
        const prefix = alias.slice(0, -2);
        if (importPath.startsWith(prefix + '/')) {
          const rest = importPath.slice(prefix.length + 1);
          const targetBase = targets[0].replace(/\/\*$/, '');
          return path.resolve(config.baseUrl ?? config.configDir, targetBase, rest);
        }
      } else if (importPath === alias) {
        return path.resolve(config.baseUrl ?? config.configDir, targets[0]);
      }
    }
  }

  if (config.baseUrl) {
    return path.resolve(config.baseUrl, importPath);
  }

  return importPath;
}
