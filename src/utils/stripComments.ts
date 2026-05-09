// Replace JS / JSX comments with same-length whitespace so that regex scans
// don't match attribute-looking text inside comments, while preserving every
// byte offset (line/column positions stay valid for vscode.Position math).
//
// Handles:
//   - Line comments      // ...
//   - Block comments     /* ... */
//   - JSX block comments {/* ... */}
//
// Crucially, this scanner is **string-aware** — `/*` inside a string literal
// (e.g. `'@styles/*'`, `'src/**\/*'`, `"foo /* bar"`) is not treated as a
// comment opener. The naive regex `/\/\*[\s\S]*?\*\//g` ate everything from
// `'@styles/*'` (line 2) to `*/` of a real JSX comment (line 11), wiping out
// all the JSX in between including the className we wanted to detect.
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    // String / template literal — copy verbatim, honour escapes
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\' && i + 1 < n) {
          out += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }

    // Block comment — blank with spaces, keep newlines so line numbers stay
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let j = i; j < stop; j++) {
        out += src[j] === '\n' ? '\n' : ' ';
      }
      i = stop;
      continue;
    }

    // Line comment — blank to end of line, keep the trailing newline
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }

    out += c;
    i++;
  }
  return out;
}
