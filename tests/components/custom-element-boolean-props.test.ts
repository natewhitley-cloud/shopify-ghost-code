import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, it, expect } from "vitest";

/**
 * gc-j1uf (ported from FraudPilot ft-e1g): React 18 writes a `false` prop on a
 * custom element as the attribute `attr="false"`, and Polaris web components
 * treat any boolean attribute as present (`<s-button disabled="false">` is
 * disabled). Every boolean prop on an `s-*` element must therefore be
 * `cond ? true : undefined`, `cond || undefined`, or a conditional spread
 * `{...(cond ? { disabled: true } : {})}`, so the attribute is absent when the
 * value is false.
 * Native elements are not affected and are skipped.
 */
const BOOLEAN_PROPS = new Set([
  "disabled",
  "loading",
  "checked",
  "required",
  "readOnly",
  "selected",
  "multiple",
  "dismissible",
  "open",
]);

const APP_DIR = join(__dirname, "../../app");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

function isUndefined(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && node.text === "undefined";
}

/** True when the expression can only produce `true` or `undefined`. */
function isSafe(expr: ts.Expression): boolean {
  const e = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  if (e.kind === ts.SyntaxKind.TrueKeyword || isUndefined(e)) return true;
  if (ts.isConditionalExpression(e)) {
    return isSafe(e.whenTrue) && isSafe(e.whenFalse);
  }
  return (
    ts.isBinaryExpression(e) &&
    e.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
    isUndefined(e.right)
  );
}

/**
 * True for `{...(cond ? { disabled: true } : {})}`: every branch is an object
 * literal whose boolean props are safe, so `false` can never be written.
 */
function isSafeSpread(expr: ts.Expression): boolean {
  const e = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  if (ts.isConditionalExpression(e)) {
    return isSafeSpread(e.whenTrue) && isSafeSpread(e.whenFalse);
  }
  if (!ts.isObjectLiteralExpression(e)) return false;
  return e.properties.every(
    (p) =>
      ts.isPropertyAssignment(p) && (!BOOLEAN_PROPS.has(p.name.getText()) || isSafe(p.initializer)),
  );
}

function offendersIn(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const report = (node: ts.Node, what: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    found.push(`${relative(APP_DIR, file)}:${line + 1}: ${what}`);
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(source).startsWith("s-")
    ) {
      for (const attr of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attr)) {
          if (!isSafeSpread(attr.expression)) {
            report(attr, "spread props on an s-* element");
          }
        } else if (
          BOOLEAN_PROPS.has(attr.name.getText(source)) &&
          attr.initializer &&
          ts.isJsxExpression(attr.initializer) &&
          attr.initializer.expression &&
          !isSafe(attr.initializer.expression)
        ) {
          report(attr, attr.getText(source).replace(/\s+/g, " "));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("custom-element boolean props (gc-j1uf)", () => {
  it('React writes disabled={false} on an s-* element as disabled="false" (the hazard)', () => {
    expect(renderToStaticMarkup(createElement("s-button", { disabled: false }))).toContain(
      'disabled="false"',
    );
  });

  it("cond ? true : undefined leaves the attribute off when false", () => {
    const off = false as boolean;
    expect(
      renderToStaticMarkup(createElement("s-button", { disabled: off ? true : undefined })),
    ).not.toContain("disabled");
  });

  it("every boolean prop on an s-* element passes true or undefined, never false", () => {
    expect(tsxFiles(APP_DIR).flatMap(offendersIn)).toEqual([]);
  });
});
