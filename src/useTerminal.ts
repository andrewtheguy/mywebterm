import { FitAddon } from "@xterm/addon-fit";
import { type IDisposable, type ITerminalOptions, Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import "@xterm/xterm/css/xterm.css";

import { isLikelyIOS, type Point } from "./mobileTouchSelection";
import type { ServerControlMessage } from "./ttyProtocol";
import { decodeFrame, encodeInput, encodeResize, ServerCommand } from "./ttyProtocol";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
export type PasteResult = "pasted" | "empty" | "fallback-required" | "terminal-unavailable";

interface UseTerminalOptions {
  wsUrl?: string;
  onTitleChange?: (title: string) => void;
  onClipboardFallback?: (text: string) => void;
  onClipboardCopy?: (text: string) => void;
  hscroll?: boolean;
  fontSize?: number;
}

interface UseTerminalResult {
  containerRef: (node: HTMLDivElement | null) => void;
  connectionStatus: ConnectionStatus;
  sysKeyActive: boolean;
  restart: () => void;
  reconnect: () => void;
  focusSysKeyboard: () => void;
  focusTerminalInput: () => boolean;
  sendSoftKeySequence: (sequence: string, label: string, skipFocus?: boolean) => boolean;
  blurTerminalInput: () => void;
  attemptPasteFromClipboard: () => Promise<PasteResult>;
  pasteTextIntoTerminal: (text: string) => boolean;
  getSelectableText: () => Promise<string>;
  copyTextToClipboard: (text: string) => Promise<boolean>;
  horizontalOverflow: boolean;
  containerElement: HTMLDivElement | null;
}

const MOBILE_VIEWPORT_QUERY = "(max-width: 768px)";

function resolveFontSize(fontSize: number | undefined, isMobileViewport: boolean): number {
  return fontSize ?? (isMobileViewport ? 10 : 12);
}

function buildTerminalOptions(isMobileViewport: boolean, fontSize?: number): ITerminalOptions {
  return {
    cursorBlink: true,
    convertEol: true,
    scrollback: 5000,
    fontSize: resolveFontSize(fontSize, isMobileViewport),
    fontFamily: "JetBrainsMono Nerd Font Mono, Symbols Nerd Font Mono, Menlo, monospace",
    theme: {
      background: "#041425",
      foreground: "#d8ecff",
      cursor: "#71f1d6",
      selectionBackground: "#17416a",
    },
  };
}

const MIN_COLS = 80;
const MIN_ROWS = 10;
const DEFAULT_SCROLLBAR_WIDTH = 14;
const RECENT_OUTPUT_LINES = 2000;
const MOBILE_LONG_PRESS_CANCEL_DISTANCE_PX = 8;
const FALLBACK_PIXELS_PER_LINE = 12;

export const SESSION_STORAGE_KEY = "mywebterm-session-id";
const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

// Close codes from server
const CLOSE_CODE_RESTART = 4000;
const CLOSE_CODE_HEARTBEAT = 4001;

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

function euclideanDistance(pointA: Point, pointB: Point): number {
  return Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
}

function computeReconnectDelay(attempt: number): number {
  const exponentialDelay = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** attempt);
  const jitter = 0.5 + Math.random() * 0.5;
  return exponentialDelay * jitter;
}

export function useTerminal({
  wsUrl,
  onTitleChange,
  onClipboardFallback,
  onClipboardCopy,
  hscroll,
  fontSize,
}: UseTerminalOptions): UseTerminalResult {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [reconnectToken, setReconnectToken] = useState(0);
  const [isMobileViewport, setIsMobileViewport] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_VIEWPORT_QUERY).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(MOBILE_VIEWPORT_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobileViewport(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const mobileTouchSupported =
    typeof navigator !== "undefined" && isLikelyIOS(navigator.userAgent, navigator.maxTouchPoints ?? 0);

  const [sysKeyActive, setSysKeyActive] = useState(false);
  const [horizontalOverflow, setHorizontalOverflow] = useState(false);

  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const decoderRef = useRef(new TextDecoder());
  const terminalDisposablesRef = useRef<IDisposable[]>([]);
  const onTitleChangeRef = useRef(onTitleChange);
  const onClipboardFallbackRef = useRef(onClipboardFallback);
  const onClipboardCopyRef = useRef(onClipboardCopy);
  const connectionEpochRef = useRef(0);

  const sessionIdRef = useRef<string | null>(null);
  const sessionIdRestoredRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!sessionIdRestoredRef.current && typeof window !== "undefined") {
    sessionIdRef.current = sessionStorage.getItem(SESSION_STORAGE_KEY);
    sessionIdRestoredRef.current = true;
  }

  const pendingTouchRef = useRef<PendingTouch | null>(null);
  const scrollGestureRef = useRef<ScrollGesture | null>(null);
  const terminalMountedRef = useRef(false);
  const customFitRef = useRef<(() => void) | null>(null);
  const fitSuppressedRef = useRef(false);

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
    (deltaY: number, clientX?: number, clientY?: number) => {
      const terminal = terminalRef.current;
      if (!terminal || deltaY === 0) {
        return;
      }

      const viewportElement = container?.querySelector(".xterm-viewport") as HTMLElement | null;
      if (viewportElement && typeof WheelEvent !== "undefined") {
        // Use provided coordinates, or fall back to center of viewport so
        // that apps with mouse-tracking (e.g. Zellij) receive a position
        // inside the pane content area rather than (0,0) which often maps
        // to the tab-bar.
        let cx = clientX;
        let cy = clientY;
        if (cx === undefined || cy === undefined) {
          const rect = viewportElement.getBoundingClientRect();
          cx = rect.left + rect.width / 2;
          cy = rect.top + rect.height / 2;
        }
        const wheelEvent = new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          deltaY,
          clientX: cx,
          clientY: cy,
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

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  useEffect(() => {
    onClipboardFallbackRef.current = onClipboardFallback;
  }, [onClipboardFallback]);

  useEffect(() => {
    onClipboardCopyRef.current = onClipboardCopy;
  }, [onClipboardCopy]);

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setContainer(node);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: fontSize and isMobileViewport are handled by the dedicated effect below to avoid full terminal recreation
  useEffect(() => {
    if (!container) {
      terminalMountedRef.current = false;
      return;
    }

    const terminal = new Terminal(buildTerminalOptions(isMobileViewport, fontSize));
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
      const finalRows = Math.max(proposed.rows, MIN_ROWS);
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
        const isAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
        const cursorLayer = terminal.element?.querySelector(".xterm-cursor-layer") as HTMLElement | null;
        if (cursorLayer) {
          cursorLayer.style.visibility = isAtBottom ? "" : "hidden";
        }
      }),
      terminal.parser.registerOscHandler(52, (data) => {
        const semicolonIndex = data.indexOf(";");
        if (semicolonIndex === -1) return true;
        const base64 = data.slice(semicolonIndex + 1);
        if (!base64 || base64 === "?") return true;
        try {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const text = new TextDecoder().decode(bytes);
          writeClipboardText(text)
            .then((ok) => {
              if (ok) {
                toast.success("Copied to clipboard", { id: "osc52" });
                onClipboardCopyRef.current?.(text);
              } else {
                onClipboardFallbackRef.current?.(text);
              }
            })
            .catch(() => {});
        } catch {
          // Ignore malformed base64
        }
        return true;
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
        return;
      }

      if (throttledFitTimeout !== undefined) {
        return;
      }

      throttledFitTimeout = window.setTimeout(() => {
        throttledFitTimeout = undefined;
        lastFitTime = Date.now();
        customFit();
      }, fitThrottleMs - elapsed);
    };

    const resizeObserver = new ResizeObserver(throttledFit);
    resizeObserver.observe(container);

    // On orientation change the viewport dimensions may settle over
    // multiple frames.  Schedule an extra re-fit after a short delay so
    // the terminal adapts to the final layout and doesn't keep a stale
    // scrollbar.
    let orientationFitTimeout: number | undefined;
    const onOrientationChange = () => {
      if (orientationFitTimeout !== undefined) {
        window.clearTimeout(orientationFitTimeout);
      }
      orientationFitTimeout = window.setTimeout(() => {
        orientationFitTimeout = undefined;
        customFit();
      }, 300);
    };
    const orientation = screen.orientation;
    orientation?.addEventListener("change", onOrientationChange);

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
      orientation?.removeEventListener("change", onOrientationChange);
      if (orientationFitTimeout !== undefined) {
        window.clearTimeout(orientationFitTimeout);
      }
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

      pendingTouchRef.current = null;
      clearScrollGesture();
    };
  }, [closeSocket, container, clearScrollGesture, hscroll, mobileTouchSupported, sendInputFrame]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const resolved = resolveFontSize(fontSize, isMobileViewport);
    if (terminal.options.fontSize !== resolved) {
      terminal.options.fontSize = resolved;
      customFitRef.current?.();
    }
  }, [fontSize, isMobileViewport]);

  useEffect(() => {
    if (!container || !mobileTouchSupported) {
      return;
    }

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
      if (event.touches.length !== 1) {
        pendingTouchRef.current = null;
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
      scrollGestureRef.current = {
        identifier: touch.identifier,
        lastY: touch.clientY,
        remainderPx: 0,
      };

      pendingTouchRef.current = {
        identifier: touch.identifier,
        startPoint: point,
        latestPoint: point,
      };
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
            pendingTouchRef.current = null;
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
      emitWheelDelta(lineDelta * cellHeight, matchingTouch.clientX, matchingTouch.clientY);
    };

    const onTouchEnd = (event: TouchEvent) => {
      const pendingTouch = pendingTouchRef.current;

      if (
        pendingTouch !== null &&
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

      pendingTouchRef.current = null;
      clearScrollGesture();
      hScrollTouch = null;
    };

    const onTouchCancel = () => {
      pendingTouchRef.current = null;
      clearScrollGesture();
      hScrollTouch = null;
    };

    const onContextMenu = (event: MouseEvent) => {
      if (pendingTouchRef.current !== null) {
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
      pendingTouchRef.current = null;
      clearScrollGesture();
    };
  }, [clearScrollGesture, container, emitWheelDelta, hscroll, getTerminalLayout, mobileTouchSupported]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectToken and container are intentional triggers for reconnection
  useEffect(() => {
    if (!wsUrl) {
      closeSocket();
      clearReconnectTimer();
      setConnectionStatus("disconnected");
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      setConnectionStatus("disconnected");
      return;
    }

    closeSocket();
    clearReconnectTimer();
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
          break;
        case ServerCommand.SET_WINDOW_TITLE:
          onTitleChangeRef.current?.(decoderRef.current.decode(frame.payload));
          break;
        default:
          break;
      }
    };

    const handleControlMessage = (text: string) => {
      if (!isCurrentConnection()) return;

      let msg: ServerControlMessage;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (typeof msg !== "object" || msg === null || !("type" in msg)) return;

      switch (msg.type) {
        case "session_info":
          sessionIdRef.current = msg.sessionId;
          sessionStorage.setItem(SESSION_STORAGE_KEY, msg.sessionId);
          reconnectAttemptRef.current = 0;
          setConnectionStatus("connected");
          toast.dismiss("connection-status");
          break;

        case "ping":
          socket.send(JSON.stringify({ type: "pong", timestamp: msg.timestamp }));
          break;

        case "session_ended":
          sessionIdRef.current = null;
          sessionStorage.removeItem(SESSION_STORAGE_KEY);
          break;

        case "error":
          // Session not found — clear stored session and retry as fresh handshake
          sessionIdRef.current = null;
          sessionStorage.removeItem(SESSION_STORAGE_KEY);
          terminal.reset();
          socket.send(JSON.stringify({ type: "handshake", columns: terminal.cols, rows: terminal.rows }));
          break;
      }
    };

    socket.onopen = () => {
      if (!isCurrentConnection()) {
        return;
      }

      if (sessionIdRef.current) {
        // Reconnecting to existing session — reset terminal for scrollback replay
        terminal.reset();
        socket.send(
          JSON.stringify({
            type: "reconnect",
            sessionId: sessionIdRef.current,
            columns: terminal.cols,
            rows: terminal.rows,
          }),
        );
      } else {
        socket.send(JSON.stringify({ type: "handshake", columns: terminal.cols, rows: terminal.rows }));
      }

      customFitRef.current?.();
      if (!mobileTouchSupported) {
        terminal.focus();
      }
    };

    socket.onmessage = (event) => {
      if (!isCurrentConnection()) {
        return;
      }

      if (typeof event.data === "string") {
        handleControlMessage(event.data);
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

      switch (event.code) {
        case CLOSE_CODE_RESTART:
          // Server restart: clear session, reset terminal, reconnect immediately
          sessionIdRef.current = null;
          sessionStorage.removeItem(SESSION_STORAGE_KEY);
          terminal.reset();
          toast.info("Restarting...", { id: "connection-status" });
          reconnectAttemptRef.current = 0;
          setReconnectToken((prev) => prev + 1);
          return;

        case CLOSE_CODE_HEARTBEAT:
          // Heartbeat timeout: keep session ID, auto-reconnect with backoff
          toast.info("Connection lost. Reconnecting...", { id: "connection-status" });
          break;

        case 1000:
          // Normal close (shell exited): clear session
          sessionIdRef.current = null;
          sessionStorage.removeItem(SESSION_STORAGE_KEY);
          toast.error(`Disconnected: ${event.reason || "Shell exited"}.`, { id: "connection-status" });
          return;

        default:
          // Unexpected: keep session ID, auto-reconnect with backoff
          toast.error(`Disconnected (code ${event.code}).`, { id: "connection-status" });
          break;
      }

      // Auto-reconnect with exponential backoff
      const delay = computeReconnectDelay(reconnectAttemptRef.current);
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (isCurrentConnection()) {
          setReconnectToken((prev) => prev + 1);
        }
      }, delay);
    };

    return () => {
      if (connectionEpochRef.current === connectionEpoch) {
        connectionEpochRef.current += 1;
      }
      if (socket === socketRef.current) {
        closeSocket();
      }
    };
  }, [wsUrl, reconnectToken, closeSocket, clearReconnectTimer, container, mobileTouchSupported]);

  const reconnect = useCallback(() => {
    // Resume existing session — just trigger a new WebSocket connection
    clearReconnectTimer();
    reconnectAttemptRef.current = 0;
    setReconnectToken((prev) => prev + 1);
  }, [clearReconnectTimer]);

  const restart = useCallback(() => {
    if (!wsUrl) return;

    // Clear session ID so we get a fresh session
    sessionIdRef.current = null;
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    clearReconnectTimer();
    reconnectAttemptRef.current = 0;

    fetch("/api/restart", { method: "POST" }).catch((error: unknown) => {
      console.error("Failed to POST /api/restart:", error);
      toast.error("Restart request failed. Reconnecting locally.", { id: "restart" });
    });

    // If already disconnected, the server can't close our socket with code 4000,
    // so trigger the reconnect directly.
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      terminalRef.current?.reset();
      setReconnectToken((prev) => prev + 1);
    }
  }, [clearReconnectTimer, wsUrl]);

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

    return new Promise<string>((resolve) => {
      terminal.write("", () => {
        fitSuppressedRef.current = true;
        let recentOutput: string;
        try {
          recentOutput = collectRecentOutput(terminal, RECENT_OUTPUT_LINES);
        } finally {
          fitSuppressedRef.current = false;
        }

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

  const copyTextToClipboard = useCallback(async (text: string): Promise<boolean> => {
    return writeClipboardText(text);
  }, []);

  return {
    containerRef,
    connectionStatus,
    sysKeyActive,
    restart,
    reconnect,
    focusSysKeyboard,
    focusTerminalInput,
    sendSoftKeySequence,
    blurTerminalInput,
    attemptPasteFromClipboard,
    pasteTextIntoTerminal,
    getSelectableText,
    copyTextToClipboard,
    horizontalOverflow,
    containerElement: container,
  };
}
