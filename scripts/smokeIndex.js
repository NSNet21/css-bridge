// Smoke test for AST shape assumptions used by jsxClassIndex.ts.
// Verifies @babel/parser produces the node shapes our walker expects, BEFORE
// we ship — saves a round-trip through F5 if something is off.
//
// Run with: node scripts/smokeIndex.js

const { parse } = require('@babel/parser');
const traverseDefault = require('@babel/traverse');
const traverse = traverseDefault.default || traverseDefault;

const cases = [
  {
    name: 'plain className=""',
    code: '<div className="foo bar"/>',
    expect: ['foo', 'bar'],
  },
  {
    name: 'template literal',
    code: '<div className={`btn btn-${size}`}/>',
    expect: ['btn', 'btn-'],
  },
  {
    name: 'template mixed with ternary',
    code: '<div className={`base ${active ? "is-active" : ""}`}/>',
    expect: ['base', 'is-active'],
  },
  {
    name: 'logical AND',
    code: '<div className={isActive && "active"}/>',
    expect: ['active'],
  },
  {
    name: 'logical OR — both branches yield',
    code: '<div className={"a" || "b"}/>',
    expect: ['a', 'b'],
  },
  {
    name: 'ternary',
    code: '<div className={open ? "menu-open" : "menu-closed"}/>',
    expect: ['menu-open', 'menu-closed'],
  },
  {
    name: 'string concat',
    code: '<div className={"a-" + size}/>',
    expect: ['a-'],
  },
  {
    name: 'clsx string args',
    code: '<div className={clsx("btn", "active")}/>',
    expect: ['btn', 'active'],
  },
  {
    name: 'clsx object form',
    code: '<div className={clsx({ "btn-active": flag, btnDisabled: x })}/>',
    expect: ['btn-active', 'btnDisabled'],
  },
  {
    name: 'clsx array form',
    code: '<div className={clsx(["a", "b"])}/>',
    expect: ['a', 'b'],
  },
  {
    name: 'cn helper alias',
    code: '<div className={cn("btn", isActive && "btn-active")}/>',
    expect: ['btn', 'btn-active'],
  },
  {
    name: 'non-helper call ignored',
    code: '<div className={someOther("foo")}/>',
    expect: [],  // CallExpression with non-helper callee → no extraction
  },
  {
    name: 'id attribute',
    code: '<div id="root"/>',
    expect: ['root'],
  },
  {
    name: 'TS as const',
    code: '<div className={"foo" as const}/>',
    expect: ['foo'],
  },
];

const HELPERS = ['clsx', 'classnames', 'cn', 'cx', 'twMerge'];

function isWs(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f'; }

function pushTokensFromRaw(raw, out) {
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && isWs(raw[i])) i++;
    const s = i;
    while (i < raw.length && !isWs(raw[i])) i++;
    if (i > s) out.push(raw.slice(s, i));
  }
}

function extractFromExpression(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'StringLiteral':
      pushTokensFromRaw(node.value, out);
      return;
    case 'TemplateLiteral':
      for (const q of node.quasis) pushTokensFromRaw(q.value.raw, out);
      for (const e of node.expressions) extractFromExpression(e, out);
      return;
    case 'ConditionalExpression':
      extractFromExpression(node.consequent, out);
      extractFromExpression(node.alternate, out);
      return;
    case 'LogicalExpression':
      if (node.operator === '&&') extractFromExpression(node.right, out);
      else { extractFromExpression(node.left, out); extractFromExpression(node.right, out); }
      return;
    case 'BinaryExpression':
      if (node.operator === '+') {
        extractFromExpression(node.left, out);
        extractFromExpression(node.right, out);
      }
      return;
    case 'ArrayExpression':
      for (const el of node.elements) {
        if (el && el.type !== 'SpreadElement') extractFromExpression(el, out);
      }
      return;
    case 'ObjectExpression':
      for (const p of node.properties) {
        if (p.type !== 'ObjectProperty' || p.computed) continue;
        if (p.key.type === 'StringLiteral') pushTokensFromRaw(p.key.value, out);
        else if (p.key.type === 'Identifier') out.push(p.key.name);
      }
      return;
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSTypeAssertion':
    case 'TSSatisfiesExpression':
    case 'ParenthesizedExpression':
      extractFromExpression(node.expression, out);
      return;
  }
}

function index(code) {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true });
  const out = [];
  traverse(ast, {
    JSXAttribute(path) {
      if (path.node.name.type !== 'JSXIdentifier') return;
      if (!['className', 'id'].includes(path.node.name.name)) return;
      const v = path.node.value;
      if (!v) return;
      if (v.type === 'StringLiteral') pushTokensFromRaw(v.value, out);
      else if (v.type === 'JSXExpressionContainer' && v.expression.type !== 'JSXEmptyExpression') {
        extractFromExpression(v.expression, out);
      }
    },
    CallExpression(path) {
      const c = path.node.callee;
      let n = null;
      if (c.type === 'Identifier') n = c.name;
      else if (c.type === 'MemberExpression' && c.property.type === 'Identifier' && !c.computed) n = c.property.name;
      if (!n || !HELPERS.includes(n)) return;
      for (const a of path.node.arguments) {
        if (a.type !== 'SpreadElement') extractFromExpression(a, out);
      }
    },
  });
  return out;
}

let pass = 0, fail = 0;
for (const c of cases) {
  const got = index(c.code);
  const ok = got.length === c.expect.length && got.every((v, i) => v === c.expect[i]);
  if (ok) {
    pass++;
    console.log(`✅ ${c.name}`);
  } else {
    fail++;
    console.log(`❌ ${c.name}`);
    console.log(`   code:     ${c.code}`);
    console.log(`   expected: ${JSON.stringify(c.expect)}`);
    console.log(`   got:      ${JSON.stringify(got)}`);
  }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
