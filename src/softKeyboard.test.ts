import { describe, expect, test } from "bun:test";

import {
  buildSoftKeySequence,
  COMBO_KEY_ROW,
  type ComboSoftKeyDefinition,
  DEFAULT_SOFT_KEY_MODIFIERS,
  FUNCTION_KEY_ROW,
  FUNCTION_SCREEN_ROWS,
  flattenSoftKeyRows,
  PRIMARY_SCREEN_ROWS,
  SECONDARY_SCREEN_ROWS,
  type SoftKeyDefinition,
  type SoftKeyModifiers,
} from "./softKeyboard";

const primaryKeys = flattenSoftKeyRows(PRIMARY_SCREEN_ROWS);
const secondaryKeys = flattenSoftKeyRows(SECONDARY_SCREEN_ROWS);
const functionKeys = flattenSoftKeyRows(FUNCTION_SCREEN_ROWS);
const allKeys = [...primaryKeys, ...secondaryKeys, ...functionKeys];

function findKey(label: string): SoftKeyDefinition {
  const key = allKeys.find((candidate) => candidate.label === label);
  if (!key) {
    throw new Error(`Missing key: ${label}`);
  }
  return key;
}

function withModifiers(overrides: Partial<SoftKeyModifiers>): SoftKeyModifiers {
  return {
    ...DEFAULT_SOFT_KEY_MODIFIERS,
    ...overrides,
  };
}

describe("softKeyboard", () => {
  test("all screens have max 10 keys per content row", () => {
    for (const screen of [PRIMARY_SCREEN_ROWS, SECONDARY_SCREEN_ROWS, FUNCTION_SCREEN_ROWS]) {
      for (const row of screen) {
        expect(row.length).toBeLessThanOrEqual(10);
      }
    }
  });

  test("primary screen has all 26 letters and digits 0-9", () => {
    const labels = primaryKeys.map((k) => k.label);
    for (let i = 0; i <= 9; i++) {
      expect(labels).toContain(String(i));
    }
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      expect(labels).toContain(ch);
    }
  });

  test("function screen has F1-F12", () => {
    const labels = functionKeys.map((k) => k.label);
    for (let i = 1; i <= 12; i++) {
      expect(labels).toContain(`F${i}`);
    }
    for (const key of functionKeys) {
      if (key.kind === "function") {
        expect(key.group).toBe("function");
      }
    }
  });

  test("does not define direct Ctrl+Shift+C shortcut button", () => {
    const hasDirectShortcut = allKeys.some(
      (key) => key.label.toLowerCase() === "ctrl+shift+c" || key.id.toLowerCase().includes("ctrl-shift-c"),
    );

    expect(hasDirectShortcut).toBe(false);
  });

  test("encodes function keys and best-effort modified function keys", () => {
    const expectedUnmodifiedFn: Array<[string, string]> = [
      ["F1", "\x1bOP"],
      ["F2", "\x1bOQ"],
      ["F3", "\x1bOR"],
      ["F4", "\x1bOS"],
      ["F5", "\x1b[15~"],
      ["F6", "\x1b[17~"],
      ["F7", "\x1b[18~"],
      ["F8", "\x1b[19~"],
      ["F9", "\x1b[20~"],
      ["F10", "\x1b[21~"],
      ["F11", "\x1b[23~"],
      ["F12", "\x1b[24~"],
    ];

    for (const [label, expectedSequence] of expectedUnmodifiedFn) {
      const result = buildSoftKeySequence(findKey(label), withModifiers({}));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        continue;
      }
      expect(result.sequence).toBe(expectedSequence);
    }

    const shiftF1 = buildSoftKeySequence(findKey("F1"), withModifiers({ shift: true }));
    expect(shiftF1.ok).toBe(true);
    if (shiftF1.ok) {
      expect(shiftF1.sequence).toBe("\x1b[1;2P");
    }

    const ctrlAltF4 = buildSoftKeySequence(findKey("F4"), withModifiers({ ctrl: true, alt: true }));
    expect(ctrlAltF4.ok).toBe(true);
    if (ctrlAltF4.ok) {
      expect(ctrlAltF4.sequence).toBe("\x1b[1;7S");
    }

    const shiftF5 = buildSoftKeySequence(findKey("F5"), withModifiers({ shift: true }));
    expect(shiftF5.ok).toBe(true);
    if (shiftF5.ok) {
      expect(shiftF5.sequence).toBe("\x1b[15;2~");
    }

    const allModifiersF12 = buildSoftKeySequence(findKey("F12"), withModifiers({ ctrl: true, alt: true, shift: true }));
    expect(allModifiersF12.ok).toBe(true);
    if (allModifiersF12.ok) {
      expect(allModifiersF12.sequence).toBe("\x1b[24;8~");
    }
  });

  test("FUNCTION_KEY_ROW contains F1-F12 in order", () => {
    expect(FUNCTION_KEY_ROW).toHaveLength(12);
    for (let i = 0; i < 12; i++) {
      const fkey = FUNCTION_KEY_ROW[i] as SoftKeyDefinition;
      expect(fkey.kind).toBe("function");
      expect(fkey.label).toBe(`F${i + 1}`);
      if (fkey.kind === "function") {
        expect(fkey.number).toBe(i + 1);
      }
    }
  });

  test("secondary row 4 contains Bksp as special backspace key", () => {
    const row4 = SECONDARY_SCREEN_ROWS[4] as readonly SoftKeyDefinition[];
    const bksp = row4.find((k) => k.label === "Bksp");
    expect(bksp).toBeDefined();
    expect(bksp?.kind).toBe("special");
    if (bksp?.kind === "special") {
      expect(bksp.special).toBe("backspace");
    }
  });

  test("secondary rows have at most 8 keys per row after redundancy removal", () => {
    for (const row of SECONDARY_SCREEN_ROWS) {
      expect(row.length).toBeLessThanOrEqual(8);
    }
  });

  test("secondary row 2 ends with arrow-alignable keys", () => {
    const row2 = SECONDARY_SCREEN_ROWS[2] as readonly SoftKeyDefinition[];
    const labels = row2.map((k) => k.label);
    expect(labels.slice(-3)).toEqual([",", "▲", "Ins"]);
  });

  test("secondary row 3 contains PgUp, PgDn and arrow keys", () => {
    const row3 = SECONDARY_SCREEN_ROWS[3] as readonly SoftKeyDefinition[];
    const labels = row3.map((k) => k.label);
    expect(labels).toEqual(["PgUp", "PgDn", "◀", "▼", "▶"]);
  });

  test("COMBO_KEY_ROW contains expected entries", () => {
    const labels = COMBO_KEY_ROW.map((k) => k.label);
    expect(labels).toEqual([
      "Esc",
      "Tab",
      "^C",
      "^D",
      "^Z",
      "^A",
      "^E",
      "^R",
      "^B",
      "^W",
      "^N",
      "^T",
      "^L",
      "^K",
      "^Q",
    ]);
    function isCombo(k: SoftKeyDefinition): k is ComboSoftKeyDefinition {
      return k.kind === "combo";
    }
    const combos = COMBO_KEY_ROW.filter(isCombo);
    for (const combo of combos) {
      expect(combo.modifiers.ctrl).toBe(true);
    }
  });

  test("combo key encoding produces correct sequences", () => {
    const expectations: Array<[string, string]> = [
      ["^C", "\x03"],
      ["^D", "\x04"],
      ["^Z", "\x1a"],
      ["^A", "\x01"],
      ["^E", "\x05"],
      ["^R", "\x12"],
      ["^B", "\x02"],
      ["^W", "\x17"],
      ["^N", "\x0e"],
      ["^T", "\x14"],
      ["^L", "\x0c"],
      ["^K", "\x0b"],
      ["^Q", "\x11"],
    ];

    for (const [label, expectedSequence] of expectations) {
      const combo = COMBO_KEY_ROW.find((k) => k.label === label);
      expect(combo).toBeDefined();
      if (!combo) continue;
      const result = buildSoftKeySequence(combo, withModifiers({}));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sequence).toBe(expectedSequence);
      }
    }
  });

  test("combo key ignores passed-in modifiers", () => {
    const ctrlC = COMBO_KEY_ROW.find((k) => k.label === "^C");
    expect(ctrlC).toBeDefined();
    if (!ctrlC) return;

    const withShift = buildSoftKeySequence(ctrlC, withModifiers({ shift: true }));
    const withAlt = buildSoftKeySequence(ctrlC, withModifiers({ alt: true }));
    const withAll = buildSoftKeySequence(ctrlC, withModifiers({ ctrl: true, alt: true, shift: true }));
    const plain = buildSoftKeySequence(ctrlC, withModifiers({}));

    expect(withShift.ok).toBe(true);
    expect(withAlt.ok).toBe(true);
    expect(withAll.ok).toBe(true);
    expect(plain.ok).toBe(true);

    if (withShift.ok && withAlt.ok && withAll.ok && plain.ok) {
      expect(withShift.sequence).toBe("\x03");
      expect(withAlt.sequence).toBe("\x03");
      expect(withAll.sequence).toBe("\x03");
      expect(plain.sequence).toBe("\x03");
    }
  });

  test("encodes printable and navigation keys with ctrl/alt/shift modifiers", () => {
    const ctrlShiftC = buildSoftKeySequence(findKey("C"), withModifiers({ ctrl: true, shift: true }));
    expect(ctrlShiftC.ok).toBe(true);
    if (ctrlShiftC.ok) {
      expect(ctrlShiftC.sequence).toBe("\x03");
    }

    const altA = buildSoftKeySequence(findKey("A"), withModifiers({ alt: true }));
    expect(altA.ok).toBe(true);
    if (altA.ok) {
      expect(altA.sequence).toBe("\x1ba");
    }

    const ctrlShiftTwo = buildSoftKeySequence(findKey("2"), withModifiers({ ctrl: true, shift: true }));
    expect(ctrlShiftTwo.ok).toBe(true);
    if (ctrlShiftTwo.ok) {
      expect(ctrlShiftTwo.sequence).toBe("\x00");
    }

    const ctrlAltUp = buildSoftKeySequence(findKey("▲"), withModifiers({ ctrl: true, alt: true }));
    expect(ctrlAltUp.ok).toBe(true);
    if (ctrlAltUp.ok) {
      expect(ctrlAltUp.sequence).toBe("\x1b[1;7A");
    }

    const shiftTab = buildSoftKeySequence(findKey("Tab"), withModifiers({ shift: true }));
    expect(shiftTab.ok).toBe(true);
    if (shiftTab.ok) {
      expect(shiftTab.sequence).toBe("\x1b[Z");
    }
  });
});
