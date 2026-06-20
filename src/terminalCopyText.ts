export function normalizeVisibleTerminalLines(lines: Iterable<string>): string {
  const normalizedLines: string[] = [];
  for (const line of lines) {
    normalizedLines.push(line.replaceAll("\u00a0", " ").replace(/[ \t]+$/g, ""));
  }
  return normalizedLines.join("\n").trimEnd();
}
