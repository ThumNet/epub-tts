// Core functions of the boundary check. The CLI is scripts/check-boundaries.mjs.
// The check parses each file with the TypeScript compiler API, so comments and string
// contents never count as code.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** List all .ts files under a directory, recursively, as absolute paths. Missing directory gives []. */
export function listTsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) result.push(full);
  }
  return result.sort();
}

function parse(fileName, source) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function stringOf(node) {
  if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

/**
 * Describe the argument of a dynamic import as { text, exact }.
 * Exact: a string literal. Prefix: the static head of a template with substitutions, or the leftmost
 * string of a `+` concatenation. Anything else gives an empty prefix, which cannot be resolved.
 */
function dynamicArgument(node) {
  const exact = stringOf(node);
  if (exact !== undefined) return { text: exact, exact: true };
  let leaf = node;
  while (leaf !== undefined && ts.isBinaryExpression(leaf) && leaf.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    leaf = leaf.left;
  }
  if (leaf !== undefined && ts.isTemplateExpression(leaf)) return { text: leaf.head.text, exact: false };
  const head = stringOf(leaf);
  if (head !== undefined) return { text: head, exact: false };
  return { text: "", exact: false };
}

/**
 * Return the module references of a source file as { specifier, exact, line }.
 * Covers static import and export-from declarations, `import x = require("...")`, `import("...")` types
 * and dynamic `import("...")` calls. For a dynamic import with a computed argument, `exact` is false and
 * `specifier` is the static prefix (possibly empty).
 * `new URL("./x.ts", import.meta.url)` worker references are not module imports. Vite bundles them
 * as separate entry points, so they are neither graph edges nor import candidates.
 */
export function importReferences(source, fileName = "file.ts") {
  const references = [];
  const sourceFile = parse(fileName, source);
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const add = (node, text, exact) => {
    if (text !== undefined) references.push({ specifier: text, exact, line: lineOf(node) });
  };
  walk(sourceFile, (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node, stringOf(node.moduleSpecifier), true);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, stringOf(node.moduleReference.expression), true);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, stringOf(node.argument.literal), true);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = dynamicArgument(node.arguments[0]);
      add(node, argument.text, argument.exact);
    }
  });
  return references;
}

/** Return the exact module specifiers of a source file. Computed dynamic imports are left out. */
export function importSpecifiers(source, fileName = "file.ts") {
  return importReferences(source, fileName)
    .filter((reference) => reference.exact)
    .map((reference) => reference.specifier);
}

const DOM_GLOBALS = new Set(["document", "window"]);
const GLOBAL_RECEIVERS = new Set(["globalThis", "window", "self", "top"]);
const DOM_METHODS = new Set(["getElementById", "querySelector", "querySelectorAll"]);

/**
 * Find DOM access in a source file. Return a list of labels.
 * Flags the identifiers `document` and `window`, and the members getElementById, querySelector
 * and querySelectorAll. An identifier counts as the global unless it is the name of a property
 * access, a declaration or a property. Exception: `.document` and `.window` (or the string keys
 * ["document"] and ["window"]) are flagged when the receiver is globalThis, window, self or top.
 * Limits: `obj.document` and `this.document` are not flagged. Aliasing such as
 * `const g = globalThis; g.document` is not caught. A local variable that shadows `document` is
 * flagged only where it is read.
 */
function isGlobalReceiver(expression) {
  return ts.isIdentifier(expression) && GLOBAL_RECEIVERS.has(expression.text);
}

export function domAccess(source, fileName = "file.ts") {
  const found = [];
  walk(parse(fileName, source), (node) => {
    if (ts.isIdentifier(node) && DOM_GLOBALS.has(node.text)) {
      const parent = node.parent;
      const isName =
        parent !== undefined &&
        !ts.isShorthandPropertyAssignment(parent) &&
        ((("name" in parent) && parent.name === node) ||
          (ts.isBindingElement(parent) && parent.propertyName === node) ||
          (ts.isQualifiedName(parent) && parent.right === node));
      const viaGlobal =
        isName && ts.isPropertyAccessExpression(parent) && parent.name === node && isGlobalReceiver(parent.expression);
      if (!isName || viaGlobal) found.push(node.text);
    } else if (ts.isPropertyAccessExpression(node) && DOM_METHODS.has(node.name.text)) {
      found.push(node.name.text);
    } else if (ts.isBindingElement(node)) {
      // Destructuring: `const { querySelector } = x` or `const { querySelector: q } = x`.
      for (const name of [node.name, node.propertyName]) {
        if (name !== undefined && ts.isIdentifier(name) && DOM_METHODS.has(name.text)) found.push(name.text);
      }
    } else if (ts.isElementAccessExpression(node)) {
      const key = stringOf(node.argumentExpression);
      if (key !== undefined && DOM_METHODS.has(key)) found.push(key);
      else if (key !== undefined && DOM_GLOBALS.has(key) && isGlobalReceiver(node.expression)) found.push(key);
    }
  });
  return found;
}

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s)$/;

function isForbiddenImport(file, specifier, rootDir, exact = true) {
  if (!specifier.startsWith(".")) return false;
  const target = path.resolve(path.dirname(file), specifier);
  const relative = path.relative(rootDir, target);
  if (relative === "ui" || relative.startsWith(`ui${path.sep}`)) return true;
  // A prefix such as "../main" can begin the main module. Be conservative.
  if (!exact) return relative.startsWith("main");
  return relative.replace(SOURCE_EXTENSION, "") === "main";
}

/**
 * Check every file under `engineDir`. `rootDir` is the src directory.
 * Return { violations, warnings, fileCount }. The directory may be absent. Then the result is empty.
 * A computed dynamic import is checked by its static prefix. Without a relative prefix, or with a prefix
 * that stops at `rootDir`, the target cannot be resolved. That gives a warning, not a violation.
 * Prefix imports are not graph edges, because the target file is unknown.
 */
export function checkEngine(engineDir, rootDir = path.dirname(engineDir)) {
  const violations = [];
  const warnings = [];
  const files = listTsFiles(engineDir);
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const name = path.relative(rootDir, file);
    for (const label of new Set(domAccess(source, file))) {
      violations.push(`${name}: DOM access (${label}) is not allowed in the engine`);
    }
    for (const { specifier, exact, line } of importReferences(source, file)) {
      if (isForbiddenImport(file, specifier, rootDir, exact)) {
        const shown = exact ? specifier : `${specifier}...`;
        violations.push(`${name}:${line}: import "${shown}" is not allowed in the engine`);
      } else if (!exact) {
        const unresolved =
          !specifier.startsWith(".") || path.resolve(path.dirname(file), specifier) === path.resolve(rootDir);
        if (unresolved) warnings.push(`unresolvable dynamic import at ${name}:${line}`);
      }
    }
  }
  return { violations, warnings, fileCount: files.length };
}

function resolveImport(fromFile, specifier, fileSet) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, base.replace(/\.js$/, ".ts"), path.join(base, "index.ts")];
  return candidates.find((candidate) => fileSet.has(candidate));
}

/** Build the import graph of all .ts files under `srcDir`. Return Map<file, file[]>. */
export function buildGraph(srcDir) {
  const files = listTsFiles(srcDir);
  const fileSet = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const targets = [];
    for (const specifier of importSpecifiers(fs.readFileSync(file, "utf8"), file)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolveImport(file, specifier, fileSet);
      if (target !== undefined && !targets.includes(target)) targets.push(target);
    }
    graph.set(file, targets);
  }
  return graph;
}

/** Find import cycles. Return each cycle as a list of relative paths, first path repeated at the end. */
export function findCycles(srcDir) {
  const graph = buildGraph(srcDir);
  const state = new Map(); // 1 = on the stack, 2 = done
  const stack = [];
  const cycles = [];
  const visit = (file) => {
    state.set(file, 1);
    stack.push(file);
    for (const next of graph.get(file) ?? []) {
      const status = state.get(next);
      if (status === 1) {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        cycles.push(cycle.map((entry) => path.relative(srcDir, entry)));
      } else if (status === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(file, 2);
  };
  for (const file of graph.keys()) {
    if (state.get(file) === undefined) visit(file);
  }
  let edgeCount = 0;
  for (const targets of graph.values()) edgeCount += targets.length;
  return { cycles, fileCount: graph.size, edgeCount };
}

/** Run both checks. Return { ok, messages, warnings, summary }. Warnings do not fail the check. */
export function runChecks(srcDir) {
  const engine = checkEngine(path.join(srcDir, "engine"), srcDir);
  const graph = findCycles(srcDir);
  const messages = [
    ...engine.violations,
    ...graph.cycles.map((cycle) => `import cycle: ${cycle.join(" -> ")}`),
  ];
  const summary =
    `boundaries OK: ${graph.fileCount} files, ${graph.edgeCount} imports, 0 cycles, ` +
    `${engine.fileCount} engine files checked`;
  return { ok: messages.length === 0, messages, warnings: engine.warnings, summary };
}
