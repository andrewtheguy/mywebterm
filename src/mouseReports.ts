/**
 * Repairs the NaN-coordinate mouse reports xterm.js emits during touch-inertia
 * ("flick") scrolling.
 *
 * Its momentum gesture events are plain CustomEvents carrying only
 * translationX/Y (@xterm/xterm src/browser/scrollable/touch.ts, _inertia ->
 * _newGestureEvent) — no clientX/clientY, unlike the finger-down CHANGE events.
 * MouseService._handleTouchScrollAsWheel feeds them straight into
 * getCoordsRelativeToElement, where `undefined - rect.left` becomes NaN, and the
 * clamping in MouseCoordsService can't rescue that. Apps with mouse tracking on
 * (zellij, Claude Code) then get "\x1b[<65;NaN;NaNM" and render the tail they
 * can't parse as literal text in the prompt.
 *
 * Rewriting to the last position we saw a real report for (terminal centre if
 * there is none) keeps momentum scrolling working and lands it inside the pane
 * content, which is where the finger was.
 */

const MOUSE_REPORT_PREFIX = "\x1b[<";

// SGR mouse report: ESC [ < button ; col ; row (M press / m release). Built with
// new RegExp because \x1b in a literal trips noControlCharactersInRegex.
// biome-ignore lint/complexity/useRegexLiterals: literal form triggers noControlCharactersInRegex
const SGR_MOUSE_REPORT_RE = new RegExp("\\x1b\\[<(\\d+);(-?\\d+|NaN);(-?\\d+|NaN)([Mm])", "g");

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * Returns a stateful repair function for one terminal's outgoing data. Keep one
 * per terminal instance so the remembered position dies with the terminal.
 */
export function createMouseReportRepairer(getSize: () => TerminalSize): (data: string) => string {
  let lastValid: { x: number; y: number } | null = null;

  return (data: string): string => {
    if (!data.includes(MOUSE_REPORT_PREFIX)) {
      return data;
    }

    return data.replace(SGR_MOUSE_REPORT_RE, (match, button: string, x: string, y: string, action: string) => {
      if (x !== "NaN" && y !== "NaN") {
        lastValid = { x: Number(x), y: Number(y) };
        return match;
      }

      // Coordinates are 1-based cells; a remembered position can be stale after
      // a resize, so clamp it to the terminal as it is now.
      const { cols, rows } = getSize();
      const maxCol = Math.max(1, cols);
      const maxRow = Math.max(1, rows);
      const at = lastValid ?? { x: Math.ceil(maxCol / 2), y: Math.ceil(maxRow / 2) };
      return `${MOUSE_REPORT_PREFIX}${button};${clamp(at.x, 1, maxCol)};${clamp(at.y, 1, maxRow)}${action}`;
    });
  };
}
