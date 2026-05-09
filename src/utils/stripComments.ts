// Replace JS / JSX comments with same-length whitespace so that regex scans
// don't match attribute-looking text inside comments, while preserving every
// byte offset (line/column positions stay valid for vscode.Position math).
//
// Handles:
//   - Line comments      // ...
//   - Block comments     /* ... */
//   - JSX block comments {/* ... */}  (the inner /* */ is caught by the block rule;
//                                       the outer braces are left alone)
//
// Not handled (acceptable trade-off for an attribute-regex scan):
//   - Comment-like sequences inside string/template literals are also blanked.
//     False-negative is fine — we only blank, never insert content.
export function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  out = out.replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
  return out;
}
