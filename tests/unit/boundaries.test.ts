import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runChecks } from "../../scripts/boundaries-lib.mjs";

let root = "";

function write(relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "boundaries-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("boundary check", () => {
  it("passes a clean tree, also without src/engine", () => {
    write("a.ts", 'import { b } from "./b";\nexport const a = b;\n');
    write("b.ts", "export const b = 1;\n");
    const result = runChecks(root);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("2 files");
  });

  it("passes a clean engine file", () => {
    write("engine/pure.ts", '// document. in a comment is fine\nimport { x } from "../wav";\nexport const y = x;\n');
    write("wav.ts", "export const x = 1;\n");
    expect(runChecks(root).ok).toBe(true);
  });

  it("fails an engine file that uses document.", () => {
    write("engine/bad.ts", 'export const el = document.title;\n');
    const result = runChecks(root);
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("DOM access (document)");
  });

  it("fails an engine file that imports ../ui/x", () => {
    write("engine/bad.ts", 'import { x } from "../ui/x";\nexport const y = x;\n');
    write("ui/x.ts", "export const x = 1;\n");
    const result = runChecks(root);
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("../ui/x");
  });

  it("fails an engine file that imports main", () => {
    write("engine/bad.ts", 'import "../main";\n');
    write("main.ts", "export {};\n");
    expect(runChecks(root).ok).toBe(false);
  });

  it("fails the string-literal example with both findings", () => {
    write("engine/bad.ts", 'const marker = " // "; document.title; import { x } from "../ui/x";\n');
    const text = runChecks(root).messages.join("\n");
    expect(text).toContain("DOM access (document)");
    expect(text).toContain('import "../ui/x"');
  });

  it("fails a compact import of ../ui/x", () => {
    write("engine/bad.ts", 'import{x}from"../ui/x";\nexport const y = x;\n');
    expect(runChecks(root).ok).toBe(false);
  });

  it("fails a dynamic import of ../ui/x", () => {
    write("engine/bad.ts", 'export const load = () => import("../ui/x");\n');
    const result = runChecks(root);
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("../ui/x");
  });

  it("fails other DOM access in the engine", () => {
    write("engine/bad.ts", 'export const a = window.location;\nexport const b = (e: Element) => e.querySelector("p");\n');
    const text = runChecks(root).messages.join("\n");
    expect(text).toContain("(window)");
    expect(text).toContain("(querySelector)");
  });

  it("counts export-from as a cycle edge", () => {
    write("a.ts", 'export{x}from"./b";\n');
    write("b.ts", 'export{x}from"./a";\n');
    const result = runChecks(root);
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toMatch(/import cycle: a\.ts -> b\.ts -> a\.ts/);
  });

  it("passes multiline and type-only imports", () => {
    write("a.ts", 'import type {\n  B,\n} from "./b";\nimport {\n  c,\n} from "./c";\nexport const a: B = c;\n');
    write("b.ts", "export type B = number;\n");
    write("c.ts", "export const c = 1;\n");
    const result = runChecks(root);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("2 imports");
  });

  it("ignores document. in comments, strings and property names", () => {
    write(
      "engine/ok.ts",
      '/* document.title */\n// window.alert()\nexport const s = "document.title window.x querySelector(";\n' +
        "export const t = `getElementById`;\nexport const o = { document: 1 };\nexport const n = o.document;\n",
    );
    expect(runChecks(root).ok).toBe(true);
  });

  it.each([
    "export const a = globalThis.document.title;",
    'export const a = globalThis.document.createElement("div");',
    "export const a = self.document.body;",
    'export const a = window["document"];',
    'export const a = globalThis["document"];',
    "export const a = globalThis.window;",
  ])("fails an engine file with DOM access through a global receiver: %s", (code) => {
    write("engine/bad.ts", `${code}\n`);
    const result = runChecks(root);
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("DOM access");
  });

  it("passes obj.document, this.document, options.window and mentions in comments or strings", () => {
    write(
      "engine/ok.ts",
      "// globalThis.document.title\n/* self.document.body */\n" +
        'export const s = "globalThis.document.title";\n' +
        "export const t = `globalThis.document`;\n" +
        "const obj = { document: 1 };\nexport const a = obj.document;\n" +
        "export class K { document = 1; read() { return this.document; } }\n" +
        "export const w = (options: { window: number }) => options.window;\n",
    );
    expect(runChecks(root).ok).toBe(true);
  });

  it("fails an interpolated dynamic import under ui/", () => {
    write("engine/bad.ts", "export const load = (name: string) => import(`../ui/${name}.ts`);\n");
    const result = runChecks(root);
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("../ui/");
  });

  it("fails a concatenated dynamic import under ui/", () => {
    write("engine/bad.ts", 'export const load = (name: string) => import("../ui/" + name);\n');
    expect(runChecks(root).ok).toBe(false);
  });

  it("passes a local interpolated dynamic import without a finding", () => {
    write("engine/ok.ts", "export const load = (n: number) => import(`./local-${n}.ts`);\n");
    const result = runChecks(root);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("passes an unresolvable dynamic import with a warning", () => {
    write("engine/ok.ts", "export const load = (x: string) => import(`${x}`);\n");
    const result = runChecks(root);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(["unresolvable dynamic import at engine/ok.ts:1"]);
  });

  it("fails destructured DOM query methods", () => {
    write(
      "engine/bad.ts",
      "export const f = (x: ParentNode) => {\n  const { querySelector } = x;\n  const { getElementById: g } = x as unknown as Document;\n  return [querySelector, g];\n};\n",
    );
    const text = runChecks(root).messages.join("\n");
    expect(text).toContain("(querySelector)");
    expect(text).toContain("(getElementById)");
  });

  it("fails a two-file import cycle and prints the path", () => {
    write("a.ts", 'import { b } from "./b";\nexport const a = b;\n');
    write("b.ts", 'import { a } from "./a.js";\nexport const b = a;\n');
    const result = runChecks(root);
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toMatch(/import cycle: a\.ts -> b\.ts -> a\.ts/);
  });
});
