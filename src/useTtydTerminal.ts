import { FitAddon } from "@xterm/addon-fit";
import { type IDisposable, type ITerminalOptions, Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";

import "@xterm/xterm/css/xterm.css";

import {
  clamp,
  clientPointToBufferCoord,
  computeEdgeAutoScrollVelocity,
  getWordRangeInLine,
  getWordSeparators,
  isLikelyIOS,
  normalizeSelectionRange,
  type Point,
  type SelectionRange,
  selectionRangeToXtermSelectArgs,
  toHandleAnchorClientPoint,
} from "./mobileTouchSelection";
import { buildHandshake, decodeFrame, encodeInput, encodeResize, ServerCommand } from "./ttydProtocol";

export type { BufferCoord, SelectionRange } from "./mobileTouchSelection";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export type MobileSelectionHandle = "start" | "end";
export type MobileSelectionMode = "idle" | "pendingLongPress" | "selecting" | "draggingStart" | "draggingEnd";
export type MobileMouseMode = "nativeScroll" | "passToTerminal";
export type PasteResult = "pasted" | "empty" | "fallback-required" | "terminal-unavailable" | "wrong-mode";

export interface MobileOverlayAnchor {
  left: number;
  top: number;
}

export interface MobileSelectionState {
  enabled: boolean;
  mode: MobileSelectionMode;
  activeHandle: MobileSelectionHandle | null;
  range: SelectionRange | null;
  startHandle: MobileOverlayAnchor | null;
  endHandle: MobileOverlayAnchor | null;
  toolbarAnchor: MobileOverlayAnchor | null;
}

interface UseTtydTerminalOptions {
  wsUrl?: string;
  onTitleChange?: (title: string) => void;
}

interface UseTtydTerminalResult {
  containerRef: (node: HTMLDivElement | null) => void;
  connectionStatus: ConnectionStatus;
  statusMessage: string;
  reconnect: () => void;
  focusSoftKeyboard: () => void;
  sendSoftKeySequence: (sequence: string, label: string) => boolean;
  attemptPasteFromClipboard: () => Promise<PasteResult>;
  pasteTextIntoTerminal: (text: string) => boolean;
  copySelection: () => Promise<void>;
  copyRecentOutput: () => Promise<void>;
  getSelectableText: () => string;
  mobileSelectionState: MobileSelectionState;
  mobileMouseMode: MobileMouseMode;
  clearMobileSelection: () => void;
  setActiveHandle: (handle: MobileSelectionHandle | null) => void;
  updateActiveHandleFromClientPoint: (clientX: number, clientY: number) => void;
  toggleMobileMouseMode: () => void;
  horizontalOverflow: boolean;
  containerElement: HTMLDivElement | null;
}

const terminalOptions: ITerminalOptions = {
  cursorBlink: true,
  convertEol: true,
  scrollback: 5000,
  fontSize: 14,
  fontFamily:
    "Iosevka Term, IosevkaTerm Nerd Font Mono, JetBrainsMono Nerd Font Mono, JetBrains Mono, Symbols Nerd Font Mono, Menlo, monospace",
  theme: {
    background: "#041425",
    foreground: "#d8ecff",
    cursor: "#71f1d6",
    selectionBackground: "#17416a",
  },
};

const MIN_COLS = 60;
const DEFAULT_SCROLLBAR_WIDTH = 14;
const RECENT_OUTPUT_LINES = 2000;
const MOBILE_LONG_PRESS_MS = 420;
const MOBILE_LONG_PRESS_CANCEL_DISTANCE_PX = 8;
const MOBILE_TOOLBAR_GAP_PX = 10;
const MOBILE_TOOLBAR_ESTIMATED_HEIGHT_PX = 44;
const MOBILE_TOOLBAR_ESTIMATED_HALF_WIDTH_PX = 132;
const MOBILE_TOOLBAR_SAFE_TOP_PX = 8;
const MOBILE_TOOLBAR_SAFE_BOTTOM_PX = 8;
const MOBILE_TOOLBAR_SIDE_PADDING_PX = 16;
const MOBILE_HANDLE_SAFE_EDGE_PX = 8;
const AUTO_SCROLL_LAYOUT_MAX_RETRIES = 24;
const FALLBACK_PIXELS_PER_LINE = 12;

type TerminalLayout = {
  containerRect: DOMRect;
  screenRect: DOMRect;
  cols: number;
  rows: number;
  viewportY: number;
  cellWidth: number;
  cellHeight: number;
};

type PendingTouch = {
  identifier: number;
  startPoint: Point;
  latestPoint: Point;
};

type ScrollGesture = {
  identifier: number;
  lastY: number;
  remainderPx: number;
};

function collectRecentOutput(terminal: Terminal, maxLines = RECENT_OUTPUT_LINES): string {
  const activeBuffer = terminal.buffer.active;
  const endLine = activeBuffer.baseY + activeBuffer.cursorY;
  const startLine = Math.max(0, endLine - maxLines + 1);
  const outputLines: string[] = [];

  for (let lineIndex = startLine; lineIndex <= endLine; lineIndex += 1) {
    const bufferLine = activeBuffer.getLine(lineIndex);
    if (!bufferLine) {
      continue;
    }
    outputLines.push(bufferLine.translateToString(true));
  }

  return outputLines.join("\n").trimEnd();
}

async function writeClipboardText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy copy flow.
    }
  }

  if (typeof document === "undefined") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

function createInitialMobileSelectionState(enabled: boolean): MobileSelectionState {
  return {
    enabled,
    mode: "idle",
    activeHandle: null,
    range: null,
    startHandle: null,
    endHandle: null,
    toolbarAnchor: null,
  };
}

function getDragMode(handle: MobileSelectionHandle | null): MobileSelectionMode {
  if (handle === "start") {
    return "draggingStart";
  }
  if (handle === "end") {
    return "draggingEnd";
  }
  return "selecting";
}

function euclideanDistance(pointA: Point, pointB: Point): number {
  return Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
}

export function useTtydTerminal({ wsUrl, onTitleChange }: UseTtydTerminalOptions): UseTtydTerminalResult {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [statusMessage, setStatusMessage] = useState("Waiting for terminal.");
  const [reconnectToken, setReconnectToken] = useState(0);

  const mobileTouchSupported =
    typeof navigator !== "undefined" && isLikelyIOS(navigator.userAgent, navigator.maxTouchPoints ?? 0);

  const [mobileSelectionState, setMobileSelectionState] = useState<MobileSelectionState>(() =>
    createInitialMobileSelectionState(mobileTouchSupported),
  );
  const [mobileMouseMode, setMobileMouseMode] = useState<MobileMouseMode>("nativeScroll");
  const [horizontalOverflow, setHorizontalOverflow] = useState(false);

  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const decoderRef = useRef(new TextDecoder());
  const terminalDisposablesRef = useRef<IDisposable[]>([]);
  const onTitleChangeRef = useRef(onTitleChange);
  const connectionEpochRef = useRef(0);

  const pendingTouchRef = useRef<PendingTouch | null>(null);
  const scrollGestureRef = useRef<ScrollGesture | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const activeHandleRef = useRef<MobileSelectionHandle | null>(null);
  const selectionRangeRef = useRef<SelectionRange | null>(null);
  const dragPointRef = useRef<Point | null>(null);
  const autoScrollAnimationRef = useRef<number | null>(null);
  const autoScrollLastTimestampRef = useRef<number | null>(null);
  const autoScrollRemainderPxRef = useRef(0);
  const autoScrollLayoutRetryRef = useRef(0);
  const terminalMountedRef = useRef(false);
  const customFitRef = useRef<(() => void) | null>(null);

  const getTerminalLayout = useCallback((): TerminalLayout | null => {
    const terminal = terminalRef.current;
    if (!terminal || !container) {
      return null;
    }

    const dimensions = terminal.dimensions;
    if (!dimensions) {
      return null;
    }

    const screenElement = container.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screenElement) {
      return null;
    }

    const cellWidth = dimensions.css.cell.width;
    const cellHeight = dimensions.css.cell.height;
    if (cellWidth <= 0 || cellHeight <= 0) {
      return null;
    }

    return {
      containerRect: container.getBoundingClientRect(),
      screenRect: screenElement.getBoundingClientRect(),
      cols: terminal.cols,
      rows: terminal.rows,
      viewportY: terminal.buffer.active.viewportY,
      cellWidth,
      cellHeight,
    };
  }, [container]);

  const clearScrollGesture = useCallback(() => {
    scrollGestureRef.current = null;
  }, []);

  const emitWheelDelta = useCallback(
    (deltaY: number) => {
      const terminal = terminalRef.current;
      if (!terminal || deltaY === 0) {
        return;
      }

      const viewportElement = container?.querySelector(".xterm-viewport") as HTMLElement | null;
      if (viewportElement && typeof WheelEvent !== "undefined") {
        const wheelEvent = new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          deltaY,
        });
        viewportElement.dispatchEvent(wheelEvent);
        return;
      }

      const fallbackLineDelta =
        deltaY >= 0 ? Math.floor(deltaY / FALLBACK_PIXELS_PER_LINE) : Math.ceil(deltaY / FALLBACK_PIXELS_PER_LINE);
      if (fallbackLineDelta !== 0) {
        terminal.scrollLines(fallbackLineDelta);
      }
    },
    [container],
  );

  const stopAutoScrollLoop = useCallback(() => {
    if (autoScrollAnimationRef.current !== null) {
      window.cancelAnimationFrame(autoScrollAnimationRef.current);
      autoScrollAnimationRef.current = null;
    }
    autoScrollLastTimestampRef.current = null;
    autoScrollRemainderPxRef.current = 0;
    autoScrollLayoutRetryRef.current = 0;
  }, []);

  const setMobileVisualStateFromRange = useCallback(
    (range: SelectionRange | null, mode: MobileSelectionMode, activeHandle: MobileSelectionHandle | null) => {
      if (!mobileTouchSupported) {
        setMobileSelectionState(createInitialMobileSelectionState(false));
        return;
      }

      if (!range) {
        setMobileSelectionState({
          enabled: true,
          mode,
          activeHandle,
          range: null,
          startHandle: null,
          endHandle: null,
          toolbarAnchor: null,
        });
        return;
      }

      const layout = getTerminalLayout();
      if (!layout) {
        setMobileSelectionState({
          enabled: true,
          mode,
          activeHandle,
          range,
          startHandle: null,
          endHandle: null,
          toolbarAnchor: null,
        });
        return;
      }

      const startAnchor = toHandleAnchorClientPoint({
        coord: range.start,
        side: "start",
        screenRect: layout.screenRect,
        viewportY: layout.viewportY,
        rows: layout.rows,
        cellWidth: layout.cellWidth,
        cellHeight: layout.cellHeight,
      });

      const endAnchor = toHandleAnchorClientPoint({
        coord: range.end,
        side: "end",
        screenRect: layout.screenRect,
        viewportY: layout.viewportY,
        rows: layout.rows,
        cellWidth: layout.cellWidth,
        cellHeight: layout.cellHeight,
      });

      const startHandle = {
        left: clamp(
          startAnchor.x - layout.containerRect.left,
          MOBILE_HANDLE_SAFE_EDGE_PX,
          layout.containerRect.width - MOBILE_HANDLE_SAFE_EDGE_PX,
        ),
        top: clamp(
          startAnchor.y - layout.containerRect.top,
          MOBILE_HANDLE_SAFE_EDGE_PX,
          layout.containerRect.height - MOBILE_HANDLE_SAFE_EDGE_PX,
        ),
      };
      const endHandle = {
        left: clamp(
          endAnchor.x - layout.containerRect.left,
          MOBILE_HANDLE_SAFE_EDGE_PX,
          layout.containerRect.width - MOBILE_HANDLE_SAFE_EDGE_PX,
        ),
        top: clamp(
          endAnchor.y - layout.containerRect.top,
          MOBILE_HANDLE_SAFE_EDGE_PX,
          layout.containerRect.height - MOBILE_HANDLE_SAFE_EDGE_PX,
        ),
      };

      const selectionTop = Math.min(startHandle.top, endHandle.top);
      const selectionBottom = Math.max(startHandle.top, endHandle.top);
      const toolbarTopAbove = selectionTop - MOBILE_TOOLBAR_ESTIMATED_HEIGHT_PX - MOBILE_TOOLBAR_GAP_PX;
      const toolbarTopBelow = selectionBottom + MOBILE_TOOLBAR_GAP_PX;
      const preferredToolbarTop = toolbarTopAbove >= MOBILE_TOOLBAR_SAFE_TOP_PX ? toolbarTopAbove : toolbarTopBelow;

      const maxToolbarTop = Math.max(
        MOBILE_TOOLBAR_SAFE_TOP_PX,
        layout.containerRect.height - MOBILE_TOOLBAR_ESTIMATED_HEIGHT_PX - MOBILE_TOOLBAR_SAFE_BOTTOM_PX,
      );
      const toolbarTop = clamp(preferredToolbarTop, MOBILE_TOOLBAR_SAFE_TOP_PX, maxToolbarTop);

      const minToolbarLeft = Math.min(
        layout.containerRect.width / 2,
        MOBILE_TOOLBAR_ESTIMATED_HALF_WIDTH_PX + MOBILE_TOOLBAR_SIDE_PADDING_PX,
      );
      const maxToolbarLeft = Math.max(
        minToolbarLeft,
        layout.containerRect.width - MOBILE_TOOLBAR_ESTIMATED_HALF_WIDTH_PX - MOBILE_TOOLBAR_SIDE_PADDING_PX,
      );
      const toolbarLeft = clamp((startHandle.left + endHandle.left) / 2, minToolbarLeft, maxToolbarLeft);

      setMobileSelectionState({
        enabled: true,
        mode,
        activeHandle,
        range,
        startHandle,
        endHandle,
        toolbarAnchor: {
          left: toolbarLeft,
          top: toolbarTop,
        },
      });
    },
    [getTerminalLayout, mobileTouchSupported],
  );

  const applySelectionRange = useCallback(
    (
      range: SelectionRange,
      mode: MobileSelectionMode = "selecting",
      activeHandle: MobileSelectionHandle | null = null,
    ) => {
      const terminal = terminalRef.current;
      if (!terminal || !mobileTouchSupported) {
        return;
      }

      const normalized = normalizeSelectionRange(range.start, range.end);
      const selectArgs = selectionRangeToXtermSelectArgs(normalized, terminal.cols);

      terminal.select(selectArgs.column, selectArgs.row, selectArgs.length);
      selectionRangeRef.current = normalized;
      setMobileVisualStateFromRange(normalized, mode, activeHandle);
    },
    [mobileTouchSupported, setMobileVisualStateFromRange],
  );

  const runAutoScrollFrame = useCallback(
    (timestamp: number) => {
      if (!mobileTouchSupported) {
        stopAutoScrollLoop();
        return;
      }

      const activeHandle = activeHandleRef.current;
      const dragPoint = dragPointRef.current;
      const existingRange = selectionRangeRef.current;
      const terminal = terminalRef.current;
      if (!terminalMountedRef.current || !activeHandle || !dragPoint || !existingRange || !terminal) {
        stopAutoScrollLoop();
        return;
      }

      const layout = getTerminalLayout();
      if (!layout) {
        const canRetry =
          terminalMountedRef.current &&
          activeHandleRef.current !== null &&
          autoScrollLayoutRetryRef.current < AUTO_SCROLL_LAYOUT_MAX_RETRIES;
        if (!canRetry) {
          stopAutoScrollLoop();
          return;
        }
        autoScrollLayoutRetryRef.current += 1;
        autoScrollAnimationRef.current = window.requestAnimationFrame(runAutoScrollFrame);
        return;
      }
      autoScrollLayoutRetryRef.current = 0;

      const velocityPxPerSecond = computeEdgeAutoScrollVelocity({
        clientY: dragPoint.y,
        top: layout.screenRect.top,
        bottom: layout.screenRect.bottom,
      });

      const previousTimestamp = autoScrollLastTimestampRef.current;
      const elapsedMs = previousTimestamp === null ? 16 : Math.max(1, Math.min(48, timestamp - previousTimestamp));
      autoScrollLastTimestampRef.current = timestamp;

      if (velocityPxPerSecond !== 0) {
        const deltaPx = autoScrollRemainderPxRef.current + (velocityPxPerSecond * elapsedMs) / 1000;
        let nextRemainderPx = deltaPx;
        const lineDelta =
          deltaPx >= 0 ? Math.floor(deltaPx / layout.cellHeight) : Math.ceil(deltaPx / layout.cellHeight);

        if (lineDelta !== 0) {
          terminal.scrollLines(lineDelta);
          nextRemainderPx = deltaPx - lineDelta * layout.cellHeight;
        }

        autoScrollRemainderPxRef.current = nextRemainderPx;

        const updatedLayout = getTerminalLayout();
        if (updatedLayout) {
          const coord = clientPointToBufferCoord({
            clientPoint: dragPoint,
            screenRect: updatedLayout.screenRect,
            cols: updatedLayout.cols,
            rows: updatedLayout.rows,
            viewportY: updatedLayout.viewportY,
            cellWidth: updatedLayout.cellWidth,
            cellHeight: updatedLayout.cellHeight,
          });

          const nextRange =
            activeHandle === "start"
              ? {
                  start: coord,
                  end: existingRange.end,
                }
              : {
                  start: existingRange.start,
                  end: coord,
                };

          applySelectionRange(nextRange, getDragMode(activeHandle), activeHandle);
        }
      } else {
        autoScrollRemainderPxRef.current = 0;
      }

      if (terminalMountedRef.current && activeHandleRef.current !== null) {
        autoScrollAnimationRef.current = window.requestAnimationFrame(runAutoScrollFrame);
      } else {
        stopAutoScrollLoop();
      }
    },
    [applySelectionRange, getTerminalLayout, mobileTouchSupported, stopAutoScrollLoop],
  );

  const ensureAutoScrollLoop = useCallback(() => {
    if (autoScrollAnimationRef.current !== null) {
      return;
    }
    if (!terminalMountedRef.current || activeHandleRef.current === null) {
      return;
    }
    autoScrollLayoutRetryRef.current = 0;
    autoScrollLastTimestampRef.current = null;
    autoScrollAnimationRef.current = window.requestAnimationFrame(runAutoScrollFrame);
  }, [runAutoScrollFrame]);

  const clearMobileSelection = useCallback(() => {
    const terminal = terminalRef.current;
    if (terminal) {
      terminal.clearSelection();
    }

    pendingTouchRef.current = null;
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    activeHandleRef.current = null;
    selectionRangeRef.current = null;
    dragPointRef.current = null;
    clearScrollGesture();
    stopAutoScrollLoop();
    setMobileVisualStateFromRange(null, "idle", null);
  }, [clearScrollGesture, setMobileVisualStateFromRange, stopAutoScrollLoop]);

  const updateActiveHandleFromClientPoint = useCallback(
    (clientX: number, clientY: number) => {
      if (!mobileTouchSupported) {
        return;
      }

      const activeHandle = activeHandleRef.current;
      const existingRange = selectionRangeRef.current;
      if (!activeHandle || !existingRange) {
        return;
      }

      const layout = getTerminalLayout();
      if (!layout) {
        return;
      }

      const point = { x: clientX, y: clientY };
      dragPointRef.current = point;

      const coord = clientPointToBufferCoord({
        clientPoint: point,
        screenRect: layout.screenRect,
        cols: layout.cols,
        rows: layout.rows,
        viewportY: layout.viewportY,
        cellWidth: layout.cellWidth,
        cellHeight: layout.cellHeight,
      });

      const nextRange =
        activeHandle === "start"
          ? {
              start: coord,
              end: existingRange.end,
            }
          : {
              start: existingRange.start,
              end: coord,
            };

      applySelectionRange(nextRange, getDragMode(activeHandle), activeHandle);
      ensureAutoScrollLoop();
    },
    [applySelectionRange, ensureAutoScrollLoop, getTerminalLayout, mobileTouchSupported],
  );

  const setActiveHandle = useCallback(
    (handle: MobileSelectionHandle | null) => {
      if (!mobileTouchSupported) {
        return;
      }

      activeHandleRef.current = handle;
      if (handle === null) {
        dragPointRef.current = null;
        stopAutoScrollLoop();
        setMobileVisualStateFromRange(
          selectionRangeRef.current,
          selectionRangeRef.current ? "selecting" : "idle",
          null,
        );
        return;
      }

      setMobileVisualStateFromRange(selectionRangeRef.current, getDragMode(handle), handle);
    },
    [mobileTouchSupported, setMobileVisualStateFromRange, stopAutoScrollLoop],
  );

  const startWordSelectionFromPoint = useCallback(
    (point: Point) => {
      const terminal = terminalRef.current;
      if (!terminal || !mobileTouchSupported) {
        return;
      }

      const layout = getTerminalLayout();
      if (!layout) {
        return;
      }

      const coord = clientPointToBufferCoord({
        clientPoint: point,
        screenRect: layout.screenRect,
        cols: layout.cols,
        rows: layout.rows,
        viewportY: layout.viewportY,
        cellWidth: layout.cellWidth,
        cellHeight: layout.cellHeight,
      });

      const line = terminal.buffer.active.getLine(coord.row);
      if (!line) {
        return;
      }

      const lineText = line.translateToString(false);
      const separators = getWordSeparators(terminal);
      const word = getWordRangeInLine(lineText, coord.col, separators, terminal.cols);

      applySelectionRange(
        {
          start: {
            col: word.startCol,
            row: coord.row,
          },
          end: {
            col: word.endCol,
            row: coord.row,
          },
        },
        "selecting",
        null,
      );

      setStatusMessage("Selection mode active.");
    },
    [applySelectionRange, getTerminalLayout, mobileTouchSupported],
  );

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  useEffect(() => {
    if (!mobileTouchSupported) {
      setMobileSelectionState(createInitialMobileSelectionState(false));
      setMobileMouseMode("nativeScroll");
      clearScrollGesture();
      return;
    }

    setMobileSelectionState((previous) => ({
      ...previous,
      enabled: true,
    }));
  }, [clearScrollGesture, mobileTouchSupported]);

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setContainer(node);
  }, []);

  const closeSocket = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;

    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }

    socketRef.current = null;
  }, []);

  const sendInputFrame = useCallback((data: string | Uint8Array): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(encodeInput(data));
    return true;
  }, []);

  useEffect(() => {
    if (!container) {
      terminalMountedRef.current = false;
      stopAutoScrollLoop();
      return;
    }

    const terminal = new Terminal(terminalOptions);
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(container);

    const customFit = () => {
      const proposed = fitAddon.proposeDimensions();
      if (!proposed || Number.isNaN(proposed.cols) || Number.isNaN(proposed.rows)) {
        return;
      }

      const finalCols = Math.max(proposed.cols, MIN_COLS);
      const finalRows = proposed.rows;
      const needsOverflow = finalCols > proposed.cols;

      const element = terminal.element;
      if (!element) {
        return;
      }

      if (needsOverflow) {
        const dims = terminal.dimensions;
        if (!dims || dims.css.cell.width === 0) {
          return;
        }
        const cellWidth = dims.css.cell.width;
        const elemStyle = getComputedStyle(element);
        const paddingHor =
          (parseInt(elemStyle.getPropertyValue("padding-left"), 10) || 0) +
          (parseInt(elemStyle.getPropertyValue("padding-right"), 10) || 0);
        const showScrollbar = terminal.options.scrollbar?.showScrollbar ?? true;
        const scrollbarWidth =
          terminal.options.scrollback === 0 || !showScrollbar
            ? 0
            : (terminal.options.scrollbar?.width ?? DEFAULT_SCROLLBAR_WIDTH);
        const requiredWidth = Math.ceil(finalCols * cellWidth) + paddingHor + scrollbarWidth;
        element.style.width = `${requiredWidth}px`;
      } else {
        element.style.width = "";
      }

      if (terminal.rows !== finalRows || terminal.cols !== finalCols) {
        terminal.resize(finalCols, finalRows);
      }

      setHorizontalOverflow(needsOverflow);
    };

    customFitRef.current = customFit;
    customFit();
    terminal.focus();
    terminalMountedRef.current = true;

    const terminalDisposables: IDisposable[] = [
      terminal.onData((data) => {
        sendInputFrame(data);
      }),
      terminal.onResize(({ cols, rows }) => {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(encodeResize(cols, rows));
        }
      }),
      terminal.onScroll(() => {
        const range = selectionRangeRef.current;
        if (!range) {
          return;
        }

        setMobileVisualStateFromRange(range, getDragMode(activeHandleRef.current), activeHandleRef.current);
      }),
      terminal.onSelectionChange(() => {
        if (!mobileTouchSupported) {
          return;
        }

        const selectionText = terminal.getSelection();
        if (selectionText.length === 0) {
          selectionRangeRef.current = null;
          activeHandleRef.current = null;
          dragPointRef.current = null;
          stopAutoScrollLoop();
          setMobileVisualStateFromRange(null, "idle", null);
          return;
        }

        const range = selectionRangeRef.current;
        if (!range) {
          return;
        }

        setMobileVisualStateFromRange(range, getDragMode(activeHandleRef.current), activeHandleRef.current);
      }),
    ];

    const fitThrottleMs = 100;
    let lastFitTime = 0;
    let throttledFitTimeout: number | undefined;
    const throttledFit = () => {
      const now = Date.now();
      const elapsed = now - lastFitTime;
      if (elapsed >= fitThrottleMs) {
        lastFitTime = now;
        customFit();
        const range = selectionRangeRef.current;
        if (range) {
          setMobileVisualStateFromRange(range, getDragMode(activeHandleRef.current), activeHandleRef.current);
        }
        return;
      }

      if (throttledFitTimeout !== undefined) {
        return;
      }

      throttledFitTimeout = window.setTimeout(() => {
        throttledFitTimeout = undefined;
        lastFitTime = Date.now();
        customFit();
        const range = selectionRangeRef.current;
        if (range) {
          setMobileVisualStateFromRange(range, getDragMode(activeHandleRef.current), activeHandleRef.current);
        }
      }, fitThrottleMs - elapsed);
    };

    const resizeObserver = new ResizeObserver(throttledFit);
    resizeObserver.observe(container);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    terminalDisposablesRef.current = terminalDisposables;

    return () => {
      terminalMountedRef.current = false;
      closeSocket();
      resizeObserver.disconnect();
      if (throttledFitTimeout !== undefined) {
        window.clearTimeout(throttledFitTimeout);
      }
      for (const disposable of terminalDisposablesRef.current) {
        disposable.dispose();
      }
      terminalDisposablesRef.current = [];
      fitAddon.dispose();
      terminal.dispose();
      fitAddonRef.current = null;
      terminalRef.current = null;
      customFitRef.current = null;

      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      pendingTouchRef.current = null;
      clearScrollGesture();
      selectionRangeRef.current = null;
      activeHandleRef.current = null;
      dragPointRef.current = null;
      stopAutoScrollLoop();
      setMobileVisualStateFromRange(null, "idle", null);
    };
  }, [
    closeSocket,
    container,
    clearScrollGesture,
    mobileTouchSupported,
    sendInputFrame,
    setMobileVisualStateFromRange,
    stopAutoScrollLoop,
  ]);

  useEffect(() => {
    if (!container || !mobileTouchSupported) {
      return;
    }
    const shouldPassTouchScroll = mobileMouseMode === "passToTerminal";

    const clearPendingLongPress = (setIdleIfNoSelection: boolean) => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      const hadPendingTouch = pendingTouchRef.current !== null;
      pendingTouchRef.current = null;

      if (setIdleIfNoSelection && hadPendingTouch && selectionRangeRef.current === null) {
        setMobileVisualStateFromRange(null, "idle", activeHandleRef.current);
      }
    };

    const findTouchById = (touches: TouchList, identifier: number): Touch | null => {
      for (let index = 0; index < touches.length; index += 1) {
        const touch = touches.item(index);
        if (touch?.identifier === identifier) {
          return touch;
        }
      }
      return null;
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || activeHandleRef.current !== null) {
        clearPendingLongPress(true);
        clearScrollGesture();
        return;
      }

      const touch = event.touches.item(0);
      if (!touch) {
        return;
      }

      const point = { x: touch.clientX, y: touch.clientY };
      if (shouldPassTouchScroll && selectionRangeRef.current === null) {
        scrollGestureRef.current = {
          identifier: touch.identifier,
          lastY: touch.clientY,
          remainderPx: 0,
        };
      } else {
        clearScrollGesture();
      }

      pendingTouchRef.current = {
        identifier: touch.identifier,
        startPoint: point,
        latestPoint: point,
      };

      setMobileVisualStateFromRange(
        selectionRangeRef.current,
        selectionRangeRef.current ? "selecting" : "pendingLongPress",
        activeHandleRef.current,
      );

      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }

      longPressTimerRef.current = window.setTimeout(() => {
        const pendingTouch = pendingTouchRef.current;
        pendingTouchRef.current = null;
        longPressTimerRef.current = null;

        if (!pendingTouch) {
          return;
        }

        startWordSelectionFromPoint(pendingTouch.latestPoint);
      }, MOBILE_LONG_PRESS_MS);
    };

    const onTouchMove = (event: TouchEvent) => {
      const pendingTouch = pendingTouchRef.current;
      if (pendingTouch) {
        const matchingTouch = findTouchById(event.touches, pendingTouch.identifier);
        if (matchingTouch) {
          const nextPoint = {
            x: matchingTouch.clientX,
            y: matchingTouch.clientY,
          };
          pendingTouch.latestPoint = nextPoint;

          if (euclideanDistance(nextPoint, pendingTouch.startPoint) >= MOBILE_LONG_PRESS_CANCEL_DISTANCE_PX) {
            clearPendingLongPress(true);
          }
        }
      }

      if (!shouldPassTouchScroll || activeHandleRef.current !== null || selectionRangeRef.current !== null) {
        return;
      }

      const scrollGesture = scrollGestureRef.current;
      if (!scrollGesture) {
        return;
      }

      const matchingTouch = findTouchById(event.touches, scrollGesture.identifier);
      if (!matchingTouch) {
        clearScrollGesture();
        return;
      }

      const layout = getTerminalLayout();
      const cellHeight = layout?.cellHeight ?? 16;
      const deltaPx = scrollGesture.lastY - matchingTouch.clientY;
      scrollGesture.lastY = matchingTouch.clientY;

      if (deltaPx !== 0) {
        event.preventDefault();
      }

      const combinedDeltaPx = scrollGesture.remainderPx + deltaPx;
      const lineDelta =
        combinedDeltaPx >= 0 ? Math.floor(combinedDeltaPx / cellHeight) : Math.ceil(combinedDeltaPx / cellHeight);

      if (lineDelta === 0) {
        scrollGesture.remainderPx = combinedDeltaPx;
        return;
      }

      scrollGesture.remainderPx = combinedDeltaPx - lineDelta * cellHeight;
      emitWheelDelta(lineDelta * cellHeight);
    };

    const onTouchEnd = () => {
      clearPendingLongPress(true);
      clearScrollGesture();
    };

    const onTouchCancel = () => {
      clearPendingLongPress(true);
      clearScrollGesture();
    };

    const onContextMenu = (event: MouseEvent) => {
      if (pendingTouchRef.current !== null || selectionRangeRef.current !== null) {
        event.preventDefault();
      }
    };

    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("touchcancel", onTouchCancel, { passive: true });
    container.addEventListener("contextmenu", onContextMenu);

    return () => {
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchCancel);
      container.removeEventListener("contextmenu", onContextMenu);
      clearPendingLongPress(false);
      clearScrollGesture();
    };
  }, [
    clearScrollGesture,
    container,
    emitWheelDelta,
    getTerminalLayout,
    mobileMouseMode,
    mobileTouchSupported,
    setMobileVisualStateFromRange,
    startWordSelectionFromPoint,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectToken and container are intentional triggers for reconnection
  useEffect(() => {
    if (!wsUrl) {
      closeSocket();
      setConnectionStatus("disconnected");
      setStatusMessage("Missing terminal endpoint configuration.");
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      setConnectionStatus("disconnected");
      setStatusMessage("Initializing terminal.");
      return;
    }

    closeSocket();
    setConnectionStatus("connecting");
    setStatusMessage("Connecting.");

    const socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    const connectionEpoch = connectionEpochRef.current + 1;
    connectionEpochRef.current = connectionEpoch;

    const isCurrentConnection = () =>
      connectionEpochRef.current === connectionEpoch &&
      socket === socketRef.current &&
      terminalRef.current === terminal;

    const handleFrame = (arrayBuffer: ArrayBuffer) => {
      if (!isCurrentConnection()) {
        return;
      }

      let frame: ReturnType<typeof decodeFrame>;
      try {
        frame = decodeFrame(arrayBuffer);
      } catch {
        return;
      }

      switch (frame.command) {
        case ServerCommand.OUTPUT:
          terminal.write(frame.payload);
          break;
        case ServerCommand.SET_WINDOW_TITLE:
          onTitleChangeRef.current?.(decoderRef.current.decode(frame.payload));
          break;
        default:
          break;
      }
    };

    socket.onopen = () => {
      if (!isCurrentConnection()) {
        return;
      }

      customFitRef.current?.();
      socket.send(buildHandshake(terminal.cols, terminal.rows));
      terminal.focus();
      setConnectionStatus("connected");
      setStatusMessage("");
    };

    socket.onmessage = (event) => {
      if (!isCurrentConnection()) {
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        handleFrame(event.data);
        return;
      }

      if (event.data instanceof Blob) {
        void event.data
          .arrayBuffer()
          .then((arrayBuffer) => {
            handleFrame(arrayBuffer);
          })
          .catch(() => {
            // Ignore malformed binary frames.
          });
        return;
      }

      if (typeof event.data === "string") {
        terminal.write(event.data);
      }
    };

    socket.onerror = () => {
      if (!isCurrentConnection()) {
        return;
      }
      setConnectionStatus("error");
      setStatusMessage("WebSocket error.");
    };

    socket.onclose = (event) => {
      if (!isCurrentConnection()) {
        return;
      }
      socketRef.current = null;
      setConnectionStatus("disconnected");
      setStatusMessage(`Disconnected (code ${event.code}).`);
    };

    return () => {
      if (connectionEpochRef.current === connectionEpoch) {
        connectionEpochRef.current += 1;
      }
      if (socket === socketRef.current) {
        closeSocket();
      }
    };
  }, [wsUrl, reconnectToken, closeSocket, container]);

  const reconnect = useCallback(() => {
    if (!wsUrl) {
      return;
    }
    closeSocket();
    setReconnectToken((previous) => previous + 1);
  }, [closeSocket, wsUrl]);

  const focusTerminalInput = useCallback((): boolean => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return false;
    }

    terminal.focus();
    const input = terminal.textarea;
    if (!input) {
      return false;
    }

    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    return true;
  }, []);

  const focusSoftKeyboard = useCallback(() => {
    const focused = focusTerminalInput();
    if (!focused) {
      if (!terminalRef.current) {
        setStatusMessage("Terminal not ready for keyboard.");
      } else {
        setStatusMessage("Tap terminal area to open keyboard.");
      }
      return;
    }
    setStatusMessage("Requested mobile keyboard.");
  }, [focusTerminalInput]);

  const sendSoftKeySequence = useCallback(
    (sequence: string, label: string): boolean => {
      if (!terminalRef.current) {
        setStatusMessage("Terminal not ready for key send.");
        return false;
      }

      if (sequence.length === 0) {
        setStatusMessage(`Unsupported key combo: ${label}.`);
        return false;
      }

      focusTerminalInput();
      const sent = sendInputFrame(sequence);
      if (!sent) {
        setStatusMessage("Terminal not ready. Wait for connection or reconnect before sending keys.");
        return false;
      }

      setStatusMessage(`Sent ${label}.`);
      return true;
    },
    [focusTerminalInput, sendInputFrame],
  );

  const toggleMobileMouseMode = useCallback(() => {
    if (!mobileTouchSupported) {
      return;
    }

    const nextMode: MobileMouseMode = mobileMouseMode === "nativeScroll" ? "passToTerminal" : "nativeScroll";
    clearScrollGesture();
    setMobileMouseMode(nextMode);
    setStatusMessage(
      nextMode === "passToTerminal"
        ? "Touch scroll now sends wheel events to remote apps."
        : "Touch scroll now uses terminal scrollback.",
    );
  }, [clearScrollGesture, mobileMouseMode, mobileTouchSupported]);

  const pasteTextIntoTerminal = useCallback((text: string): boolean => {
    const terminal = terminalRef.current;
    if (!terminal) {
      setStatusMessage("Terminal not ready for paste.");
      return false;
    }

    if (text.trim().length === 0) {
      setStatusMessage("Paste text is empty.");
      return false;
    }

    terminal.paste(text);
    setStatusMessage(`Pasted (${text.length} chars).`);
    return true;
  }, []);

  const attemptPasteFromClipboard = useCallback(async (): Promise<PasteResult> => {
    if (!terminalRef.current) {
      setStatusMessage("Terminal not ready for paste.");
      return "terminal-unavailable";
    }

    if (mobileMouseMode !== "nativeScroll") {
      setStatusMessage("Switch to Mode: Native to paste.");
      return "wrong-mode";
    }

    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      setStatusMessage("Use iOS paste in helper panel.");
      return "fallback-required";
    }

    try {
      const text = await navigator.clipboard.readText();
      if (text.trim().length === 0) {
        setStatusMessage("Clipboard is empty.");
        return "empty";
      }

      const pasted = pasteTextIntoTerminal(text);
      return pasted ? "pasted" : "terminal-unavailable";
    } catch {
      setStatusMessage("Use iOS paste in helper panel.");
      return "fallback-required";
    }
  }, [mobileMouseMode, pasteTextIntoTerminal]);

  const copySelection = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      setStatusMessage("Terminal not ready for copy.");
      throw new Error("Terminal not ready for copy.");
    }

    const selectedText = terminal.getSelection();
    if (selectedText.length === 0) {
      setStatusMessage("No terminal selection to copy.");
      throw new Error("No terminal selection to copy.");
    }

    const copied = await writeClipboardText(selectedText);
    if (!copied) {
      setStatusMessage("Clipboard copy failed.");
      throw new Error("Clipboard copy failed.");
    }

    setStatusMessage(`Copied selection (${selectedText.length} chars).`);
  }, []);

  const copyRecentOutput = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      setStatusMessage("Terminal not ready for copy.");
      throw new Error("Terminal not ready for copy.");
    }

    const recentOutput = collectRecentOutput(terminal, RECENT_OUTPUT_LINES);
    if (recentOutput.length === 0) {
      setStatusMessage("No terminal output available to copy.");
      throw new Error("No terminal output available to copy.");
    }

    const copied = await writeClipboardText(recentOutput);
    if (!copied) {
      setStatusMessage("Clipboard copy failed.");
      throw new Error("Clipboard copy failed.");
    }

    setStatusMessage(`Copied recent output (${RECENT_OUTPUT_LINES} lines max).`);
  }, []);

  const getSelectableText = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      setStatusMessage("Terminal not ready for selection.");
      return "";
    }

    const selectedText = terminal.getSelection();
    if (selectedText.length > 0) {
      return selectedText;
    }

    const recentOutput = collectRecentOutput(terminal, RECENT_OUTPUT_LINES);
    if (recentOutput.length === 0) {
      setStatusMessage("No terminal output available.");
      return "";
    }

    return recentOutput;
  }, []);

  return {
    containerRef,
    connectionStatus,
    statusMessage,
    reconnect,
    focusSoftKeyboard,
    sendSoftKeySequence,
    attemptPasteFromClipboard,
    pasteTextIntoTerminal,
    copySelection,
    copyRecentOutput,
    getSelectableText,
    mobileSelectionState,
    mobileMouseMode,
    clearMobileSelection,
    setActiveHandle,
    updateActiveHandleFromClientPoint,
    toggleMobileMouseMode,
    horizontalOverflow,
    containerElement: container,
  };
}
