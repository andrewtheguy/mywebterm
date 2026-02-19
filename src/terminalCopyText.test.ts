import { describe, expect, test } from "bun:test";

import { extractVisibleTerminalRowsText, normalizeVisibleTerminalLines } from "./terminalCopyText";

function mockRowsElement(rows: Array<{ textContent?: string | null; innerHTML?: string }>): Element {
  const children = {
    length: rows.length,
    item(index: number): Element | null {
      return (rows[index] as Element | undefined) ?? null;
    },
    namedItem(_name: string): Element | null {
      return null;
    },
    *[Symbol.iterator](): IterableIterator<Element> {
      for (const row of rows) {
        yield row as Element;
      }
    },
  } as unknown as HTMLCollectionOf<Element> & Iterable<Element> & { [index: number]: Element };

  for (const [index, row] of rows.entries()) {
    children[index] = row as Element;
  }

  return { children } as unknown as Element;
}

describe("terminalCopyText", () => {
  test("returns empty string when rows element is missing", () => {
    expect(extractVisibleTerminalRowsText(null)).toBe("");
  });

  test("extracts row text via textContent (not HTML)", () => {
    const rowsElement = mockRowsElement([
      { textContent: "alpha", innerHTML: "<span>alpha</span>" },
      { textContent: "beta", innerHTML: "<b>be</b><i>ta</i>" },
    ]);

    expect(extractVisibleTerminalRowsText(rowsElement)).toBe("alpha\nbeta");
  });

  test("normalizes NBSP and trims right-side row padding", () => {
    const text = normalizeVisibleTerminalLines(["one\u00a0\u00a0  ", "two   ", "   "]);
    expect(text).toBe("one\ntwo");
  });

  test("keeps row order and blank rows between content", () => {
    const rowsElement = mockRowsElement([{ textContent: "first" }, { textContent: "" }, { textContent: "third" }]);
    expect(extractVisibleTerminalRowsText(rowsElement)).toBe("first\n\nthird");
  });
});
