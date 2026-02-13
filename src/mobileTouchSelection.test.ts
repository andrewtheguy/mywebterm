import { describe, expect, test } from "bun:test";

import {
  clientPointToBufferCoord,
  computeEdgeAutoScrollVelocity,
  getWordRangeInLine,
  isLikelyIOS,
  normalizeSelectionRange,
  selectionRangeToXtermSelectArgs,
} from "./mobileTouchSelection";

describe("mobileTouchSelection", () => {
  test("detects iOS user agents and iPadOS mac disguise", () => {
    expect(isLikelyIOS("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", 5)).toBe(true);
    expect(
      isLikelyIOS(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
        5,
      ),
    ).toBe(true);
    expect(
      isLikelyIOS(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
        0,
      ),
    ).toBe(false);
  });

  test("maps client points to clamped buffer coordinates", () => {
    const screenRect = {
      left: 10,
      top: 20,
      right: 810,
      bottom: 500,
    };

    expect(
      clientPointToBufferCoord({
        clientPoint: { x: 15, y: 25 },
        screenRect,
        cols: 80,
        rows: 24,
        viewportY: 100,
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ col: 0, row: 100 });

    expect(
      clientPointToBufferCoord({
        clientPoint: { x: 89, y: 59 },
        screenRect,
        cols: 80,
        rows: 24,
        viewportY: 100,
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ col: 7, row: 101 });

    expect(
      clientPointToBufferCoord({
        clientPoint: { x: -100, y: -100 },
        screenRect,
        cols: 80,
        rows: 24,
        viewportY: 100,
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ col: 0, row: 100 });

    expect(
      clientPointToBufferCoord({
        clientPoint: { x: 9999, y: 9999 },
        screenRect,
        cols: 80,
        rows: 24,
        viewportY: 100,
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ col: 79, row: 123 });
  });

  test("finds word boundaries and falls back to nearest word from separators", () => {
    const line = "echo hello-world ok";
    expect(getWordRangeInLine(line, 6, " -", 80)).toEqual({
      startCol: 5,
      endCol: 9,
    });
    expect(getWordRangeInLine(line, 10, " -", 80)).toEqual({
      startCol: 11,
      endCol: 15,
    });
    expect(getWordRangeInLine("abc def", 3, " ", 80)).toEqual({
      startCol: 4,
      endCol: 6,
    });
    expect(getWordRangeInLine("   ", 1, " ", 80)).toEqual({
      startCol: 1,
      endCol: 1,
    });
  });

  test("normalizes ranges and converts to xterm select args", () => {
    const normalized = normalizeSelectionRange(
      { col: 8, row: 5 },
      { col: 2, row: 3 },
    );
    expect(normalized).toEqual({
      start: { col: 2, row: 3 },
      end: { col: 8, row: 5 },
    });

    expect(
      selectionRangeToXtermSelectArgs(
        {
          start: { col: 8, row: 5 },
          end: { col: 10, row: 5 },
        },
        80,
      ),
    ).toEqual({
      column: 8,
      row: 5,
      length: 3,
    });

    expect(
      selectionRangeToXtermSelectArgs(
        {
          start: { col: 78, row: 5 },
          end: { col: 2, row: 6 },
        },
        80,
      ),
    ).toEqual({
      column: 78,
      row: 5,
      length: 5,
    });
  });

  test("computes signed edge auto-scroll velocity", () => {
    expect(
      computeEdgeAutoScrollVelocity({
        clientY: 250,
        top: 100,
        bottom: 400,
      }),
    ).toBe(0);

    expect(
      computeEdgeAutoScrollVelocity({
        clientY: 105,
        top: 100,
        bottom: 400,
      }),
    ).toBeLessThan(0);

    expect(
      computeEdgeAutoScrollVelocity({
        clientY: 395,
        top: 100,
        bottom: 400,
      }),
    ).toBeGreaterThan(0);

    expect(
      computeEdgeAutoScrollVelocity({
        clientY: 0,
        top: 100,
        bottom: 400,
        maxVelocityPxPerSecond: 1200,
      }),
    ).toBe(-1200);

    expect(
      computeEdgeAutoScrollVelocity({
        clientY: 1000,
        top: 100,
        bottom: 400,
        maxVelocityPxPerSecond: 1200,
      }),
    ).toBe(1200);
  });
});
