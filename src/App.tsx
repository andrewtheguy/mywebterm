import {
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Toaster, toast } from "sonner";
import { DEFAULT_APP_TITLE, loadTtydConfig, type TtydConfig } from "./config";
import type { SoftKeyModifiers } from "./softKeyboard";
import {
  applyShiftToPrintable,
  buildSoftKeySequence,
  COMBO_KEY_ROW,
  DEFAULT_SOFT_KEY_MODIFIERS,
  FUNCTION_KEY_ROW,
  PRIMARY_SCREEN_ROWS,
  SECONDARY_SCREEN_ROWS,
  type SoftKeyboardScreen,
  type SoftKeyDefinition,
  type SoftModifierName,
} from "./softKeyboard";
import { useTtydTerminal } from "./useTtydTerminal";

function softKeyLabel(key: SoftKeyDefinition, shiftActive: boolean): string {
  if (key.kind === "printable") {
    if (shiftActive) {
      return applyShiftToPrintable(key.value, true);
    }
    if (/^[a-z]$/.test(key.value)) {
      return key.value;
    }
  }
  return key.label;
}

function softKeyShiftHint(key: SoftKeyDefinition, shiftActive: boolean): string | null {
  if (shiftActive) return null;
  if (key.kind !== "printable") return null;
  if (/^[a-z]$/.test(key.value)) return null;
  const shifted = applyShiftToPrintable(key.value, true);
  if (shifted === key.value) return null;
  return shifted;
}

const ROW_KEYS = ["num", "alpha1", "alpha2", "alpha3", "bottom"] as const;

const SECONDARY_ROW2_ARROW_LABELS = new Set([",", "▲", "Ins"]);
const SECONDARY_ROW3_ARROW_LABELS = new Set(["◀", "▼", "▶"]);

const FRAME_BKSP: SoftKeyDefinition = {
  id: "special-backspace",
  label: "Bksp",
  kind: "special",
  special: "backspace",
  group: "main",
};

const FRAME_ENTER: SoftKeyDefinition = {
  id: "special-enter",
  label: "Enter",
  kind: "special",
  special: "enter",
  group: "main",
};

const FRAME_SPACE: SoftKeyDefinition = {
  id: "printable-%20",
  label: "Space",
  kind: "printable",
  value: " ",
  group: "main",
};

function ExtraKeyButton({
  softKey,
  className,
  children,
  startKeyRepeat,
  stopKeyRepeat,
}: {
  softKey: SoftKeyDefinition;
  className?: string;
  children: React.ReactNode;
  startKeyRepeat: (key: SoftKeyDefinition) => void;
  stopKeyRepeat: () => void;
}) {
  return (
    <button
      type="button"
      className={`toolbar-button extra-key-button ${className ?? ""}`}
      onPointerDown={(e) => {
        e.preventDefault();
        startKeyRepeat(softKey);
      }}
      onPointerUp={stopKeyRepeat}
      onPointerLeave={stopKeyRepeat}
      onPointerCancel={stopKeyRepeat}
    >
      {children}
    </button>
  );
}

export function App() {
  const [config, setConfig] = useState<TtydConfig | null>(null);
  const [remoteTitle, setRemoteTitle] = useState<string | null>(null);
  const [selectableText, setSelectableText] = useState<string | null>(null);
  const [pasteHelperText, setPasteHelperText] = useState<string | null>(null);
  const [processesText, setProcessesText] = useState<string | null>(null);
  const [softKeysOpen, setSoftKeysOpen] = useState(false);
  const [keyboardScreen, setKeyboardScreen] = useState<SoftKeyboardScreen>("primary");
  const [softKeyModifiers, setSoftKeyModifiers] = useState(() => ({
    ...DEFAULT_SOFT_KEY_MODIFIERS,
  }));
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 768px)").matches);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const selectableTextRef = useRef<HTMLTextAreaElement | null>(null);
  const pasteHelperRef = useRef<HTMLTextAreaElement | null>(null);
  const pasteHelperFocusedRef = useRef(false);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 768px)");
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!overflowMenuOpen) {
      return;
    }
    const close = (e: MouseEvent | TouchEvent) => {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        setOverflowMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [overflowMenuOpen]);

  const overflowAction = useCallback((action: () => void) => {
    setOverflowMenuOpen(false);
    action();
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadTtydConfig()
      .then((cfg) => {
        if (!cancelled) {
          setConfig(cfg);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error("Failed to load configuration:", error);
          toast.error("Failed to load configuration.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTitleChange = useCallback((title: string) => {
    if (title.trim().length === 0) {
      return;
    }
    setRemoteTitle(title);
  }, []);

  const {
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
    containerElement,
    verticalScrollSyncRef,
    getVerticalScrollState,
  } = useTtydTerminal({
    wsUrl: config?.wsUrl,
    onTitleChange: handleTitleChange,
    hscroll: config?.hscroll,
  });

  const appShellRef = useRef<HTMLDivElement>(null);
  const scrollbarTrackRef = useRef<HTMLDivElement>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement>(null);
  const scrollbarDraggingRef = useRef(false);
  const scrollbarDragStartXRef = useRef(0);
  const scrollbarDragStartScrollLeftRef = useRef(0);
  const vScrollbarTrackRef = useRef<HTMLDivElement>(null);
  const vScrollbarThumbRef = useRef<HTMLDivElement>(null);
  const vScrollbarHideTimerRef = useRef<number | null>(null);
  const repeatTimerRef = useRef<number | null>(null);
  const repeatIntervalRef = useRef<number | null>(null);
  const repeatModifiersRef = useRef<SoftKeyModifiers | null>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) {
      return;
    }

    const syncHeight = () => {
      const shell = appShellRef.current;
      if (shell) {
        shell.style.height = `${vv.height}px`;
      }
    };

    const onResize = () => {
      syncHeight();
      window.scrollTo(0, 0);
    };

    onResize();

    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", syncHeight);
    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", syncHeight);
    };
  }, []);

  const appTitle = config?.appTitle ?? DEFAULT_APP_TITLE;

  useEffect(() => {
    document.title = remoteTitle ? `${remoteTitle} | ${appTitle}` : appTitle;
  }, [appTitle, remoteTitle]);

  useEffect(() => {
    if (!selectableTextRef.current || selectableText === null) {
      return;
    }

    const textarea = selectableTextRef.current;
    // Double rAF + setTimeout to ensure the browser has fully laid out the content
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        textarea.scrollTop = textarea.scrollHeight;
        textarea.focus();
      });
    });
    const timerId = setTimeout(() => {
      const current = selectableTextRef.current;
      if (current) {
        current.scrollTop = current.scrollHeight;
      }
    }, 100);
    return () => clearTimeout(timerId);
  }, [selectableText]);

  useEffect(() => {
    if (pasteHelperText === null) {
      pasteHelperFocusedRef.current = false;
      return;
    }

    if (!pasteHelperRef.current || pasteHelperFocusedRef.current) {
      return;
    }

    pasteHelperRef.current.focus();
    pasteHelperRef.current.setSelectionRange(pasteHelperText.length, pasteHelperText.length);
    pasteHelperFocusedRef.current = true;
  }, [pasteHelperText]);

  useEffect(() => {
    if (softKeysOpen) {
      return;
    }

    setSoftKeyModifiers({
      ...DEFAULT_SOFT_KEY_MODIFIERS,
    });
    setKeyboardScreen("primary");

    if (repeatTimerRef.current !== null) {
      window.clearTimeout(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
    if (repeatIntervalRef.current !== null) {
      window.clearInterval(repeatIntervalRef.current);
      repeatIntervalRef.current = null;
    }
    repeatModifiersRef.current = null;
  }, [softKeysOpen]);

  const openSelectableText = useCallback(async () => {
    const text = await getSelectableText();
    if (text.length === 0) {
      return;
    }
    setPasteHelperText(null);
    setSelectableText(text);
  }, [getSelectableText]);

  const closeSelectableText = useCallback(() => {
    setSelectableText(null);
  }, []);

  const openPasteHelper = useCallback(() => {
    setSelectableText(null);
    setPasteHelperText("");
  }, []);

  const closePasteHelper = useCallback(() => {
    pasteHelperFocusedRef.current = false;
    setPasteHelperText(null);
  }, []);

  const handleToolbarPaste = useCallback(async () => {
    const result = await attemptPasteFromClipboard();
    if (result === "pasted") {
      toast.success("Pasted from clipboard.", { id: "paste" });
      focusTerminalInput();
    } else if (result === "fallback-required") {
      openPasteHelper();
    } else if (result === "empty") {
      toast.error("Clipboard is empty.", { id: "paste" });
    } else if (result === "terminal-unavailable") {
      toast.error("Terminal not ready.", { id: "paste" });
    }
  }, [attemptPasteFromClipboard, focusTerminalInput, openPasteHelper]);

  const submitPasteHelperText = useCallback(() => {
    if (pasteHelperText === null) {
      return;
    }
    const pasted = pasteTextIntoTerminal(pasteHelperText);
    if (pasted) {
      toast.success("Pasted text.", { id: "paste" });
      closePasteHelper();
    }
  }, [closePasteHelper, pasteHelperText, pasteTextIntoTerminal]);

  const toggleSoftModifier = useCallback((modifier: SoftModifierName) => {
    setSoftKeyModifiers((previous) => ({
      ...previous,
      [modifier]: !previous[modifier],
    }));
  }, []);

  const clearSoftModifiers = useCallback(() => {
    setSoftKeyModifiers({
      ...DEFAULT_SOFT_KEY_MODIFIERS,
    });
  }, []);

  const stopKeyRepeat = useCallback(() => {
    const hadRepeat = repeatTimerRef.current !== null || repeatIntervalRef.current !== null;
    if (repeatTimerRef.current !== null) {
      window.clearTimeout(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
    if (repeatIntervalRef.current !== null) {
      window.clearInterval(repeatIntervalRef.current);
      repeatIntervalRef.current = null;
    }
    repeatModifiersRef.current = null;
    if (hadRepeat) {
      clearSoftModifiers();
    }
  }, [clearSoftModifiers]);

  const startKeyRepeat = useCallback(
    (key: SoftKeyDefinition) => {
      stopKeyRepeat();

      const capturedModifiers = { ...softKeyModifiers };
      repeatModifiersRef.current = capturedModifiers;

      const fireKey = () => {
        const mods = repeatModifiersRef.current ?? capturedModifiers;
        const sequence = buildSoftKeySequence(key, mods);
        if (sequence.ok) {
          sendSoftKeySequence(sequence.sequence, sequence.description, true);
        }
      };

      fireKey();

      repeatTimerRef.current = window.setTimeout(() => {
        repeatTimerRef.current = null;
        repeatIntervalRef.current = window.setInterval(fireKey, 80);
      }, 400);
    },
    [sendSoftKeySequence, softKeyModifiers, stopKeyRepeat],
  );

  const beginSelectionHandleDrag = useCallback(
    (handle: "start" | "end", event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "touch") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setActiveHandle(handle);
      updateActiveHandleFromClientPoint(event.clientX, event.clientY);
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    },
    [setActiveHandle, updateActiveHandleFromClientPoint],
  );

  const handleSelectionHandleMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "touch" || mobileSelectionState.activeHandle === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      updateActiveHandleFromClientPoint(event.clientX, event.clientY);
    },
    [mobileSelectionState.activeHandle, updateActiveHandleFromClientPoint],
  );

  const finishSelectionHandleDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "touch") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setActiveHandle(null);
    },
    [setActiveHandle],
  );

  const beginSelectionHandleTouch = useCallback(
    (handle: "start" | "end", event: ReactTouchEvent<HTMLButtonElement>) => {
      const touch = event.touches.item(0);
      if (!touch) {
        return;
      }

      event.stopPropagation();
      setActiveHandle(handle);
      updateActiveHandleFromClientPoint(touch.clientX, touch.clientY);
    },
    [setActiveHandle, updateActiveHandleFromClientPoint],
  );

  const handleSelectionHandleTouchMove = useCallback(
    (event: ReactTouchEvent<HTMLButtonElement>) => {
      if (mobileSelectionState.activeHandle === null) {
        return;
      }

      const touch = event.touches.item(0);
      if (!touch) {
        return;
      }

      event.stopPropagation();
      updateActiveHandleFromClientPoint(touch.clientX, touch.clientY);
    },
    [mobileSelectionState.activeHandle, updateActiveHandleFromClientPoint],
  );

  const finishSelectionHandleTouch = useCallback(
    (event: ReactTouchEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      setActiveHandle(null);
    },
    [setActiveHandle],
  );

  const fetchProcessesText = useCallback(async (): Promise<string> => {
    const res = await fetch("/api/sessions");
    if (!res.ok) {
      throw new Error(`Failed to fetch processes: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const children = (data.children as { pid: number; command: string }[]) ?? [];
    const lines = [`Server PID: ${data.ppid}`, "", `Child processes (${children.length}):`];

    if (children.length === 0) {
      lines.push("  (none)");
    } else {
      for (const c of children) {
        lines.push(`  ${c.pid}  ${c.command}`);
      }
    }

    return lines.join("\n");
  }, []);

  const inspectProcesses = useCallback(async () => {
    try {
      setProcessesText(await fetchProcessesText());
    } catch {
      toast.error("Failed to fetch processes.");
    }
  }, [fetchProcessesText]);

  const refreshProcesses = useCallback(async () => {
    try {
      setProcessesText(await fetchProcessesText());
    } catch {
      toast.error("Failed to refresh processes.");
    }
  }, [fetchProcessesText]);

  const handleMobileCopySelection = useCallback(async () => {
    const selectedText = getTerminalSelection();
    if (selectedText.length === 0) {
      return;
    }
    const copied = await copyTextToClipboard(selectedText);
    if (copied) {
      toast.success("Selection copied.", { id: "copy" });
      clearMobileSelection();
    } else {
      toast.error("Clipboard copy failed.", { id: "copy" });
      setActiveHandle(null);
    }
  }, [clearMobileSelection, copyTextToClipboard, getTerminalSelection, setActiveHandle]);

  const syncScrollbarThumb = useCallback(() => {
    const track = scrollbarTrackRef.current;
    const thumb = scrollbarThumbRef.current;
    const viewport = containerElement;
    if (!track || !thumb || !viewport) {
      return;
    }

    const scrollWidth = viewport.scrollWidth;
    const clientWidth = viewport.clientWidth;
    if (scrollWidth <= clientWidth) {
      return;
    }

    const trackWidth = track.clientWidth;
    const thumbWidth = Math.max(20, (clientWidth / scrollWidth) * trackWidth);
    const maxScrollLeft = scrollWidth - clientWidth;
    const scrollRatio = maxScrollLeft > 0 ? viewport.scrollLeft / maxScrollLeft : 0;
    const maxThumbLeft = trackWidth - thumbWidth;

    thumb.style.width = `${thumbWidth}px`;
    thumb.style.left = `${scrollRatio * maxThumbLeft}px`;
  }, [containerElement]);

  useEffect(() => {
    const viewport = containerElement;
    if (!viewport || !horizontalOverflow) {
      return;
    }

    syncScrollbarThumb();
    viewport.addEventListener("scroll", syncScrollbarThumb);
    return () => viewport.removeEventListener("scroll", syncScrollbarThumb);
  }, [containerElement, horizontalOverflow, syncScrollbarThumb]);

  const syncVerticalScrollbarThumb = useCallback(() => {
    const track = vScrollbarTrackRef.current;
    const thumb = vScrollbarThumbRef.current;
    if (!track || !thumb) {
      return;
    }

    const state = getVerticalScrollState();
    if (!state || state.baseY <= 0) {
      thumb.style.opacity = "0";
      return;
    }

    const trackHeight = track.clientHeight;
    const totalLines = state.baseY + state.rows;
    const thumbHeight = Math.max(20, (state.rows / totalLines) * trackHeight);
    const maxThumbTop = trackHeight - thumbHeight;
    const thumbTop = (state.viewportY / state.baseY) * maxThumbTop;

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.top = `${thumbTop}px`;
    thumb.style.opacity = "1";

    if (vScrollbarHideTimerRef.current !== null) {
      window.clearTimeout(vScrollbarHideTimerRef.current);
    }
    vScrollbarHideTimerRef.current = window.setTimeout(() => {
      thumb.style.opacity = "0";
      vScrollbarHideTimerRef.current = null;
    }, 1000);
  }, [getVerticalScrollState]);

  useEffect(() => {
    if (!mobileSelectionState.enabled) {
      return;
    }

    verticalScrollSyncRef.current = syncVerticalScrollbarThumb;
    syncVerticalScrollbarThumb();

    return () => {
      verticalScrollSyncRef.current = null;
      if (vScrollbarHideTimerRef.current !== null) {
        window.clearTimeout(vScrollbarHideTimerRef.current);
        vScrollbarHideTimerRef.current = null;
      }
    };
  }, [mobileSelectionState.enabled, syncVerticalScrollbarThumb, verticalScrollSyncRef]);

  const handleScrollbarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      scrollbarDraggingRef.current = true;
      scrollbarDragStartXRef.current = event.clientX;
      scrollbarDragStartScrollLeftRef.current = containerElement?.scrollLeft ?? 0;
    },
    [containerElement],
  );

  const handleScrollbarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!scrollbarDraggingRef.current) {
        return;
      }
      event.preventDefault();

      const track = scrollbarTrackRef.current;
      const thumb = scrollbarThumbRef.current;
      const viewport = containerElement;
      if (!track || !thumb || !viewport) {
        return;
      }

      const scrollWidth = viewport.scrollWidth;
      const clientWidth = viewport.clientWidth;
      const maxScrollLeft = scrollWidth - clientWidth;
      if (maxScrollLeft <= 0) {
        return;
      }

      const trackWidth = track.clientWidth;
      const thumbWidth = thumb.clientWidth;
      const maxThumbTravel = trackWidth - thumbWidth;
      if (maxThumbTravel <= 0) {
        return;
      }

      const deltaX = event.clientX - scrollbarDragStartXRef.current;
      const scaleFactor = maxScrollLeft / maxThumbTravel;
      viewport.scrollLeft = scrollbarDragStartScrollLeftRef.current + deltaX * scaleFactor;
    },
    [containerElement],
  );

  const handleScrollbarPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrollbarDraggingRef.current) {
      return;
    }
    event.preventDefault();
    scrollbarDraggingRef.current = false;
  }, []);

  const mobileSelectionOverlay =
    mobileSelectionState.enabled &&
    mobileSelectionState.range !== null &&
    mobileSelectionState.startHandle !== null &&
    mobileSelectionState.endHandle !== null &&
    mobileSelectionState.toolbarAnchor !== null
      ? {
          startHandle: mobileSelectionState.startHandle,
          endHandle: mobileSelectionState.endHandle,
          toolbarAnchor: mobileSelectionState.toolbarAnchor,
        }
      : null;

  return (
    <div className="app-shell" ref={appShellRef}>
      <header className="topbar">
        <div className="brand">
          <h1>
            {appTitle}
            <span
              className={`status-badge status-${connectionStatus}`}
              role="status"
              aria-label={
                connectionStatus === "connected"
                  ? "Connected"
                  : connectionStatus === "connecting"
                    ? "Connecting"
                    : connectionStatus === "error"
                      ? "Error"
                      : "Disconnected"
              }
            >
              {connectionStatus === "connecting" ? "..." : connectionStatus}
            </span>
          </h1>
          <p className="brand-tagline">Web terminal powered by Bun PTY</p>
        </div>
        <div className="toolbar">
          <div
            className="toolbar-actions"
            role="toolbar"
            // Prevent default on mouse/touch so that pressing toolbar buttons
            // doesn't trigger text selection or steal focus from the terminal.
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
          >
            {isMobile && (
              <button
                type="button"
                className={`toolbar-button ${sysKeyActive ? "toolbar-button-active" : ""}`}
                onClick={() => {
                  setSoftKeysOpen(false);
                  focusSysKeyboard();
                }}
                aria-pressed={sysKeyActive}
              >
                Sys Keys
              </button>
            )}
            <button
              type="button"
              className={`toolbar-button ${softKeysOpen ? "toolbar-button-active" : ""}`}
              onClick={() => {
                setSoftKeysOpen((previous) => {
                  const nextOpen = !previous;
                  if (nextOpen) {
                    blurTerminalInput();
                  } else {
                    focusTerminalInput();
                  }
                  return nextOpen;
                });
                setOverflowMenuOpen(false);
              }}
              aria-pressed={softKeysOpen}
            >
              Soft Keys
            </button>
            <button type="button" className="toolbar-button" onClick={() => void openSelectableText()}>
              Copy Text
            </button>
            <button
              type="button"
              className="toolbar-button"
              onClick={() => void handleToolbarPaste()}
              title="Paste from clipboard. If blocked, a helper panel opens for iOS paste."
            >
              Paste Text
            </button>
            {isMobile ? (
              <div className="overflow-menu" ref={overflowMenuRef}>
                <button
                  type="button"
                  className="toolbar-button overflow-menu-trigger"
                  onClick={() => setOverflowMenuOpen((prev) => !prev)}
                  aria-expanded={overflowMenuOpen}
                  aria-label="More actions"
                >
                  &#8942;
                </button>
                {overflowMenuOpen && (
                  <div className="overflow-menu-panel">
                    {connectionStatus === "connected" ? (
                      <button
                        type="button"
                        className="toolbar-button overflow-menu-item"
                        onClick={() =>
                          overflowAction(() => {
                            if (window.confirm("Restart terminal session?")) {
                              setProcessesText(null);
                              reconnect();
                            }
                          })
                        }
                      >
                        Restart
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="toolbar-button overflow-menu-item reconnect-button"
                        onClick={() => overflowAction(reconnect)}
                        disabled={connectionStatus === "connecting"}
                      >
                        Reconnect
                      </button>
                    )}
                    <button
                      type="button"
                      className="toolbar-button overflow-menu-item"
                      onClick={() => overflowAction(() => void inspectProcesses())}
                    >
                      Processes
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <>
                {connectionStatus === "connected" ? (
                  <button
                    type="button"
                    className="toolbar-button"
                    onClick={() => {
                      if (window.confirm("Restart terminal session?")) {
                        setProcessesText(null);
                        reconnect();
                      }
                    }}
                  >
                    Restart
                  </button>
                ) : (
                  <button
                    type="button"
                    className="toolbar-button reconnect-button"
                    onClick={reconnect}
                    disabled={connectionStatus === "connecting"}
                  >
                    Reconnect
                  </button>
                )}
                <button type="button" className="toolbar-button" onClick={() => void inspectProcesses()}>
                  Processes
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="terminal-card">
        <div className="terminal-stage">
          <div
            ref={containerRef}
            className={`terminal-viewport ${isMobile ? "terminal-viewport-pass-through" : ""} ${horizontalOverflow ? "terminal-viewport-overflow" : ""}`}
          />

          {connectionStatus !== "connected" &&
            (connectionStatus === "connecting" ? (
              <div className="disconnect-overlay">
                <p className="disconnect-overlay-text disconnect-overlay-connecting">Connecting...</p>
              </div>
            ) : (
              <div
                className="disconnect-overlay"
                role="button"
                tabIndex={0}
                onClick={() => reconnect()}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    reconnect();
                  }
                }}
              >
                <p className="disconnect-overlay-text">Click or press Space to reconnect</p>
              </div>
            ))}

          {mobileSelectionOverlay !== null && (
            <div className="mobile-selection-overlay">
              <button
                type="button"
                className="mobile-selection-handle mobile-selection-handle-start"
                style={{
                  left: `${mobileSelectionOverlay.startHandle.left}px`,
                  top: `${mobileSelectionOverlay.startHandle.top}px`,
                }}
                onPointerDown={(event) => beginSelectionHandleDrag("start", event)}
                onPointerMove={handleSelectionHandleMove}
                onPointerUp={finishSelectionHandleDrag}
                onPointerCancel={finishSelectionHandleDrag}
                onLostPointerCapture={finishSelectionHandleDrag}
                onTouchStart={(event) => beginSelectionHandleTouch("start", event)}
                onTouchMove={handleSelectionHandleTouchMove}
                onTouchEnd={finishSelectionHandleTouch}
                onTouchCancel={finishSelectionHandleTouch}
                aria-label="Adjust selection start"
              >
                <span className="mobile-selection-handle-knob" />
              </button>

              <button
                type="button"
                className="mobile-selection-handle mobile-selection-handle-end"
                style={{
                  left: `${mobileSelectionOverlay.endHandle.left}px`,
                  top: `${mobileSelectionOverlay.endHandle.top}px`,
                }}
                onPointerDown={(event) => beginSelectionHandleDrag("end", event)}
                onPointerMove={handleSelectionHandleMove}
                onPointerUp={finishSelectionHandleDrag}
                onPointerCancel={finishSelectionHandleDrag}
                onLostPointerCapture={finishSelectionHandleDrag}
                onTouchStart={(event) => beginSelectionHandleTouch("end", event)}
                onTouchMove={handleSelectionHandleTouchMove}
                onTouchEnd={finishSelectionHandleTouch}
                onTouchCancel={finishSelectionHandleTouch}
                aria-label="Adjust selection end"
              >
                <span className="mobile-selection-handle-knob" />
              </button>

              <div
                className="mobile-selection-toolbar"
                style={{
                  left: `${mobileSelectionOverlay.toolbarAnchor.left}px`,
                  top: `${mobileSelectionOverlay.toolbarAnchor.top}px`,
                }}
                role="group"
                aria-label="Selection actions"
              >
                <button type="button" className="toolbar-button" onClick={() => void handleMobileCopySelection()}>
                  Copy
                </button>
                <button type="button" className="toolbar-button" onClick={clearMobileSelection}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {mobileSelectionState.enabled && (
            <div className="vertical-scrollbar">
              <div className="vertical-scrollbar-track" ref={vScrollbarTrackRef}>
                <div className="vertical-scrollbar-thumb" ref={vScrollbarThumbRef} />
              </div>
            </div>
          )}
        </div>
      </main>

      {horizontalOverflow && (
        <div className="custom-scrollbar">
          <div className="custom-scrollbar-track" ref={scrollbarTrackRef}>
            <div
              className="custom-scrollbar-thumb"
              ref={scrollbarThumbRef}
              onPointerDown={handleScrollbarPointerDown}
              onPointerMove={handleScrollbarPointerMove}
              onPointerUp={handleScrollbarPointerUp}
              onPointerCancel={handleScrollbarPointerUp}
              onLostPointerCapture={handleScrollbarPointerUp}
            />
          </div>
        </div>
      )}

      {softKeysOpen &&
        (() => {
          const screenRows = keyboardScreen === "primary" ? PRIMARY_SCREEN_ROWS : SECONDARY_SCREEN_ROWS;
          return (
            <section className="extra-keys-panel" aria-label="Extra key controls">
              <div className="extra-keys-grid" role="group" aria-label="Terminal keys">
                {keyboardScreen === "primary" && (
                  <div className="extra-keys-fkey-row extra-keys-combo-row">
                    {COMBO_KEY_ROW.map((combo) => (
                      <ExtraKeyButton
                        key={combo.id}
                        softKey={combo}
                        className="extra-key-combo"
                        startKeyRepeat={startKeyRepeat}
                        stopKeyRepeat={stopKeyRepeat}
                      >
                        {combo.label}
                      </ExtraKeyButton>
                    ))}
                  </div>
                )}
                {keyboardScreen === "secondary" && (
                  <div className="extra-keys-fkey-row">
                    {FUNCTION_KEY_ROW.map((fkey) => (
                      <ExtraKeyButton
                        key={fkey.id}
                        softKey={fkey}
                        className="extra-key-fkey"
                        startKeyRepeat={startKeyRepeat}
                        stopKeyRepeat={stopKeyRepeat}
                      >
                        {fkey.label}
                      </ExtraKeyButton>
                    ))}
                  </div>
                )}
                {screenRows.map((row, rowIndex) => (
                  <div
                    key={ROW_KEYS[rowIndex]}
                    className={`extra-keys-row${rowIndex === 3 && keyboardScreen === "primary" ? " extra-keys-zrow" : ""}`}
                  >
                    {rowIndex === 3 && (
                      <button
                        type="button"
                        className={`toolbar-button extra-key-button extra-key-wide-xl ${softKeyModifiers.shift ? "toolbar-button-active" : ""}`}
                        onClick={() => toggleSoftModifier("shift")}
                        aria-pressed={softKeyModifiers.shift}
                      >
                        ⇧
                      </button>
                    )}
                    {rowIndex === 4 && (
                      <>
                        <button
                          type="button"
                          className="toolbar-button extra-key-button extra-key-meta extra-key-wide-md"
                          onClick={() => {
                            setKeyboardScreen(keyboardScreen === "primary" ? "secondary" : "primary");
                          }}
                          aria-label={
                            keyboardScreen === "primary" ? "Switch to symbols keyboard" : "Switch to alphabet keyboard"
                          }
                        >
                          {keyboardScreen === "primary" ? "sym" : "abc"}
                        </button>
                        <button
                          type="button"
                          className={`toolbar-button extra-key-button extra-key-wide-md ${softKeyModifiers.ctrl ? "toolbar-button-active" : ""}`}
                          onClick={() => toggleSoftModifier("ctrl")}
                          aria-pressed={softKeyModifiers.ctrl}
                        >
                          Ctrl
                        </button>
                        <button
                          type="button"
                          className={`toolbar-button extra-key-button extra-key-wide-md ${softKeyModifiers.alt ? "toolbar-button-active" : ""}`}
                          onClick={() => toggleSoftModifier("alt")}
                          aria-pressed={softKeyModifiers.alt}
                        >
                          Alt
                        </button>
                        <ExtraKeyButton
                          softKey={FRAME_SPACE}
                          className="extra-key-button-space"
                          startKeyRepeat={startKeyRepeat}
                          stopKeyRepeat={stopKeyRepeat}
                        >
                          Space
                        </ExtraKeyButton>
                      </>
                    )}
                    {(() => {
                      const dataKeys = row.map((key) => {
                        const label = softKeyLabel(key, softKeyModifiers.shift);
                        const hint = softKeyShiftHint(key, softKeyModifiers.shift);
                        const isSecondaryArrow =
                          keyboardScreen === "secondary" &&
                          ((rowIndex === 2 && SECONDARY_ROW2_ARROW_LABELS.has(key.label)) ||
                            (rowIndex === 3 && SECONDARY_ROW3_ARROW_LABELS.has(key.label)));
                        const classes = [
                          label.length === 1 ? "extra-key-single-char" : "",
                          isSecondaryArrow ? "extra-key-arrow" : "",
                        ]
                          .filter(Boolean)
                          .join(" ");
                        return (
                          <ExtraKeyButton
                            key={key.id}
                            softKey={key}
                            className={classes}
                            startKeyRepeat={startKeyRepeat}
                            stopKeyRepeat={stopKeyRepeat}
                          >
                            {label}
                            {hint && <span className="extra-key-shift-hint">{hint}</span>}
                          </ExtraKeyButton>
                        );
                      });
                      if (rowIndex === 4) {
                        return <div className="extra-key-data-group">{dataKeys}</div>;
                      }
                      if (rowIndex === 2 && keyboardScreen === "primary") {
                        return (
                          <>
                            <div className="extra-key-spacer extra-key-half-spacer" />
                            {dataKeys}
                            <div className="extra-key-spacer extra-key-half-spacer" />
                          </>
                        );
                      }
                      if (rowIndex === 3 && keyboardScreen === "primary") {
                        return <div className="extra-key-data-group extra-key-zrow-group">{dataKeys}</div>;
                      }
                      return dataKeys;
                    })()}
                    {rowIndex === 3 && keyboardScreen === "primary" && (
                      <ExtraKeyButton
                        softKey={FRAME_BKSP}
                        className="extra-key-wide-lg"
                        startKeyRepeat={startKeyRepeat}
                        stopKeyRepeat={stopKeyRepeat}
                      >
                        ⌫
                      </ExtraKeyButton>
                    )}
                    {rowIndex === 4 && (
                      <ExtraKeyButton
                        softKey={FRAME_ENTER}
                        className="extra-key-wide-xl"
                        startKeyRepeat={startKeyRepeat}
                        stopKeyRepeat={stopKeyRepeat}
                      >
                        Enter
                      </ExtraKeyButton>
                    )}
                  </div>
                ))}
              </div>
            </section>
          );
        })()}

      {selectableText !== null &&
        (() => {
          const lineCount = selectableText.split("\n").length;
          return (
            <section className="copy-sheet" aria-label="Selectable terminal text">
              <div className="copy-sheet-header">
                <h2>
                  Copy Text ({lineCount} line{lineCount === 1 ? "" : "s"})
                </h2>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    type="button"
                    className="toolbar-button"
                    onClick={async () => {
                      try {
                        const ok = await copyTextToClipboard(selectableText);
                        if (ok) {
                          toast.success(`Copied ${lineCount} line${lineCount === 1 ? "" : "s"}.`, { id: "copy" });
                        } else {
                          toast.error("Clipboard copy failed.", { id: "copy" });
                        }
                      } catch {
                        toast.error("Clipboard copy failed.", { id: "copy" });
                      }
                    }}
                  >
                    Copy All
                  </button>
                  <button type="button" className="toolbar-button" onClick={closeSelectableText}>
                    Close
                  </button>
                </div>
              </div>
              <textarea ref={selectableTextRef} className="copy-sheet-textarea" value={selectableText} readOnly />
              <p className="copy-sheet-hint">Use native touch selection handles here, then copy.</p>
            </section>
          );
        })()}

      {pasteHelperText !== null && (
        <section className="copy-sheet" aria-label="Paste helper">
          <div className="copy-sheet-header">
            <h2>Paste Into Terminal</h2>
            <button type="button" className="toolbar-button" onClick={closePasteHelper}>
              Close
            </button>
          </div>
          <p className="copy-sheet-hint">Long-press in this field, tap Paste, then Send.</p>
          <textarea
            ref={pasteHelperRef}
            className="copy-sheet-textarea"
            value={pasteHelperText}
            onChange={(event) => setPasteHelperText(event.target.value)}
            spellCheck={false}
          />
          <div className="copy-sheet-actions">
            <button
              type="button"
              className="toolbar-button"
              onClick={submitPasteHelperText}
              disabled={pasteHelperText.trim().length === 0}
            >
              Send
            </button>
          </div>
        </section>
      )}

      {processesText !== null && (
        <section className="copy-sheet" aria-label="Processes">
          <div className="copy-sheet-header">
            <h2>Processes</h2>
            <div style={{ display: "flex", gap: "6px" }}>
              <button type="button" className="toolbar-button" onClick={() => void refreshProcesses()}>
                Refresh
              </button>
              <button type="button" className="toolbar-button" onClick={() => setProcessesText(null)}>
                Close
              </button>
            </div>
          </div>
          <p className="copy-sheet-hint">Child processes of the server. Empty after restart = no leaks.</p>
          <textarea className="copy-sheet-textarea" value={processesText} readOnly />
        </section>
      )}
      <Toaster position="top-right" theme="dark" duration={3000} />
    </div>
  );
}

export default App;
