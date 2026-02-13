import type { Terminal } from "@xterm/xterm";

export interface BufferCoord {
  col: number;
  row: number;
}

export interface SelectionRange {
  start: BufferCoord;
  end: BufferCoord;
}

export interface Point {
  x: number;
  y: number;
}

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PointToBufferCoordOptions {
  clientPoint: Point;
  screenRect: RectLike;
  cols: number;
  rows: number;
  viewportY: number;
  cellWidth: number;
  cellHeight: number;
}

export interface HandleAnchorOptions {
  coord: BufferCoord;
  side: "start" | "end";
  screenRect: RectLike;
  viewportY: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
}

export interface EdgeAutoScrollOptions {
  clientY: number;
  top: number;
  bottom: number;
  thresholdPx?: number;
  maxVelocityPxPerSecond?: number;
}

export interface XtermSelectionArgs {
  column: number;
  row: number;
  length: number;
}

export const DEFAULT_WORD_SEPARATORS = " ()[]{}',\"`";
const DEFAULT_SCROLL_EDGE_THRESHOLD_PX = 56;
const DEFAULT_MAX_SCROLL_VELOCITY_PX_PER_SECOND = 900;

export function clamp(value: number, min: number, max: number): number {
  if (value <= min) {
    return min;
  }
  if (value >= max) {
    return max;
  }
  return value;
}

export function isLikelyIOS(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPad|iPhone|iPod/i.test(userAgent)) {
    return true;
  }

  // iPadOS can present itself as macOS in Safari.
  if (/Mac/i.test(userAgent) && maxTouchPoints > 1) {
    return true;
  }

  return false;
}

export function getWordSeparators(terminal: Terminal): string {
  const separators = terminal.options.wordSeparator;
  if (typeof separators === "string" && separators.length > 0) {
    return separators;
  }
  return DEFAULT_WORD_SEPARATORS;
}

export function clientPointToBufferCoord({
  clientPoint,
  screenRect,
  cols,
  rows,
  viewportY,
  cellWidth,
  cellHeight,
}: PointToBufferCoordOptions): BufferCoord {
  const x = clientPoint.x - screenRect.left;
  const y = clientPoint.y - screenRect.top;
  const col = clamp(Math.floor(x / cellWidth), 0, Math.max(cols - 1, 0));
  const viewportRow = clamp(Math.floor(y / cellHeight), 0, Math.max(rows - 1, 0));
  return {
    col,
    row: viewportY + viewportRow,
  };
}

function isWordSeparator(character: string, separators: string): boolean {
  if (character.length === 0) {
    return true;
  }
  if (/\s/.test(character)) {
    return true;
  }
  return separators.includes(character);
}

export function getWordRangeInLine(
  line: string,
  column: number,
  separators: string,
  maxColumns: number,
): { startCol: number; endCol: number } {
  const maxIndex = Math.max(0, maxColumns - 1);
  const safeColumn = clamp(column, 0, maxIndex);
  if (line.length === 0) {
    return {
      startCol: safeColumn,
      endCol: safeColumn,
    };
  }

  const effectiveColumn = Math.min(safeColumn, Math.max(0, line.length - 1));
  let anchor = effectiveColumn;
  const anchorChar = line[anchor] ?? "";

  if (isWordSeparator(anchorChar, separators)) {
    let foundWordColumn: number | null = null;
    for (let index = anchor + 1; index < line.length; index += 1) {
      if (!isWordSeparator(line[index] ?? "", separators)) {
        foundWordColumn = index;
        break;
      }
    }

    if (foundWordColumn === null) {
      for (let index = anchor - 1; index >= 0; index -= 1) {
        if (!isWordSeparator(line[index] ?? "", separators)) {
          foundWordColumn = index;
          break;
        }
      }
    }

    if (foundWordColumn === null) {
      return {
        startCol: safeColumn,
        endCol: safeColumn,
      };
    }

    anchor = foundWordColumn;
  }

  let startCol = anchor;
  let endCol = anchor;

  while (startCol > 0 && !isWordSeparator(line[startCol - 1] ?? "", separators)) {
    startCol -= 1;
  }
  while (endCol + 1 < line.length && !isWordSeparator(line[endCol + 1] ?? "", separators)) {
    endCol += 1;
  }

  return {
    startCol: clamp(startCol, 0, maxIndex),
    endCol: clamp(endCol, 0, maxIndex),
  };
}

export function normalizeSelectionRange(start: BufferCoord, end: BufferCoord): SelectionRange {
  if (start.row < end.row || (start.row === end.row && start.col <= end.col)) {
    return { start, end };
  }
  return {
    start: end,
    end: start,
  };
}

export function selectionRangeToXtermSelectArgs(range: SelectionRange, cols: number): XtermSelectionArgs {
  const normalized = normalizeSelectionRange(range.start, range.end);
  const rowsBetween = normalized.end.row - normalized.start.row;
  const length = rowsBetween * cols + (normalized.end.col - normalized.start.col) + 1;

  return {
    column: normalized.start.col,
    row: normalized.start.row,
    length: Math.max(1, length),
  };
}

export function toHandleAnchorClientPoint({
  coord,
  side,
  screenRect,
  viewportY,
  rows,
  cellWidth,
  cellHeight,
}: HandleAnchorOptions): Point {
  const viewportRow = clamp(coord.row - viewportY, 0, Math.max(rows - 1, 0));
  const columnOffset = side === "end" ? coord.col + 1 : coord.col;
  return {
    x: screenRect.left + columnOffset * cellWidth,
    y: screenRect.top + (viewportRow + 1) * cellHeight,
  };
}

export function computeEdgeAutoScrollVelocity({
  clientY,
  top,
  bottom,
  thresholdPx = DEFAULT_SCROLL_EDGE_THRESHOLD_PX,
  maxVelocityPxPerSecond = DEFAULT_MAX_SCROLL_VELOCITY_PX_PER_SECOND,
}: EdgeAutoScrollOptions): number {
  if (thresholdPx <= 0 || bottom <= top) {
    return 0;
  }

  const topThreshold = top + thresholdPx;
  if (clientY < topThreshold) {
    const ratio = clamp((topThreshold - clientY) / thresholdPx, 0, 1);
    return -maxVelocityPxPerSecond * ratio * ratio;
  }

  const bottomThreshold = bottom - thresholdPx;
  if (clientY > bottomThreshold) {
    const ratio = clamp((clientY - bottomThreshold) / thresholdPx, 0, 1);
    return maxVelocityPxPerSecond * ratio * ratio;
  }

  return 0;
}
