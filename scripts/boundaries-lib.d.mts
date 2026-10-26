export function listTsFiles(dir: string): string[];
export function importReferences(
  source: string,
  fileName?: string,
): { specifier: string; exact: boolean; line: number }[];
export function importSpecifiers(source: string, fileName?: string): string[];
export function domAccess(source: string, fileName?: string): string[];
export function checkEngine(
  engineDir: string,
  rootDir?: string,
): { violations: string[]; warnings: string[]; fileCount: number };
export function buildGraph(srcDir: string): Map<string, string[]>;
export function findCycles(srcDir: string): {
  cycles: string[][];
  fileCount: number;
  edgeCount: number;
};
export function runChecks(srcDir: string): {
  ok: boolean;
  messages: string[];
  warnings: string[];
  summary: string;
};
