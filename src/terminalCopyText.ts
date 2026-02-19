export function normalizeVisibleTerminalLines(lines: Iterable<string>): string {
  const normalizedLines: string[] = [];
  for (const line of lines) {
    normalizedLines.push(line.replaceAll("\u00a0", " ").replace(/[ \t]+$/g, ""));
  }
  return normalizedLines.join("\n").trimEnd();
}

export function extractVisibleTerminalRowsText(rowsElement: Element | null): string {
  if (!rowsElement) {
    return "";
  }

  const rowLines = Array.from(rowsElement.children).map((child) => child.textContent ?? "");

  return normalizeVisibleTerminalLines(rowLines);
}
