#!/usr/bin/env node
/*
 * extract_tools.js
 *
 * Builds lora-train/data/real_tools_all.json: a full inventory of every
 * tool/function the desktop-app's AI assistant can call, by statically
 * scanning renderer/src/floating-assistant.js as TEXT (never require()'d
 * or executed as the app itself — it's a huge Electron renderer file full
 * of DOM/window references).
 *
 * Tools are registered in this codebase in a few shapes:
 *
 *   1. Direct calls:    registerOptional('name', 'desc'/`desc`, fn, schema)
 *      (schema is a JSON-schema-like object: {type:'object', properties, required, ...})
 *      Sometimes the tool name is a ternary of two string literals, e.g.
 *        registerOptional(kind === 'edit-markdown' ? 'edit_markdown_open' : 'edit_text_open', ...)
 *
 *   2. Thin wrapper helpers defined locally inside a registration method and
 *      called many times with a literal name, e.g.
 *        const reg = (name, desc, fn, schema) => registerOptional(name, desc, wrap(fn), schema);
 *        reg('computer_list_windows', '...', fn, schema);
 *      There are several such wrappers (reg / tool / bcTool / open), each with
 *      its own parameter order, all ultimately forwarding to registerOptional.
 *
 *   3. Data-table driven loops: a plain-object table of tool definitions
 *      (keyed by tool name, carrying desc/props/required and sometimes an
 *      explicit `domain` field, e.g. sheet_set_cell / sheet_add_row), built by
 *      two small embedded UMD modules (TwVideoPlans, FaDocSemantics) that are
 *      inlined verbatim into floating-assistant.js. A forEach loop over
 *      Object.keys(TABLE) then calls registerOptional(name, t.desc, fn, {...})
 *      once per table entry.
 *
 * Strategy:
 *   - Parse the whole file with `acorn` (already a project devDependency) to
 *     get a real AST — far more reliable than regex for matching balanced
 *     parens/braces, template literals, regex literals, etc.
 *   - Collect every CallExpression whose callee is literally `registerOptional`
 *     (regardless of which closure's local parameter happens to be named that),
 *     directly extracting name/description/schema from literal arguments.
 *   - Discover any local "wrapper" variables (`const X = (...) => registerOptional(...)`)
 *     that ultimately forward to registerOptional, and resolve every call site
 *     of such wrappers by substituting the wrapper's formal parameters with the
 *     actual argument expressions from each call site (a small generic
 *     AST-literal evaluator: handles Literal/TemplateLiteral/Object/Array
 *     literals, ||/&&/?? and === / !== comparisons, ternaries, and inlines
 *     further local helper calls like `P(props, required)` the same way).
 *   - For the two data-table loops (`Object.keys(TOOLS).forEach(...)` /
 *     `Object.keys(DS.TOOLS).forEach(...)`), slice out the two self-contained
 *     embedded UMD modules by their exact top-level statement range and run
 *     them in a throwaway `vm` sandbox (no DOM/Electron globals touched — they
 *     are pure string/regex utility modules) to get the *real* TOOLS objects,
 *     then expand them into tool entries exactly the way the real registration
 *     loop does (same prop-description-defaulting, same schema shape).
 *
 * Output: lora-train/data/real_tools_all.json
 *   { total, by_source: {registerOptional, data_table}, unparsed: [...],
 *     tools: [{name, description, parameters, domain, heldout}, ...] }
 *
 * Held-out split mirrors the sibling project's scheme exactly:
 *   heldout = (parseInt(md5('rt:' + name).hex, 16) % 5 === 0)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const acorn = require('acorn');

const ROOT = path.resolve(__dirname, '..'); // desktop-app/
const SRC_PATH = path.join(ROOT, 'renderer', 'src', 'floating-assistant.js');
const OUT_DIR = path.join(__dirname, 'data');
const OUT_PATH = path.join(OUT_DIR, 'real_tools_all.json');

const unparsed = []; // {reason, detail, start, line}
const warnings = [];

function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

// ---------------------------------------------------------------------------
// Generic AST helpers
// ---------------------------------------------------------------------------

// Deep-collect every node anywhere under `root` (arrays/objects of nodes too)
// that satisfies `predicate`. Cheap generic walker: no visitor table needed
// since we only ever need "find all nodes of interest anywhere".
function collect(node, predicate, out) {
  out = out || [];
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, predicate, out);
    return out;
  }
  if (typeof node.type === 'string' && predicate(node)) out.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key === 'type') continue;
    const val = node[key];
    if (val && typeof val === 'object') collect(val, predicate, out);
  }
  return out;
}

function isUnresolved(v) {
  return !!(v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, '__unresolved'));
}

// ---------------------------------------------------------------------------
// Load + parse
// ---------------------------------------------------------------------------

console.error('[extract_tools] reading', SRC_PATH);
const src = fs.readFileSync(SRC_PATH, 'utf8');
console.error('[extract_tools] file size:', src.length, 'chars');

console.error('[extract_tools] parsing with acorn...');
const ast = acorn.parse(src, {
  ecmaVersion: 'latest',
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowHashBang: true,
});
console.error('[extract_tools] parsed OK,', ast.body.length, 'top-level statements');

// ---------------------------------------------------------------------------
// Pass 1: index "simple constant" declarations (var/const/let X = <literal-ish>)
// anywhere in the file, keyed by name. Used to resolve shorthand identifiers
// like `S`/`I`/`B` (JSON-schema type shortcuts) or named prop-schema snippets
// (winId / targetP / xy / tabIdProp / STR / TIME ...). When a name is declared
// more than once we pick, for a given use site, the declaration with the
// largest `start` that is still < the use site's `start` (nearest preceding
// declaration) since these are all locally/sequentially scoped in this file.
// ---------------------------------------------------------------------------
const constDefs = Object.create(null);
collect(ast, (n) =>
  n.type === 'VariableDeclarator' &&
  n.id.type === 'Identifier' &&
  n.init &&
  ['Literal', 'ObjectExpression', 'ArrayExpression', 'TemplateLiteral', 'UnaryExpression'].includes(n.init.type)
).forEach((n) => {
  (constDefs[n.id.name] = constDefs[n.id.name] || []).push({ start: n.start, node: n.init });
});

function nearestPreceding(list, beforeStart) {
  let best = null;
  for (const d of list) if (d.start < beforeStart && (!best || d.start > best.start)) best = d;
  return best;
}

// Which top-level Program statement (index into ast.body) contains offset `pos`?
// Used to keep wrapper-name resolution scoped to "the same top-level IIFE /
// class-method block", since several unrelated local helpers in this huge
// file happen to share a common name (e.g. a totally unrelated `open(...)`
// used for window/file handling elsewhere has nothing to do with the
// `open(kind, label)` tool-registration wrapper used in the edit-docs IIFE).
const topLevelStarts = ast.body.map((s) => s.start);
function topLevelIndexOf(pos) {
  // binary search for the last start <= pos
  let lo = 0, hi = topLevelStarts.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (topLevelStarts[mid] <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
function nearestPrecedingSameTopLevel(list, beforeStart) {
  const scope = topLevelIndexOf(beforeStart);
  let best = null;
  for (const d of list) {
    if (d.start < beforeStart && topLevelIndexOf(d.start) === scope && (!best || d.start > best.start)) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Pass 2: index local "helper" function variables: const X = (...) => <expr>
// or const X = function(...) { ... return <expr>; }. We only care about ones
// whose body is (or ends in) a single meaningful expression, since every
// wrapper we've found in this file is a thin pass-through.
// ---------------------------------------------------------------------------
const helperDefs = Object.create(null);
collect(ast, (n) =>
  n.type === 'VariableDeclarator' &&
  n.id.type === 'Identifier' &&
  n.init &&
  (n.init.type === 'ArrowFunctionExpression' || n.init.type === 'FunctionExpression')
).forEach((n) => {
  const fn = n.init;
  const params = fn.params.map((p) => (p.type === 'Identifier' ? p.name : null));
  let bodyExpr = null;
  if (fn.body.type === 'BlockStatement') {
    const rets = fn.body.body.filter((s) => s.type === 'ReturnStatement' && s.argument);
    if (rets.length) bodyExpr = rets[rets.length - 1].argument;
    else {
      const exprStmts = fn.body.body.filter((s) => s.type === 'ExpressionStatement');
      if (exprStmts.length) bodyExpr = exprStmts[exprStmts.length - 1].expression;
    }
  } else {
    bodyExpr = fn.body; // arrow expression body
  }
  if (!bodyExpr) return;
  (helperDefs[n.id.name] = helperDefs[n.id.name] || []).push({ start: n.start, end: n.end, params, bodyExpr });
});

// Which helper names ultimately resolve (through 0+ levels of chaining) to a
// direct call to `registerOptional`? (reg / tool / bcTool / open — NOT the
// unrelated schema-builder helpers like P/obj, whose body is an object
// literal, not a call.)
function resolvesToRegisterOptional(name, seen) {
  if (name === 'registerOptional') return true;
  if (seen.has(name)) return false;
  seen.add(name);
  const defs = helperDefs[name];
  if (!defs) return false;
  return defs.some(
    (d) =>
      d.bodyExpr.type === 'CallExpression' &&
      d.bodyExpr.callee.type === 'Identifier' &&
      (d.bodyExpr.callee.name === 'registerOptional' || resolvesToRegisterOptional(d.bodyExpr.callee.name, seen))
  );
}
const wrapperNames = new Set();
for (const name of Object.keys(helperDefs)) {
  if (name === 'registerOptional') continue;
  if (resolvesToRegisterOptional(name, new Set())) wrapperNames.add(name);
}
console.error('[extract_tools] registerOptional-forwarding wrapper names found:', Array.from(wrapperNames).join(', '));

// Positions of CallExpression nodes that are themselves a wrapper's own
// forwarding body (e.g. the `registerOptional(...)` inside `const reg = (...) => registerOptional(...)`).
// These must be EXCLUDED from the "direct registerOptional call" bucket,
// since they aren't real call sites — the real call sites are calls to the
// wrapper name itself, handled separately.
const wrapperBodyNodeStarts = new Set();
for (const name of Object.keys(helperDefs)) {
  for (const d of helperDefs[name]) {
    if (d.bodyExpr && d.bodyExpr.type === 'CallExpression') wrapperBodyNodeStarts.add(d.bodyExpr.start);
  }
}

// ---------------------------------------------------------------------------
// Generic literal-expression evaluator.
// Returns a plain JS value, or {__unresolved: reason} when it can't be
// statically determined (dynamic code, external call, etc).
// `substMap`: { paramName: { node: <actual arg AST node from call site>, outerSubst: {...} } }
// ---------------------------------------------------------------------------
function evalExpr(node, substMap) {
  if (!node) return { __unresolved: 'missing' };
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'Identifier': {
      if (substMap && Object.prototype.hasOwnProperty.call(substMap, node.name)) {
        const sub = substMap[node.name];
        if (!sub.node) return undefined; // argument omitted at call site
        return evalExpr(sub.node, sub.outerSubst || {});
      }
      const defs = constDefs[node.name];
      if (defs) {
        const best = nearestPreceding(defs, node.start);
        if (best) return evalExpr(best.node, {});
      }
      if (node.name === 'undefined') return undefined;
      return { __unresolved: 'identifier:' + node.name };
    }
    case 'ObjectExpression': {
      const obj = {};
      for (const prop of node.properties) {
        if (prop.type === 'SpreadElement') {
          const sv = evalExpr(prop.argument, substMap);
          if (sv && typeof sv === 'object' && !isUnresolved(sv)) Object.assign(obj, sv);
          continue;
        }
        let key;
        if (!prop.computed && prop.key.type === 'Identifier') key = prop.key.name;
        else if (prop.key.type === 'Literal') key = String(prop.key.value);
        else key = '<computed:' + (prop.key.name || prop.key.type) + '>';
        obj[key] = prop.value ? evalExpr(prop.value, substMap) : true;
      }
      return obj;
    }
    case 'ArrayExpression':
      return node.elements.map((el) => {
        if (!el) return null;
        if (el.type === 'SpreadElement') return evalExpr(el.argument, substMap);
        return evalExpr(el, substMap);
      });
    case 'TemplateLiteral': {
      if (node.expressions.length === 0) return node.quasis.map((q) => q.value.cooked).join('');
      let out = node.quasis[0].value.cooked;
      for (let i = 0; i < node.expressions.length; i++) {
        const v = evalExpr(node.expressions[i], substMap);
        out += isUnresolved(v) ? '${' + v.__unresolved + '}' : String(v);
        out += node.quasis[i + 1].value.cooked;
      }
      return out;
    }
    case 'LogicalExpression': {
      const left = evalExpr(node.left, substMap);
      if (!isUnresolved(left)) {
        if (node.operator === '||') return left ? left : evalExpr(node.right, substMap);
        if (node.operator === '&&') return !left ? left : evalExpr(node.right, substMap);
        if (node.operator === '??') return left !== null && left !== undefined ? left : evalExpr(node.right, substMap);
      }
      return { __unresolved: 'logical:' + node.operator };
    }
    case 'BinaryExpression': {
      const l = evalExpr(node.left, substMap);
      const r = evalExpr(node.right, substMap);
      if (!isUnresolved(l) && !isUnresolved(r)) {
        switch (node.operator) {
          case '===': return l === r;
          case '!==': return l !== r;
          case '==': return l == r; // eslint-disable-line eqeqeq
          case '!=': return l != r; // eslint-disable-line eqeqeq
          case '+':
            if (typeof l === 'string' || typeof r === 'string') return String(l) + String(r);
            if (typeof l === 'number' && typeof r === 'number') return l + r;
            break;
          case '-':
            // Real numeric subtraction only makes sense when both sides are
            // numbers. We also hit this operator when a long hand-written
            // description string contains an unescaped `'...'` quote pair
            // (observed once, in `log_learn`'s description, where the text
            // itself quotes a grammar rule like "stmt -> '-' stmt"): the
            // unescaped inner quotes split one string literal into two
            // adjacent literals joined by a stray `-` token. At actual
            // runtime that evaluates to NaN (a latent bug in the source
            // file, not something we should silently hide) but for the
            // purposes of recovering the *intended* description text, the
            // obviously-right reading is "both halves of the string,
            // concatenated" — so treat string `-` string as concatenation.
            if (typeof l === 'number' && typeof r === 'number') return l - r;
            if (typeof l === 'string' && typeof r === 'string') return l + r;
            break;
        }
      }
      return { __unresolved: 'binary:' + node.operator };
    }
    case 'UnaryExpression': {
      const v = evalExpr(node.argument, substMap);
      if (!isUnresolved(v)) {
        if (node.operator === '!') return !v;
        if (node.operator === '-') return -v;
        if (node.operator === 'typeof') return typeof v;
      }
      return { __unresolved: 'unary:' + node.operator };
    }
    case 'ConditionalExpression': {
      const t = evalExpr(node.test, substMap);
      if (!isUnresolved(t)) return t ? evalExpr(node.consequent, substMap) : evalExpr(node.alternate, substMap);
      return {
        __unresolved: 'conditional',
        __conditional: true,
        consequent: evalExpr(node.consequent, substMap),
        alternate: evalExpr(node.alternate, substMap),
      };
    }
    case 'CallExpression': {
      if (node.callee.type === 'Identifier') {
        const defs = helperDefs[node.callee.name];
        if (defs) {
          const best = nearestPreceding(defs, node.start);
          if (best) {
            const newSubst = {};
            best.params.forEach((p, i) => {
              if (p) newSubst[p] = { node: node.arguments[i] || null, outerSubst: substMap };
            });
            return evalExpr(best.bodyExpr, newSubst);
          }
        }
      }
      // Object.assign(a, b, ...) is used in a few schema/prop-merging spots
      // (e.g. `P(Object.assign({...}, xy))`) — safe to interpret directly.
      if (
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'Object' &&
        node.callee.property.type === 'Identifier' &&
        node.callee.property.name === 'assign'
      ) {
        const merged = {};
        for (const argNode of node.arguments) {
          const v = evalExpr(argNode, substMap);
          if (v && typeof v === 'object' && !isUnresolved(v)) Object.assign(merged, v);
        }
        return merged;
      }
      return { __unresolved: 'call:' + (node.callee.name || (node.callee.type === 'MemberExpression' && node.callee.property && node.callee.property.name) || node.callee.type) };
    }
    case 'MemberExpression':
      return { __unresolved: 'member' };
    case 'AssignmentExpression':
      return evalExpr(node.right, substMap);
    default:
      return { __unresolved: 'nodeType:' + node.type };
  }
}

// Replace any residual {__unresolved:...} / {__conditional:...} markers found
// anywhere inside a value with a JSON-safe, informative placeholder, so the
// final JSON never contains our internal marker shape.
function finalize(v) {
  if (v === undefined) return undefined;
  if (v && typeof v === 'object' && v.__conditional) {
    return { '<ternary>': { if_true: finalize(v.consequent), if_false: finalize(v.alternate) } };
  }
  if (isUnresolved(v)) return '<UNRESOLVED:' + v.__unresolved + '>';
  if (Array.isArray(v)) return v.map(finalize);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) {
      const fv = finalize(v[k]);
      if (fv !== undefined) o[k] = fv;
    }
    return o;
  }
  return v;
}

function hasUnresolvedDeep(v, depth) {
  depth = depth || 0;
  if (depth > 12) return false;
  if (isUnresolved(v)) return true;
  if (Array.isArray(v)) return v.some((x) => hasUnresolvedDeep(x, depth + 1));
  if (v && typeof v === 'object') return Object.keys(v).some((k) => hasUnresolvedDeep(v[k], depth + 1));
  return false;
}

// ---------------------------------------------------------------------------
// Tool accumulation
// ---------------------------------------------------------------------------
const tools = []; // {name, description, parameters, domain, _source}
const seenNames = new Set();
let countDirect = 0;
let countDataTable = 0;
let duplicateCount = 0;

function addTool(name, description, parameters, domain, sourceTag, extra) {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    unparsed.push({ reason: 'bad-name', detail: String(name), extra: extra || null });
    return;
  }
  if (seenNames.has(name)) {
    duplicateCount++;
    return;
  }
  seenNames.add(name);
  const entry = {
    name,
    description: typeof description === 'string' ? description : (isUnresolved(description) ? '<UNRESOLVED:' + description.__unresolved + '>' : finalize(description)),
    parameters: parameters == null ? null : finalize(parameters),
    domain: domain == null ? null : domain,
  };
  tools.push(entry);
  if (sourceTag === 'data_table') countDataTable++;
  else countDirect++;
}

// ---------------------------------------------------------------------------
// Bucket A + C: every CallExpression literally calling `registerOptional`
// (both genuine direct call sites, and the 2 forEach-loop-based ones which we
// detect by shape and route to the data-table handler instead).
// ---------------------------------------------------------------------------
const allRegisterOptionalCalls = collect(
  ast,
  (n) => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'registerOptional'
).filter((n) => !wrapperBodyNodeStarts.has(n.start));

// Identify the `Object.keys(X).forEach(name => { ... registerOptional(name, ...) ... })`
// loops so we can exclude their inner registerOptional(...) call from the
// "direct" bucket (its args are loop-bound identifiers, not literals) and
// handle them via the authoritative data-table route instead.
const forEachLoops = collect(
  ast,
  (n) =>
    n.type === 'CallExpression' &&
    n.callee.type === 'MemberExpression' &&
    !n.callee.computed &&
    n.callee.property.type === 'Identifier' &&
    n.callee.property.name === 'forEach' &&
    n.callee.object.type === 'CallExpression' &&
    n.callee.object.callee.type === 'MemberExpression' &&
    n.callee.object.callee.object.type === 'Identifier' &&
    n.callee.object.callee.object.name === 'Object' &&
    n.callee.object.callee.property.name === 'keys'
).filter((loopNode) => {
  const cb = loopNode.arguments[0];
  if (!cb) return false;
  const inner = collect(cb, (n) => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'registerOptional');
  return inner.length > 0;
});

const loopInnerCallStarts = new Set();
forEachLoops.forEach((loopNode) => {
  collect(loopNode.arguments[0], (n) => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'registerOptional').forEach((n) =>
    loopInnerCallStarts.add(n.start)
  );
});

console.error('[extract_tools] direct registerOptional() call sites (raw):', allRegisterOptionalCalls.length);
console.error('[extract_tools] forEach(Object.keys(TABLE)) tool-registration loops found:', forEachLoops.length);

for (const call of allRegisterOptionalCalls) {
  if (loopInnerCallStarts.has(call.start)) continue; // handled by data-table route below
  const nameArg = call.arguments[0];
  const descArg = call.arguments[1];
  const schemaArg = call.arguments[3];

  const nameVal = evalExpr(nameArg, {});
  if (nameVal && typeof nameVal === 'object' && nameVal.__conditional) {
    // ternary of (presumably) two literal names, evaluated with no concrete
    // substitution available at this call site: emit both branches if they
    // are plain strings, otherwise log unparsed.
    const branches = [nameVal.consequent, nameVal.alternate];
    let any = false;
    for (const b of branches) {
      if (typeof b === 'string') {
        any = true;
        addTool(b, evalExpr(descArg, {}), schemaArg ? evalExpr(schemaArg, {}) : null, null, 'registerOptional');
      }
    }
    if (!any) unparsed.push({ reason: 'unresolved-ternary-name', detail: src.slice(call.start, Math.min(call.end, call.start + 200)), line: lineOf(src, call.start) });
    continue;
  }
  if (typeof nameVal === 'string') {
    addTool(nameVal, evalExpr(descArg, {}), schemaArg ? evalExpr(schemaArg, {}) : null, null, 'registerOptional');
    continue;
  }
  // Not a literal/ternary/template name at a genuine direct call site: this
  // means our forEach-loop detection missed a pattern. Log it honestly.
  unparsed.push({
    reason: 'unresolved-direct-name',
    detail: 'arg0 type=' + nameArg.type + ' near: ' + src.slice(call.start, Math.min(call.end, call.start + 160)).replace(/\s+/g, ' '),
    line: lineOf(src, call.start),
  });
}

// ---------------------------------------------------------------------------
// Bucket B: wrapper-forwarded calls (reg(...) / tool(...) / bcTool(...) / open(...))
// ---------------------------------------------------------------------------
for (const wrapperName of wrapperNames) {
  const callSites = collect(ast, (n) => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === wrapperName);
  for (const call of callSites) {
    // Plenty of other, unrelated local functions/closures in this huge file
    // happen to reuse short names like `open`/`reg`/`tool` for something else
    // entirely (e.g. a code-pretty-printer's own `open(indent, text, node)`
    // brace-opening helper, or an unrelated zero-arg `open()` panel toggler).
    // Only consider the definitions of this name that themselves genuinely
    // forward straight to registerOptional (not every same-named local), then
    // require the call's argument count not to exceed that definition's
    // declared parameter count (trailing optional args, e.g. bcTool's
    // `timeoutMs`, may be omitted), preferring the nearest one in the same
    // top-level statement (IIFE/class method).
    const defs = (helperDefs[wrapperName] || []).filter(
      (d) => d.bodyExpr.type === 'CallExpression' && d.bodyExpr.callee.type === 'Identifier' && d.bodyExpr.callee.name === 'registerOptional'
    );
    const candidateDefs = defs.filter((d) => call.arguments.length <= d.params.length);
    const def = nearestPrecedingSameTopLevel(candidateDefs.length ? candidateDefs : defs, call.start);
    if (!def || call.arguments.length > def.params.length) {
      continue; // not a real registration call site of this wrapper name
    }
    // Resolve through at most 2 levels of chaining (observed max in this file is 1).
    let bodyExpr = def.bodyExpr;
    let substMap = {};
    def.params.forEach((p, i) => {
      if (p) substMap[p] = { node: call.arguments[i] || null, outerSubst: {} };
    });
    let hops = 0;
    while (bodyExpr.type === 'CallExpression' && bodyExpr.callee.type === 'Identifier' && bodyExpr.callee.name !== 'registerOptional' && hops < 4) {
      const innerDefs = helperDefs[bodyExpr.callee.name];
      if (!innerDefs) break;
      const innerDef = nearestPreceding(innerDefs, bodyExpr.start);
      if (!innerDef) break;
      const newSubst = {};
      innerDef.params.forEach((p, i) => {
        if (p) newSubst[p] = { node: bodyExpr.arguments[i] || null, outerSubst: substMap };
      });
      bodyExpr = innerDef.bodyExpr;
      substMap = newSubst;
      hops++;
    }
    if (!(bodyExpr.type === 'CallExpression' && bodyExpr.callee.type === 'Identifier' && bodyExpr.callee.name === 'registerOptional')) {
      unparsed.push({ reason: 'wrapper-does-not-reach-registerOptional', detail: wrapperName, line: lineOf(src, call.start) });
      continue;
    }
    const nameVal = evalExpr(bodyExpr.arguments[0], substMap);
    const descVal = evalExpr(bodyExpr.arguments[1], substMap);
    const schemaVal = bodyExpr.arguments[3] ? evalExpr(bodyExpr.arguments[3], substMap) : null;
    if (typeof nameVal === 'string') {
      addTool(nameVal, descVal, schemaVal, null, 'registerOptional');
    } else {
      unparsed.push({
        reason: 'unresolved-wrapper-call-name',
        detail: wrapperName + '(...) near: ' + src.slice(call.start, Math.min(call.end, call.start + 160)).replace(/\s+/g, ' '),
        line: lineOf(src, call.start),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Bucket D (data tables): the two Object.keys(TABLE).forEach(...) loops.
// Resolve TABLE's real runtime value by slicing out the exact embedded UMD
// module that builds it and running that (self-contained, DOM-free) module
// in a throwaway vm sandbox — far more accurate than trying to statically
// replay the forEach(['text','doc']) mutation loops that build the
// sheet_*/text_*/doc_* table entries.
// ---------------------------------------------------------------------------
function sliceTopLevelStatementContaining(markerText) {
  const idx = src.indexOf(markerText);
  if (idx < 0) return null;
  for (const stmt of ast.body) {
    if (stmt.start <= idx && idx <= stmt.end) return src.slice(stmt.start, stmt.end);
  }
  return null;
}

function runEmbeddedUmdModule(label, markerText) {
  const slice = sliceTopLevelStatementContaining(markerText);
  if (!slice) {
    warnings.push('could not locate embedded module for ' + label + ' (marker not found: ' + markerText + ')');
    return null;
  }
  // The bundler wraps each embedded UMD module as
  // `(function () { ...umd... }).call(window, undefined);` — so `this` inside
  // resolves to `window`, which the UMD factory then assigns its export onto
  // (root.TwVideoPlans = ..., where root === this === window since `self` is
  // not defined in Node). Provide a plain `window` object to catch it.
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  try {
    const script = new vm.Script(slice, { filename: label, timeout: 5000 });
    script.runInContext(sandbox, { timeout: 5000 });
  } catch (e) {
    warnings.push('error running embedded module ' + label + ': ' + (e && e.message));
    return null;
  }
  return sandbox;
}

function readModuleExport(sandbox, exportName) {
  if (!sandbox) return null;
  if (sandbox[exportName]) return sandbox[exportName];
  if (sandbox.window && sandbox.window[exportName]) return sandbox.window[exportName];
  return null;
}

const videoSandbox = runEmbeddedUmdModule('TwVideoPlans', 'root.TwVideoPlans = factory()');
const videoModuleExports = readModuleExport(videoSandbox, 'TwVideoPlans');
const videoTOOLS = videoModuleExports && videoModuleExports.TOOLS;
if (videoTOOLS) console.error('[extract_tools] TwVideoPlans.TOOLS resolved via vm:', Object.keys(videoTOOLS).length, 'entries');
else warnings.push('TwVideoPlans.TOOLS could not be resolved via vm sandbox');

const docSemSandbox = runEmbeddedUmdModule('FaDocSemantics', 'root.FaDocSemantics = factory(');
const docSemModuleExports = readModuleExport(docSemSandbox, 'FaDocSemantics');
const docSemTOOLS = docSemModuleExports && docSemModuleExports.TOOLS;
if (docSemTOOLS) console.error('[extract_tools] FaDocSemantics.TOOLS resolved via vm:', Object.keys(docSemTOOLS).length, 'entries');
else warnings.push('FaDocSemantics.TOOLS could not be resolved via vm sandbox');

// Map each discovered forEach loop node to the right resolved table by
// inspecting the `Object.keys(ARG)` argument shape.
function describeArgPath(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    return describeArgPath(node.object) + '.' + node.property.name;
  }
  return '<' + node.type + '>';
}

for (const loopNode of forEachLoops) {
  const argNode = loopNode.callee.object.arguments[0];
  const argPath = describeArgPath(argNode);
  let table = null;
  let domainHintNote = '';
  if (argPath === 'TOOLS' && videoTOOLS) {
    // Disambiguate: this bare-`TOOLS` loop could in principle refer to either
    // embedded module's local `TOOLS` var; in this file only the video one is
    // referenced as a bare identifier (doc-semantics is always `DS.TOOLS`).
    table = videoTOOLS;
  } else if (argPath === 'DS.TOOLS' && docSemTOOLS) {
    table = docSemTOOLS;
  } else {
    warnings.push('forEach tool-loop with unrecognized table reference "' + argPath + '" near line ' + lineOf(src, loopNode.start) + ' — skipped (not expanded)');
    unparsed.push({ reason: 'unrecognized-data-table', detail: argPath, line: lineOf(src, loopNode.start) });
    continue;
  }

  for (const toolName of Object.keys(table)) {
    const t = table[toolName];
    if (!t || typeof t !== 'object') continue;
    const props = {};
    const rawProps = t.props || {};
    for (const k of Object.keys(rawProps)) {
      const p = Object.assign({}, rawProps[k]);
      if (!p.description) p.description = k;
      props[k] = p;
    }
    const parameters = { type: 'object', properties: props, required: t.required || [], additionalProperties: false };
    const domain = typeof t.domain === 'string' ? t.domain : null;
    addTool(toolName, t.desc, parameters, domain, 'data_table');
  }
}

// ---------------------------------------------------------------------------
// Sanity: compare against the rough ~206 grep estimate from prior research.
// ---------------------------------------------------------------------------
const total = tools.length;
console.error('[extract_tools] TOTAL tools extracted:', total);
console.error('[extract_tools] from direct/wrapper registerOptional() calls:', countDirect);
console.error('[extract_tools] from data-table loops:', countDataTable);
console.error('[extract_tools] duplicate names skipped (kept first occurrence):', duplicateCount);
console.error('[extract_tools] unparsed/unresolved registrations:', unparsed.length);
if (warnings.length) {
  console.error('[extract_tools] warnings:');
  warnings.forEach((w) => console.error('  - ' + w));
}

// ---------------------------------------------------------------------------
// Held-out split: heldout = md5('rt:' + name) taken as an integer, % 5 === 0
// (mirrors the sibling project's exact scheme).
// ---------------------------------------------------------------------------
function isHeldout(name) {
  const hex = crypto.createHash('md5').update('rt:' + name).digest('hex');
  // Use the full 128-bit hex digest as a BigInt, matching "md5(...) % 5 == 0"
  // semantics regardless of digest size.
  const big = BigInt('0x' + hex);
  return big % 5n === 0n;
}

for (const t of tools) t.heldout = isHeldout(t.name);
tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const heldoutCount = tools.filter((t) => t.heldout).length;
console.error('[extract_tools] heldout:', heldoutCount, '/', total, '(' + ((heldoutCount / total) * 100).toFixed(1) + '%)');

const withDomain = tools.filter((t) => t.domain).length;
console.error('[extract_tools] tools with a known domain label:', withDomain, '/', total);

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------
fs.mkdirSync(OUT_DIR, { recursive: true });
const output = {
  total,
  by_source: { registerOptional: countDirect, data_table: countDataTable },
  heldout_count: heldoutCount,
  tools_with_domain: withDomain,
  duplicate_names_skipped: duplicateCount,
  unparsed,
  warnings,
  tools,
};
fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf8');
console.error('[extract_tools] wrote', OUT_PATH);

// ---------------------------------------------------------------------------
// Spot-check print: a handful of real entries, for human sanity-checking.
// ---------------------------------------------------------------------------
function printSample(name) {
  const t = tools.find((x) => x.name === name);
  if (!t) {
    console.error('[spot-check] MISSING sample tool:', name);
    return;
  }
  console.error('\n--- spot-check:', name, '---');
  console.error(JSON.stringify(t, null, 2).slice(0, 1500));
}
['sheet_set_cell', 'sheet_add_row', 'video_cut_range', 'edit_video_open', 'computer_list_windows', 'browser_create_tab_group', 'list_ai_functions'].forEach(printSample);
