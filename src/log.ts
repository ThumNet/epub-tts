const logElement = (): HTMLElement | null => document.getElementById("log");
const startedAt = performance.now();
const lines: string[] = [];

/** Append one timestamped line to the on-screen log. */
export function log(message: string): void {
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1).padStart(7, " ");
  const clock = new Date().toLocaleTimeString();
  const line = `${clock} +${seconds}s  ${message}`;
  lines.push(line);
  if (lines.length > 400) lines.shift();
  const element = logElement();
  if (element) {
    element.textContent = lines.join("\n");
    element.scrollTop = element.scrollHeight;
  }
  console.log(message);
}

export function logText(): string {
  return lines.join("\n");
}
