import { FitAddon } from "@xterm/addon-fit";
import { type IDisposable, type ITerminalOptions, Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
export type PasteResult = "pasted" | "empty" | "fallback-required" | "terminal-unavailable";

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
  hscroll?: boolean;
}

interface UseTtydTerminalResult {
  containerRef: (node: HTMLDivElement | null) => void;
  connectionStatus: ConnectionStatus;
  sysKeyActive: boolean;
  reconnect: () => void;
  focusSysKeyboard: () => void;
  focusTerminalInput: () => boolean;
  sendSoftKeySequence: (sequence: string, label: string, skipFocus?: boolean) => boolean;
  blurTerminalInput: () => void;
  attemptPasteFromClipboard: () => Promise<PasteResult>;
  pasteTextIntoTerminal: (text: string) => boolean;
  getSelectableText: () => Promise<string>;
  getTerminalSelection: () => string;
  copyTextToClipboard: (text: string) => Promise<boolean>;
  mobileSelectionState: MobileSelectionState;
  clearMobileSelection: () => void;
  setActiveHandle: (handle: MobileSelectionHandle | null) => void;
  updateActiveHandleFromClientPoint: (clientX: number, clientY: number) => void;
  horizontalOverflow: boolean;
  containerElement: HTMLDivElement | null;
  verticalScrollSyncRef: React.MutableRefObject<(() => void) | null>;
  getVerticalScrollState(): { viewportY: number; baseY: number; rows: number } | null;
}

const isMobileViewport = typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches;

const terminalOptions: ITerminalOptions = {
  cursorBlink: true,
  convertEol: true,
  scrollback: 5000,
  fontSize: isMobileViewport ? 10 : 14,
  fontFamily: "JetBrainsMono Nerd Font Mono, Symbols Nerd Font Mono, Menlo, monospace",
  theme: {
    background: "#041425",
    foreground: "#d8ecff",
    cursor: "#71f1d6",
    selectionBackground: "#17416a",
  },
};

const MIN_COLS = 80;
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

export function useTtydTerminal({ wsUrl, onTitleChange, hscroll }: UseTtydTerminalOptions): UseTtydTerminalResult {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [reconnectToken, setReconnectToken] = useState(0);

  const mobileTouchSupported =
    typeof navigator !== "undefined" && isLikelyIOS(navigator.userAgent, navigator.maxTouchPoints ?? 0);

  const [mobileSelectionState, setMobileSelectionState] = useState<MobileSelectionState>(() =>
    createInitialMobileSelectionState(mobileTouchSupported),
  );
  const [mobileMouseMode, setMobileMouseMode] = useState<MobileMouseMode>(
    mobileTouchSupported ? "passToTerminal" : "nativeScroll",
  );
  const [sysKeyActive, setSysKeyActive] = useState(false);
  const selectionEnabled = mobileTouchSupported;
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
  const fitSuppressedRef = useRef(false);
  const selectionEnabledRef = useRef(selectionEnabled);
  selectionEnabledRef.current = selectionEnabled;
  const verticalScrollSyncRef = useRef<(() => void) | null>(null);

  const getVerticalScrollState = useCallback((): { viewportY: number; baseY: number; rows: number } | null => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return null;
    }
    return {
      viewportY: terminal.buffer.active.viewportY,
      baseY: terminal.buffer.active.baseY,
      rows: terminal.rows,
    };
  }, []);

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
      if (!selectionEnabledRef.current) {
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
    [getTerminalLayout],
  );

  const applySelectionRange = useCallback(
    (
      range: SelectionRange,
      mode: MobileSelectionMode = "selecting",
      activeHandle: MobileSelectionHandle | null = null,
    ) => {
      const terminal = terminalRef.current;
      if (!terminal || !selectionEnabledRef.current) {
        return;
      }

      const normalized = normalizeSelectionRange(range.start, range.end);
      const selectArgs = selectionRangeToXtermSelectArgs(normalized, terminal.cols);

      terminal.select(selectArgs.column, selectArgs.row, selectArgs.length);
      selectionRangeRef.current = normalized;
      setMobileVisualStateFromRange(normalized, mode, activeHandle);
    },
    [setMobileVisualStateFromRange],
  );

  const runAutoScrollFrame = useCallback(
    (timestamp: number) => {
      if (!selectionEnabledRef.current) {
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
    [applySelectionRange, getTerminalLayout, stopAutoScrollLoop],
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
      if (!selectionEnabledRef.current) {
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
    [applySelectionRange, ensureAutoScrollLoop, getTerminalLayout],
  );

  const setActiveHandle = useCallback(
    (handle: MobileSelectionHandle | null) => {
      if (!selectionEnabledRef.current) {
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
    [setMobileVisualStateFromRange, stopAutoScrollLoop],
  );

  const startWordSelectionFromPoint = useCallback(
    (point: Point) => {
      const terminal = terminalRef.current;
      if (!terminal || !selectionEnabledRef.current) {
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
    },
    [applySelectionRange, getTerminalLayout],
  );

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  useEffect(() => {
    if (!selectionEnabled) {
      setMobileSelectionState(createInitialMobileSelectionState(false));
      if (!mobileTouchSupported) {
        setMobileMouseMode("nativeScroll");
      }
      clearScrollGesture();
      return;
    }

    setMobileSelectionState((previous) => ({
      ...previous,
      enabled: true,
    }));
  }, [clearScrollGesture, mobileTouchSupported, selectionEnabled]);

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

    const textarea = terminal.textarea;
    if (textarea) {
      textarea.style.setProperty("opacity", "0", "important");
      textarea.style.setProperty("caret-color", "transparent", "important");
    }

    const customFit = () => {
      if (fitSuppressedRef.current) {
        return;
      }
      const proposed = fitAddon.proposeDimensions();
      if (!proposed || Number.isNaN(proposed.cols) || Number.isNaN(proposed.rows)) {
        return;
      }

      const finalCols = hscroll ? Math.max(proposed.cols, MIN_COLS) : proposed.cols;
      const finalRows = proposed.rows;
      const needsOverflow = finalCols > proposed.cols;

      const element = terminal.element;
      if (!element) {
        return;
      }

      const dims = terminal.dimensions;
      const canOverflow = needsOverflow && !!dims && dims.css.cell.width > 0;

      if (canOverflow) {
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

      setHorizontalOverflow(canOverflow);
    };

    customFitRef.current = customFit;
    customFit();
    if (!mobileTouchSupported) {
      terminal.focus();
    }
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
        verticalScrollSyncRef.current?.();

        const isAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
        const cursorLayer = terminal.element?.querySelector(".xterm-cursor-layer") as HTMLElement | null;
        if (cursorLayer) {
          cursorLayer.style.visibility = isAtBottom ? "" : "hidden";
        }

        const range = selectionRangeRef.current;
        if (!range) {
          return;
        }

        setMobileVisualStateFromRange(range, getDragMode(activeHandleRef.current), activeHandleRef.current);
      }),
      terminal.onSelectionChange(() => {
        if (!selectionEnabledRef.current) {
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

    if (mobileTouchSupported && textarea) {
      textarea.inputMode = "none";
    }
    const onTextareaFocus = mobileTouchSupported ? null : () => setSysKeyActive(true);
    const onTextareaBlur = () => {
      setSysKeyActive(false);
      if (mobileTouchSupported && textarea) {
        textarea.inputMode = "none";
      }
    };
    if (textarea) {
      if (onTextareaFocus) {
        textarea.addEventListener("focus", onTextareaFocus);
      }
      textarea.addEventListener("blur", onTextareaBlur);
    }

    return () => {
      if (textarea) {
        if (onTextareaFocus) {
          textarea.removeEventListener("focus", onTextareaFocus);
        }
        textarea.removeEventListener("blur", onTextareaBlur);
      }
      setSysKeyActive(false);
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
    hscroll,
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

    let hScrollTouch: { identifier: number; lastX: number } | null = null;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || activeHandleRef.current !== null) {
        clearPendingLongPress(true);
        clearScrollGesture();
        hScrollTouch = null;
        return;
      }

      const touch = event.touches.item(0);
      if (!touch) {
        return;
      }

      hScrollTouch =
        hscroll && container.scrollWidth > container.clientWidth
          ? { identifier: touch.identifier, lastX: touch.clientX }
          : null;

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

      if (!shouldPassTouchScroll) {
        longPressTimerRef.current = window.setTimeout(() => {
          const pendingTouch = pendingTouchRef.current;
          pendingTouchRef.current = null;
          longPressTimerRef.current = null;

          if (!pendingTouch) {
            return;
          }

          startWordSelectionFromPoint(pendingTouch.latestPoint);
        }, MOBILE_LONG_PRESS_MS);
      }
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

      if (hScrollTouch !== null) {
        const hTouch = findTouchById(event.touches, hScrollTouch.identifier);
        if (hTouch) {
          const deltaX = hScrollTouch.lastX - hTouch.clientX;
          if (deltaX !== 0) {
            container.scrollLeft += deltaX;
            hScrollTouch.lastX = hTouch.clientX;
          }
        } else {
          hScrollTouch = null;
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

    const onTouchEnd = (event: TouchEvent) => {
      const pendingTouch = pendingTouchRef.current;

      // xterm.js's Gesture handler calls preventDefault() on the native
      // touchstart (registered on document, passive:false), which stops the
      // browser from ever synthesising mousedown/mouseup/click.  Detect
      // taps here and dispatch synthetic mouse events so xterm.js's own
      // mousedown handler fires (focus + mouse-mode reporting).
      if (
        pendingTouch !== null &&
        selectionRangeRef.current === null &&
        euclideanDistance(pendingTouch.latestPoint, pendingTouch.startPoint) < MOBILE_LONG_PRESS_CANCEL_DISTANCE_PX
      ) {
        const endedTouch = findTouchById(event.changedTouches, pendingTouch.identifier);
        if (endedTouch) {
          const screenEl = container.querySelector(".xterm-screen") as HTMLElement | null;
          if (screenEl) {
            const shared: MouseEventInit = {
              bubbles: true,
              cancelable: true,
              clientX: endedTouch.clientX,
              clientY: endedTouch.clientY,
              button: 0,
            };
            screenEl.dispatchEvent(new MouseEvent("mousedown", { ...shared, buttons: 1 }));
            screenEl.dispatchEvent(new MouseEvent("mouseup", { ...shared, buttons: 0 }));
          }
        }
      }

      clearPendingLongPress(true);
      clearScrollGesture();
      hScrollTouch = null;
    };

    const onTouchCancel = () => {
      clearPendingLongPress(true);
      clearScrollGesture();
      hScrollTouch = null;
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
    hscroll,
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
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      setConnectionStatus("disconnected");
      return;
    }

    closeSocket();
    setConnectionStatus("connecting");
    toast.info("Connecting.", { id: "connection-status" });

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
          verticalScrollSyncRef.current?.();
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

      socket.send(buildHandshake(terminal.cols, terminal.rows));
      customFitRef.current?.();
      if (!mobileTouchSupported) {
        terminal.focus();
      }
      setConnectionStatus("connected");
      toast.dismiss("connection-status");
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
      toast.error("WebSocket error.", { id: "connection-status" });
    };

    socket.onclose = (event) => {
      if (!isCurrentConnection()) {
        return;
      }
      socketRef.current = null;
      setConnectionStatus("disconnected");

      if (event.code === 4000) {
        terminal.reset();
        toast.info("Restarting...", { id: "connection-status" });
        setReconnectToken((previous) => previous + 1);
        return;
      }

      toast.error(`Disconnected (code ${event.code}).`, { id: "connection-status" });
    };

    return () => {
      if (connectionEpochRef.current === connectionEpoch) {
        connectionEpochRef.current += 1;
      }
      if (socket === socketRef.current) {
        closeSocket();
      }
    };
  }, [wsUrl, reconnectToken, closeSocket, container, mobileTouchSupported]);

  const forceLocalReconnect = useCallback(() => {
    closeSocket();
    terminalRef.current?.reset();
    setReconnectToken((previous) => previous + 1);
  }, [closeSocket]);

  const reconnect = useCallback(() => {
    if (!wsUrl) {
      return;
    }
    fetch("/api/restart", { method: "POST" }).catch((error: unknown) => {
      console.error("Failed to POST /api/restart:", error);
      toast.error("Restart request failed. Reconnecting locally.", { id: "restart" });
      forceLocalReconnect();
    });
    // If already disconnected, the server can't close our socket with code 4000,
    // so trigger the reconnect directly.
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      forceLocalReconnect();
    }
  }, [forceLocalReconnect, wsUrl]);

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

  const blurTerminalInput = useCallback(() => {
    const input = terminalRef.current?.textarea;
    if (input && document.activeElement === input) {
      input.blur();
    }
  }, []);

  const focusSysKeyboard = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      toast.error("Terminal not ready for keyboard.", { id: "keyboard" });
      return;
    }

    const input = terminal.textarea;
    if (input && document.activeElement === input && (!mobileTouchSupported || input.inputMode !== "none")) {
      input.blur();
      return;
    }

    if (mobileTouchSupported && input) {
      input.inputMode = "";
    }
    const focused = focusTerminalInput();
    if (focused) {
      setSysKeyActive(true);
    } else {
      toast.error("Tap terminal area to open keyboard.", { id: "keyboard" });
    }
  }, [focusTerminalInput, mobileTouchSupported]);

  const sendSoftKeySequence = useCallback(
    (sequence: string, label: string, skipFocus?: boolean): boolean => {
      if (!terminalRef.current) {
        toast.error("Terminal not ready for key send.", { id: "key-sequence" });
        return false;
      }

      if (sequence.length === 0) {
        toast.error(`Unsupported key combo: ${label}.`, { id: "key-sequence" });
        return false;
      }

      if (!skipFocus) {
        focusTerminalInput();
      }
      const sent = sendInputFrame(sequence);
      if (!sent) {
        toast.error("Not connected. Reconnect before sending keys.", { id: "key-sequence" });
        return false;
      }

      return true;
    },
    [focusTerminalInput, sendInputFrame],
  );

  const pasteTextIntoTerminal = useCallback((text: string): boolean => {
    const terminal = terminalRef.current;
    if (!terminal) {
      toast.error("Terminal not ready for paste.", { id: "paste" });
      return false;
    }

    if (text.trim().length === 0) {
      return false;
    }

    terminal.paste(text);
    return true;
  }, []);

  const attemptPasteFromClipboard = useCallback(async (): Promise<PasteResult> => {
    if (!terminalRef.current) {
      return "terminal-unavailable";
    }

    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      return "fallback-required";
    }

    try {
      const text = await navigator.clipboard.readText();
      if (text.trim().length === 0) {
        return "empty";
      }

      const pasted = pasteTextIntoTerminal(text);
      return pasted ? "pasted" : "terminal-unavailable";
    } catch {
      return "fallback-required";
    }
  }, [pasteTextIntoTerminal]);

  const getSelectableText = useCallback((): Promise<string> => {
    const terminal = terminalRef.current;
    if (!terminal) {
      toast.error("Terminal not ready for selection.");
      return Promise.resolve("");
    }

    // Flush xterm.js's internal write queue before reading the buffer.
    // terminal.write() is internally asynchronous — it batches incoming
    // data and parses it across animation frames.  Writing an empty
    // string with a callback guarantees all previously queued data has
    // been parsed, so collectRecentOutput sees the full buffer.
    return new Promise<string>((resolve) => {
      terminal.write("", () => {
        fitSuppressedRef.current = true;
        let recentOutput: string;
        try {
          recentOutput = collectRecentOutput(terminal, RECENT_OUTPUT_LINES);
        } finally {
          fitSuppressedRef.current = false;
        }

        // Catch up on any resize that was skipped during capture.
        customFitRef.current?.();

        if (recentOutput.length === 0) {
          toast.info("No terminal output available.");
          resolve("");
          return;
        }

        resolve(recentOutput);
      });
    });
  }, []);

  const getTerminalSelection = useCallback((): string => {
    return terminalRef.current?.getSelection() ?? "";
  }, []);

  const copyTextToClipboard = useCallback(async (text: string): Promise<boolean> => {
    return writeClipboardText(text);
  }, []);

  return {
    containerRef,
    connectionStatus,
    sysKeyActive,
    reconnect,
    focusSysKeyboard,
    focusTerminalInput,
    sendSoftKeySequence,
    blurTerminalInput,
    attemptPasteFromClipboard,
    pasteTextIntoTerminal,
    getSelectableText,
    getTerminalSelection,
    copyTextToClipboard,
    mobileSelectionState,
    clearMobileSelection,
    setActiveHandle,
    updateActiveHandleFromClientPoint,
    horizontalOverflow,
    containerElement: container,
    verticalScrollSyncRef,
    getVerticalScrollState,
  };
}
