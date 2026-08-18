// Shared AST walker for the localization tooling.
//
// `collectDisplayUnits` returns the translatable DISPLAY units of a source file —
// plain strings, JSX text, and interpolated templates — at UNIT granularity (a whole
// template is one unit, not its chunks). The SAME function is used by extraction (to
// build the dictionary) and by the locator (to place dictionary entries in the current
// tree), so the two can never disagree about what counts as a display string.
//
// Everything that is NOT a display string is excluded here — this is the single place
// that decides "display vs logic", and it is proven correct by verify-pr.mjs (which
// asserts the locator reproduces the l10n PR exactly: no miss, no over-wrap).

import ts from "typescript";

const K = ts.SyntaxKind;
export { ts, K };

export const CYRILLIC = /[Ѐ-ӿ]/;

// Localization runtime helpers — anything inside a call to one of these is a hand
// seam and owns its own text; the transform must not touch it.
const HELPER_CALLS = new Set(["pluralRu", "Lp", "L", "LT"]);

function isHelperCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    HELPER_CALLS.has(node.expression.text)
  );
}

// A template is seam-owned if any interpolation calls a helper (e.g. RU
// `Обновление ${n} ${pluralRu(...)}`, or our `L(`en`, `ru ${pluralRu()}`)`).
function templateHasHelperCall(node) {
  let found = false;
  (function walk(n) {
    if (found) return;
    if (isHelperCall(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  })(node);
  return found;
}

// True if `node` is a display string we must NOT wrap (a type, a module specifier, an
// object key, a case label, a comparison operand, or seam-owned text).
function isExcluded(node) {
  const parent = node.parent;
  if (!parent) return false;

  // Inside a localization helper call (a seam) — at any depth.
  for (let p = parent; p; p = p.parent) {
    if (isHelperCall(p)) return true;
  }

  // A template whose interpolations call a helper is a plural/structural seam — its
  // literal chunks belong to the seam, not the transform.
  if (ts.isTemplateExpression(node) && templateHasHelperCall(node)) return true;

  // String-literal TYPE position: `x: "foo"` in an interface, `x as "foo"`, unions.
  if (parent.kind === K.LiteralType) return true;

  // Module specifier: `import … from "x"`, `export … from "x"`, `import("x")`.
  if (parent.kind === K.ImportDeclaration || parent.kind === K.ExportDeclaration) return true;
  if (ts.isCallExpression(parent) && parent.expression.kind === K.ImportKeyword) return true;

  // Object / signature KEY position (property name, not value).
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isEnumMember(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (parent.kind === K.ComputedPropertyName) return true;

  // Element access key: `obj["foo"]`.
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;

  // switch/case label: `case "foo":`.
  if (ts.isCaseClause(parent) && parent.expression === node) return true;

  // Equality comparison operand: `x === "foo"` — logic, never a displayed label.
  if (
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === K.EqualsEqualsEqualsToken ||
      parent.operatorToken.kind === K.ExclamationEqualsEqualsToken ||
      parent.operatorToken.kind === K.EqualsEqualsToken ||
      parent.operatorToken.kind === K.ExclamationEqualsToken)
  ) {
    return true;
  }

  return false;
}

// Build the `"head{0}mid{1}tail"` skeleton + the source ranges of each interpolation.
function templateSkeleton(tmpl, sf) {
  let skeleton = tmpl.head.text;
  const exprs = [];
  tmpl.templateSpans.forEach((span, i) => {
    exprs.push([span.expression.getStart(sf), span.expression.getEnd()]);
    skeleton += `{${i}}` + span.literal.text;
  });
  return { skeleton, exprs };
}

/**
 * Collect display units of a source file, in source order.
 * Unit shape: { kind: "str"|"jsx"|"tpl", text, start, end, braces?, exprs? }
 *  - text is the match/lookup key (str: value, jsx: whitespace-collapsed, tpl: skeleton)
 *  - start/end are byte offsets (jsx: the trimmed core; tpl: the whole `...` expression)
 */
export function collectDisplayUnits(source, fileName) {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const units = [];
  (function visit(node) {
    if (!isExcluded(node)) {
      if (node.kind === K.StringLiteral || node.kind === K.NoSubstitutionTemplateLiteral) {
        const start = node.getStart(sf);
        units.push({
          kind: "str",
          text: node.text,
          start,
          end: node.getEnd(),
          braces: node.parent && node.parent.kind === K.JsxAttribute ? true : undefined,
        });
      } else if (node.kind === K.JsxText) {
        const collapsed = node.text.replace(/\s+/g, " ").trim();
        if (collapsed !== "") {
          const rawStart = node.getStart(sf);
          const raw = source.slice(rawStart, node.getEnd());
          const lead = raw.length - raw.trimStart().length;
          const trail = raw.length - raw.trimEnd().length;
          units.push({
            kind: "jsx",
            text: collapsed,
            start: rawStart + lead,
            end: node.getEnd() - trail,
          });
        }
      } else if (ts.isTemplateExpression(node)) {
        const { skeleton, exprs } = templateSkeleton(node, sf);
        units.push({
          kind: "tpl",
          text: skeleton,
          start: node.getStart(sf),
          end: node.getEnd(),
          exprs,
        });
      }
    }
    ts.forEachChild(node, visit);
  })(sf);
  return units;
}

// All Cyrillic display texts WITHOUT exclusions — used for the union completeness proof
// (targets from the RU commit; coverage from the working tree's seams).
export function allCyrillicTexts(source, fileName) {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out = [];
  const KINDS = new Set([
    K.StringLiteral,
    K.NoSubstitutionTemplateLiteral,
    K.TemplateHead,
    K.TemplateMiddle,
    K.TemplateTail,
    K.JsxText,
  ]);
  (function visit(node) {
    if (KINDS.has(node.kind)) {
      const text = node.kind === K.JsxText ? node.text.replace(/\s+/g, " ").trim() : node.text;
      if (CYRILLIC.test(text)) out.push(text);
    }
    ts.forEachChild(node, visit);
  })(sf);
  return out;
}
