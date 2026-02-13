import { describe, expect, test } from "bun:test";

import {
  buildSoftKeySequence,
  DEFAULT_SOFT_KEY_MODIFIERS,
  flattenSoftKeyRows,
  FUNCTION_SOFT_KEY_ROWS,
  MAIN_SOFT_KEY_ROWS,
  type SoftKeyDefinition,
  type SoftKeyModifiers,
} from "./softKeyboard";

const mainKeys = flattenSoftKeyRows(MAIN_SOFT_KEY_ROWS);
const functionKeys = flattenSoftKeyRows(FUNCTION_SOFT_KEY_ROWS);
const allKeys = [...mainKeys, ...functionKeys];

function findKey(label: string): SoftKeyDefinition {
  const key = allKeys.find(candidate => candidate.label === label);
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
  test("groups function keys under advanced rows", () => {
    const functionLabels = functionKeys.map(key => key.label);
    expect(functionLabels).toEqual([
      "F1",
      "F2",
      "F3",
      "F4",
      "F5",
      "F6",
      "F7",
      "F8",
      "F9",
      "F10",
      "F11",
      "F12",
    ]);

    for (const key of functionKeys) {
      expect(key.group).toBe("function");
    }

    for (const key of mainKeys) {
      expect(key.group).toBe("main");
    }
  });

  test("does not define direct Ctrl+Shift+C shortcut button", () => {
    const hasDirectShortcut = allKeys.some(
      key => key.label.toLowerCase() === "ctrl+shift+c" || key.id.toLowerCase().includes("ctrl-shift-c"),
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

    const allModifiersF12 = buildSoftKeySequence(
      findKey("F12"),
      withModifiers({ ctrl: true, alt: true, shift: true }),
    );
    expect(allModifiersF12.ok).toBe(true);
    if (allModifiersF12.ok) {
      expect(allModifiersF12.sequence).toBe("\x1b[24;8~");
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

    const ctrlAltUp = buildSoftKeySequence(findKey("Up"), withModifiers({ ctrl: true, alt: true }));
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
