// Smoke test for shape assumptions used by parseVars (cssParser.ts).
// Verifies postcss + the use-regex behave the way the TypeScript code expects,
// BEFORE we ship — same role as smokeIndex.js for v1.2.
//
// Run with: node scripts/smokeVars.js

const postcss = require('postcss');

// ── helpers re-implemented to mirror parseVars ─────────────────────────────
function stripCssBlockComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
}

function parseVarsFromString(content) {
  const defs = [];
  const uses = [];

  try {
    const root = postcss.parse(content);
    root.walkDecls(/^--/, decl => {
      const name = decl.prop.slice(2);
      const parent = decl.parent;
      const selector = parent && parent.type === 'rule' ? parent.selector.trim() : '(unknown)';
      defs.push({ name, value: decl.value, selector });
    });
  } catch {
    /* swallow */
  }

  const stripped = stripCssBlockComments(content);
  const useRegex = /\bvar\(\s*--([\w-]+)/g;
  let m;
  while ((m = useRegex.exec(stripped)) !== null) {
    uses.push({ name: m[1] });
  }

  return { defs, uses };
}

// ── cases ──────────────────────────────────────────────────────────────────
const cases = [
  {
    name: 'single :root def',
    css: ':root { --primary: #0066cc; }',
    expectDefs: [{ name: 'primary', value: '#0066cc', selector: ':root' }],
    expectUses: [],
  },
  {
    name: 'multi-theme (:root + .theme-dark)',
    css: ':root { --primary: #0066cc; }\n.theme-dark { --primary: #5599ff; }',
    expectDefs: [
      { name: 'primary', value: '#0066cc', selector: ':root' },
      { name: 'primary', value: '#5599ff', selector: '.theme-dark' },
    ],
    expectUses: [],
  },
  {
    name: 'use without fallback',
    css: '.box { color: var(--primary); }',
    expectDefs: [],
    expectUses: [{ name: 'primary' }],
  },
  {
    name: 'use with fallback value',
    css: '.box { color: var(--primary, blue); }',
    expectDefs: [],
    expectUses: [{ name: 'primary' }],
  },
  {
    name: 'nested var (outer + inner both detected)',
    css: '.box { color: var(--primary, var(--fallback)); }',
    expectDefs: [],
    expectUses: [{ name: 'primary' }, { name: 'fallback' }],
  },
  {
    name: 'block comment strips var() inside',
    css: '/* var(--ghost) */\n.box { color: var(--primary); }',
    expectDefs: [],
    expectUses: [{ name: 'primary' }],
  },
  {
    name: 'local def + use in same rule',
    css: '.alert { --tone: #c00; background: var(--tone); }',
    expectDefs: [{ name: 'tone', value: '#c00', selector: '.alert' }],
    expectUses: [{ name: 'tone' }],
  },
  {
    name: 'def with no use (count = 1 def, 0 uses)',
    css: ':root { --orphan: 12px; }',
    expectDefs: [{ name: 'orphan', value: '12px', selector: ':root' }],
    expectUses: [],
  },
  {
    name: 'whitespace inside var( --foo )',
    css: '.box { color: var( --foo ); }',
    expectDefs: [],
    expectUses: [{ name: 'foo' }],
  },
  {
    name: 'multiple var() on one line',
    css: '.box { margin: var(--a) var(--b); }',
    expectDefs: [],
    expectUses: [{ name: 'a' }, { name: 'b' }],
  },
  {
    name: 'kebab-case var name',
    css: ':root { --primary-color: red; } .x { color: var(--primary-color); }',
    expectDefs: [{ name: 'primary-color', value: 'red', selector: ':root' }],
    expectUses: [{ name: 'primary-color' }],
  },
  {
    name: '@media wrapping :root — selector still ":root"',
    css: '@media (prefers-color-scheme: dark) { :root { --primary: #fff; } }',
    expectDefs: [{ name: 'primary', value: '#fff', selector: ':root' }],
    expectUses: [],
  },
  {
    name: 'multiline var( newline --foo )',
    css: '.box { color: var(\n  --multi\n); }',
    expectDefs: [],
    expectUses: [{ name: 'multi' }],
  },
];

// ── runner ─────────────────────────────────────────────────────────────────
function eqDefs(got, exp) {
  if (got.length !== exp.length) return false;
  for (let i = 0; i < got.length; i++) {
    const a = got[i], b = exp[i];
    if (a.name !== b.name || a.value !== b.value || a.selector !== b.selector) return false;
  }
  return true;
}
function eqUses(got, exp) {
  if (got.length !== exp.length) return false;
  for (let i = 0; i < got.length; i++) {
    if (got[i].name !== exp[i].name) return false;
  }
  return true;
}

let pass = 0, fail = 0;
for (const c of cases) {
  const { defs, uses } = parseVarsFromString(c.css);
  const ok = eqDefs(defs, c.expectDefs) && eqUses(uses, c.expectUses);
  if (ok) {
    pass++;
    console.log(`✅ ${c.name}`);
  } else {
    fail++;
    console.log(`❌ ${c.name}`);
    console.log(`   css:        ${JSON.stringify(c.css)}`);
    console.log(`   expectDefs: ${JSON.stringify(c.expectDefs)}`);
    console.log(`   gotDefs:    ${JSON.stringify(defs)}`);
    console.log(`   expectUses: ${JSON.stringify(c.expectUses)}`);
    console.log(`   gotUses:    ${JSON.stringify(uses)}`);
  }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
