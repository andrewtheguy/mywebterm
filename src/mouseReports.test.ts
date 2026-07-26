import { expect, test } from "bun:test";
import { createMouseReportRepairer } from "./mouseReports";

const size = { cols: 80, rows: 24 };
const repairer = () => createMouseReportRepairer(() => size);

test("passes ordinary input through untouched", () => {
  const repair = repairer();
  expect(repair("ls -la\r")).toBe("ls -la\r");
  // "NaN" as plain text must survive — only mouse reports are rewritten
  expect(repair("echo NaN\r")).toBe("echo NaN\r");
  expect(repair("\x1b[A")).toBe("\x1b[A");
});

test("leaves valid mouse reports untouched", () => {
  const repair = repairer();
  expect(repair("\x1b[<65;12;20M")).toBe("\x1b[<65;12;20M");
  expect(repair("\x1b[<0;5;6m")).toBe("\x1b[<0;5;6m");
});

test("repairs NaN reports to the terminal centre when nothing better is known", () => {
  const repair = repairer();
  expect(repair("\x1b[<65;NaN;NaNM")).toBe("\x1b[<65;40;12M");
});

test("repairs NaN reports to the last real position", () => {
  const repair = repairer();
  repair("\x1b[<64;12;20M");
  expect(repair("\x1b[<65;NaN;NaNM")).toBe("\x1b[<65;12;20M");
  // a repaired report must not become the remembered position
  expect(repair("\x1b[<65;NaN;NaNM")).toBe("\x1b[<65;12;20M");
});

test("repairs a whole inertia burst in one chunk", () => {
  const repair = repairer();
  repair("\x1b[<64;7;8M");
  expect(repair("\x1b[<65;NaN;NaNM".repeat(3))).toBe("\x1b[<65;7;8M".repeat(3));
});

test("keeps valid and NaN reports straight when mixed in one chunk", () => {
  const repair = repairer();
  expect(repair("\x1b[<64;3;4M\x1b[<65;NaN;NaNM")).toBe("\x1b[<64;3;4M\x1b[<65;3;4M");
});

test("repairs a half-NaN report", () => {
  const repair = repairer();
  expect(repair("\x1b[<65;12;NaNM")).toBe("\x1b[<65;40;12M");
});

test("clamps a remembered position that a resize made out of range", () => {
  const current = { cols: 80, rows: 24 };
  const repair = createMouseReportRepairer(() => current);
  repair("\x1b[<64;78;22M");
  current.cols = 40;
  current.rows = 10;
  expect(repair("\x1b[<65;NaN;NaNM")).toBe("\x1b[<65;40;10M");
});

test("never emits a zero coordinate for a degenerate terminal size", () => {
  const repair = createMouseReportRepairer(() => ({ cols: 0, rows: 0 }));
  expect(repair("\x1b[<65;NaN;NaNM")).toBe("\x1b[<65;1;1M");
});
