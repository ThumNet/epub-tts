// Boundary check: engine files stay free of DOM and UI imports, and src/ has no import cycles.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks } from "./boundaries-lib.mjs";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const result = runChecks(srcDir);

for (const warning of result.warnings) console.warn(`warning: ${warning}`);

if (result.ok) {
  console.log(result.summary);
} else {
  console.error("boundary check FAILED:");
  for (const message of result.messages) console.error(`  - ${message}`);
  process.exit(1);
}
