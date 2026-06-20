import { describe, expect, test } from "bun:test";

import { normalizeVisibleTerminalLines } from "./terminalCopyText";

describe("terminalCopyText", () => {
  test("normalizes NBSP and trims right-side row padding", () => {
    const nbsp = String.fromCharCode(0xa0);
    const text = normalizeVisibleTerminalLines([`one${nbsp}${nbsp}  `, "two   ", "   "]);
    expect(text).toBe("one\ntwo");
  });
});
