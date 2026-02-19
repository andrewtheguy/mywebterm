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

  const rowLines: string[] = [];
  for (const rowElement of Array.from(rowsElement.children)) {
    rowLines.push(rowElement.textContent ?? "");
  }

  return normalizeVisibleTerminalLines(rowLines);
}
