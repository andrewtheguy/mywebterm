export type SoftModifierName = "ctrl" | "alt" | "shift";

export interface SoftKeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export const DEFAULT_SOFT_KEY_MODIFIERS: Readonly<SoftKeyModifiers> = Object.freeze({
  ctrl: false,
  alt: false,
  shift: false,
});

export const SOFT_MODIFIER_ORDER: readonly SoftModifierName[] = ["ctrl", "alt", "shift"];

export type SoftKeyGroup = "main" | "function";

export type SpecialSoftKeyId =
  | "tab"
  | "enter"
  | "backspace"
  | "escape"
  | "arrowUp"
  | "arrowDown"
  | "arrowLeft"
  | "arrowRight"
  | "home"
  | "end"
  | "pageUp"
  | "pageDown"
  | "insert"
  | "delete";

interface SoftKeyBase {
  id: string;
  label: string;
  group: SoftKeyGroup;
}

export interface PrintableSoftKeyDefinition extends SoftKeyBase {
  kind: "printable";
  value: string;
}

export interface SpecialSoftKeyDefinition extends SoftKeyBase {
  kind: "special";
  special: SpecialSoftKeyId;
}

export interface FunctionSoftKeyDefinition extends SoftKeyBase {
  kind: "function";
  number: number;
}

export type SoftKeyDefinition =
  | PrintableSoftKeyDefinition
  | SpecialSoftKeyDefinition
  | FunctionSoftKeyDefinition;

export type BuildSoftKeySequenceResult =
  | {
    ok: true;
    sequence: string;
    description: string;
  }
  | {
    ok: false;
    description: string;
    reason: string;
  };

function createPrintableKey(value: string, label = value): PrintableSoftKeyDefinition {
  return {
    id: `printable-${encodeURIComponent(value)}`,
    label,
    kind: "printable",
    value,
    group: "main",
  };
}

function createSpecialKey(
  special: SpecialSoftKeyId,
  label: string,
): SpecialSoftKeyDefinition {
  return {
    id: `special-${special}`,
    label,
    kind: "special",
    special,
    group: "main",
  };
}

function createFunctionKey(number: number): FunctionSoftKeyDefinition {
  return {
    id: `function-f${number}`,
    label: `F${number}`,
    kind: "function",
    number,
    group: "function",
  };
}

export const MAIN_SOFT_KEY_ROWS: readonly (readonly SoftKeyDefinition[])[] = [
  [
    createSpecialKey("tab", "Tab"),
    createSpecialKey("enter", "Enter"),
    createSpecialKey("backspace", "Backspace"),
    createSpecialKey("escape", "Esc"),
  ],
  [
    createPrintableKey("1"),
    createPrintableKey("2"),
    createPrintableKey("3"),
    createPrintableKey("4"),
    createPrintableKey("5"),
    createPrintableKey("6"),
    createPrintableKey("7"),
    createPrintableKey("8"),
    createPrintableKey("9"),
    createPrintableKey("0"),
    createPrintableKey("-"),
    createPrintableKey("="),
  ],
  [
    createPrintableKey("q", "Q"),
    createPrintableKey("w", "W"),
    createPrintableKey("e", "E"),
    createPrintableKey("r", "R"),
    createPrintableKey("t", "T"),
    createPrintableKey("y", "Y"),
    createPrintableKey("u", "U"),
    createPrintableKey("i", "I"),
    createPrintableKey("o", "O"),
    createPrintableKey("p", "P"),
  ],
  [
    createPrintableKey("a", "A"),
    createPrintableKey("s", "S"),
    createPrintableKey("d", "D"),
    createPrintableKey("f", "F"),
    createPrintableKey("g", "G"),
    createPrintableKey("h", "H"),
    createPrintableKey("j", "J"),
    createPrintableKey("k", "K"),
    createPrintableKey("l", "L"),
  ],
  [
    createPrintableKey("z", "Z"),
    createPrintableKey("x", "X"),
    createPrintableKey("c", "C"),
    createPrintableKey("v", "V"),
    createPrintableKey("b", "B"),
    createPrintableKey("n", "N"),
    createPrintableKey("m", "M"),
  ],
  [
    createPrintableKey("`"),
    createPrintableKey("["),
    createPrintableKey("]"),
    createPrintableKey("\\"),
    createPrintableKey(";"),
    createPrintableKey("'"),
    createPrintableKey(","),
    createPrintableKey("."),
    createPrintableKey("/"),
    createPrintableKey(" ", "Space"),
  ],
  [
    createSpecialKey("arrowUp", "Up"),
    createSpecialKey("arrowDown", "Down"),
    createSpecialKey("arrowLeft", "Left"),
    createSpecialKey("arrowRight", "Right"),
    createSpecialKey("home", "Home"),
    createSpecialKey("end", "End"),
    createSpecialKey("pageUp", "PgUp"),
    createSpecialKey("pageDown", "PgDn"),
    createSpecialKey("insert", "Ins"),
    createSpecialKey("delete", "Del"),
  ],
];

export const FUNCTION_SOFT_KEY_ROWS: readonly (readonly SoftKeyDefinition[])[] = [
  [createFunctionKey(1), createFunctionKey(2), createFunctionKey(3), createFunctionKey(4)],
  [createFunctionKey(5), createFunctionKey(6), createFunctionKey(7), createFunctionKey(8)],
  [createFunctionKey(9), createFunctionKey(10), createFunctionKey(11), createFunctionKey(12)],
];

const SHIFTED_PRINTABLE_MAP: Record<string, string> = {
  "`": "~",
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
};

const FUNCTION_F5_TO_F12_BASE_SEQUENCE: Record<number, number> = {
  5: 15,
  6: 17,
  7: 18,
  8: 19,
  9: 20,
  10: 21,
  11: 23,
  12: 24,
};

const FUNCTION_F1_TO_F4_SUFFIX: Record<number, string> = {
  1: "P",
  2: "Q",
  3: "R",
  4: "S",
};

function isNoModifiers(modifiers: SoftKeyModifiers): boolean {
  return !modifiers.ctrl && !modifiers.alt && !modifiers.shift;
}

function getModifierCode(modifiers: SoftKeyModifiers): number {
  return 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
}

function formatChordDescription(label: string, modifiers: SoftKeyModifiers): string {
  const parts: string[] = [];
  if (modifiers.ctrl) {
    parts.push("Ctrl");
  }
  if (modifiers.alt) {
    parts.push("Alt");
  }
  if (modifiers.shift) {
    parts.push("Shift");
  }

  parts.push(label === " " ? "Space" : label);
  return parts.join("+");
}

function success(
  sequence: string,
  label: string,
  modifiers: SoftKeyModifiers,
): BuildSoftKeySequenceResult {
  return {
    ok: true,
    sequence,
    description: formatChordDescription(label, modifiers),
  };
}

function failure(
  label: string,
  modifiers: SoftKeyModifiers,
  reason: string,
): BuildSoftKeySequenceResult {
  return {
    ok: false,
    description: formatChordDescription(label, modifiers),
    reason,
  };
}

function applyShiftToPrintable(baseValue: string, shift: boolean): string {
  if (!shift) {
    return baseValue;
  }

  if (/^[a-z]$/.test(baseValue)) {
    return baseValue.toUpperCase();
  }

  return SHIFTED_PRINTABLE_MAP[baseValue] ?? baseValue;
}

function toCtrlSequence(character: string): string | null {
  if (character.length !== 1) {
    return null;
  }

  const upper = character.toUpperCase();
  if (upper >= "A" && upper <= "Z") {
    const controlCode = upper.charCodeAt(0) - 64;
    return String.fromCharCode(controlCode);
  }

  switch (character) {
    case "@":
    case " ":
      return "\x00";
    case "[":
      return "\x1b";
    case "\\":
      return "\x1c";
    case "]":
      return "\x1d";
    case "^":
      return "\x1e";
    case "_":
      return "\x1f";
    case "?":
      return "\x7f";
    default:
      return null;
  }
}

function encodePrintableKey(
  key: PrintableSoftKeyDefinition,
  modifiers: SoftKeyModifiers,
): BuildSoftKeySequenceResult {
  const shiftedValue = applyShiftToPrintable(key.value, modifiers.shift);

  if (modifiers.ctrl) {
    const ctrlSequence = toCtrlSequence(shiftedValue);
    if (!ctrlSequence) {
      return failure(key.label, modifiers, "Unsupported Ctrl combo");
    }

    return success(
      `${modifiers.alt ? "\x1b" : ""}${ctrlSequence}`,
      key.label,
      modifiers,
    );
  }

  return success(`${modifiers.alt ? "\x1b" : ""}${shiftedValue}`, key.label, modifiers);
}

function encodeArrowOrCursorKey(
  baseSuffix: string,
  modifiers: SoftKeyModifiers,
): string {
  if (isNoModifiers(modifiers)) {
    return `\x1b[${baseSuffix}`;
  }

  return `\x1b[1;${getModifierCode(modifiers)}${baseSuffix}`;
}

function encodeTildeKey(baseCode: number, modifiers: SoftKeyModifiers): string {
  if (isNoModifiers(modifiers)) {
    return `\x1b[${baseCode}~`;
  }

  return `\x1b[${baseCode};${getModifierCode(modifiers)}~`;
}

function encodeSpecialKey(
  key: SpecialSoftKeyDefinition,
  modifiers: SoftKeyModifiers,
): BuildSoftKeySequenceResult {
  switch (key.special) {
    case "tab": {
      if (isNoModifiers(modifiers)) {
        return success("\t", key.label, modifiers);
      }

      if (modifiers.shift && !modifiers.ctrl && !modifiers.alt) {
        return success("\x1b[Z", key.label, modifiers);
      }

      return success(`\x1b[1;${getModifierCode(modifiers)}I`, key.label, modifiers);
    }
    case "enter": {
      if (modifiers.ctrl || modifiers.shift) {
        return failure(key.label, modifiers, "Unsupported Enter combo");
      }
      return success(`${modifiers.alt ? "\x1b" : ""}\r`, key.label, modifiers);
    }
    case "backspace": {
      if (modifiers.ctrl || modifiers.shift) {
        return failure(key.label, modifiers, "Unsupported Backspace combo");
      }
      return success(`${modifiers.alt ? "\x1b" : ""}\x7f`, key.label, modifiers);
    }
    case "escape": {
      if (modifiers.ctrl || modifiers.shift) {
        return failure(key.label, modifiers, "Unsupported Esc combo");
      }
      return success(`${modifiers.alt ? "\x1b" : ""}\x1b`, key.label, modifiers);
    }
    case "arrowUp":
      return success(encodeArrowOrCursorKey("A", modifiers), key.label, modifiers);
    case "arrowDown":
      return success(encodeArrowOrCursorKey("B", modifiers), key.label, modifiers);
    case "arrowRight":
      return success(encodeArrowOrCursorKey("C", modifiers), key.label, modifiers);
    case "arrowLeft":
      return success(encodeArrowOrCursorKey("D", modifiers), key.label, modifiers);
    case "home":
      return success(encodeArrowOrCursorKey("H", modifiers), key.label, modifiers);
    case "end":
      return success(encodeArrowOrCursorKey("F", modifiers), key.label, modifiers);
    case "insert":
      return success(encodeTildeKey(2, modifiers), key.label, modifiers);
    case "delete":
      return success(encodeTildeKey(3, modifiers), key.label, modifiers);
    case "pageUp":
      return success(encodeTildeKey(5, modifiers), key.label, modifiers);
    case "pageDown":
      return success(encodeTildeKey(6, modifiers), key.label, modifiers);
    default:
      return failure(key.label, modifiers, "Unsupported key");
  }
}

function encodeFunctionKey(
  key: FunctionSoftKeyDefinition,
  modifiers: SoftKeyModifiers,
): BuildSoftKeySequenceResult {
  if (key.number >= 1 && key.number <= 4) {
    const suffix = FUNCTION_F1_TO_F4_SUFFIX[key.number];
    if (!suffix) {
      return failure(key.label, modifiers, "Unknown function key");
    }

    if (isNoModifiers(modifiers)) {
      return success(`\x1bO${suffix}`, key.label, modifiers);
    }

    return success(`\x1b[1;${getModifierCode(modifiers)}${suffix}`, key.label, modifiers);
  }

  const baseCode = FUNCTION_F5_TO_F12_BASE_SEQUENCE[key.number];
  if (!baseCode) {
    return failure(key.label, modifiers, "Unknown function key");
  }

  if (isNoModifiers(modifiers)) {
    return success(`\x1b[${baseCode}~`, key.label, modifiers);
  }

  return success(`\x1b[${baseCode};${getModifierCode(modifiers)}~`, key.label, modifiers);
}

export function buildSoftKeySequence(
  key: SoftKeyDefinition,
  modifiers: SoftKeyModifiers,
): BuildSoftKeySequenceResult {
  switch (key.kind) {
    case "printable":
      return encodePrintableKey(key, modifiers);
    case "special":
      return encodeSpecialKey(key, modifiers);
    case "function":
      return encodeFunctionKey(key, modifiers);
    default:
      return {
        ok: false,
        description: formatChordDescription(key.label, modifiers),
        reason: "Unknown key type",
      };
  }
}

export function flattenSoftKeyRows(
  rows: readonly (readonly SoftKeyDefinition[])[],
): SoftKeyDefinition[] {
  return rows.flat();
}
