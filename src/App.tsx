import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { DEFAULT_APP_TITLE, loadTtyConfig, type TtyConfig } from "./config";
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
import { useTerminal } from "./useTerminal";

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

const OVERLAY_ARROW_UP: SoftKeyDefinition = {
  id: "overlay-arrow-up",
  label: "▲",
  kind: "special",
  special: "arrowUp",
  group: "main",
};

const OVERLAY_ARROW_LEFT: SoftKeyDefinition = {
  id: "overlay-arrow-left",
  label: "◀",
  kind: "special",
  special: "arrowLeft",
  group: "main",
};

const OVERLAY_ARROW_DOWN: SoftKeyDefinition = {
  id: "overlay-arrow-down",
  label: "▼",
  kind: "special",
  special: "arrowDown",
  group: "main",
};

const OVERLAY_ARROW_RIGHT: SoftKeyDefinition = {
  id: "overlay-arrow-right",
  label: "▶",
  kind: "special",
  special: "arrowRight",
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
  const [config, setConfig] = useState<TtyConfig | null>(null);
  const [remoteTitle, setRemoteTitle] = useState<string | null>(null);
  const [selectableText, setSelectableText] = useState<string | null>(null);
  const [pasteHelperText, setPasteHelperText] = useState<string | null>(null);
  const [pendingClipboardText, setPendingClipboardText] = useState<string | null>(null);
  const [clipboardSeq, setClipboardSeq] = useState(0);
  const [processesText, setProcessesText] = useState<string | null>(null);
  const [softKeysOpen, setSoftKeysOpen] = useState(false);
  const [keyboardScreen, setKeyboardScreen] = useState<SoftKeyboardScreen>("primary");
  const [softKeyModifiers, setSoftKeyModifiers] = useState(() => ({
    ...DEFAULT_SOFT_KEY_MODIFIERS,
  }));
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const [fontSize, setFontSize] = useState<number | undefined>(undefined);
  const [fontSizeMenuOpen, setFontSizeMenuOpen] = useState(false);
  const [infoDialogOpen, setInfoDialogOpen] = useState(false);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const selectableTextRef = useRef<HTMLTextAreaElement | null>(null);
  const pasteHelperRef = useRef<HTMLTextAreaElement | null>(null);
  const pasteHelperFocusedRef = useRef(false);

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
    loadTtyConfig()
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

  const handleClipboardFallback = useCallback((text: string) => {
    setPendingClipboardText(text);
    setClipboardSeq((s) => s + 1);
  }, []);

  const handleClipboardCopy = useCallback((text: string) => {
    setPendingClipboardText(text);
    setClipboardSeq((s) => s + 1);
  }, []);

  const {
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
    containerElement,
  } = useTerminal({
    wsUrl: config?.wsUrl,
    onTitleChange: handleTitleChange,
    onClipboardFallback: handleClipboardFallback,
    onClipboardCopy: handleClipboardCopy,
    hscroll: config?.hscroll,
    fontSize,
  });

  const appShellRef = useRef<HTMLDivElement>(null);
  const scrollbarTrackRef = useRef<HTMLDivElement>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement>(null);
  const scrollbarDraggingRef = useRef(false);
  const scrollbarDragStartXRef = useRef(0);
  const scrollbarDragStartScrollLeftRef = useRef(0);
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

    const syncScrollToBottom = () => {
      const current = selectableTextRef.current;
      if (current) {
        current.scrollTop = current.scrollHeight;
      }
    };

    // Double rAF + setTimeout to ensure the browser has fully laid out the content.
    let outerRafId: number | null = null;
    let innerRafId: number | null = null;
    outerRafId = requestAnimationFrame(() => {
      innerRafId = requestAnimationFrame(syncScrollToBottom);
    });
    const timerId = setTimeout(() => {
      syncScrollToBottom();
    }, 100);
    return () => {
      if (outerRafId !== null) {
        cancelAnimationFrame(outerRafId);
      }
      if (innerRafId !== null) {
        cancelAnimationFrame(innerRafId);
      }
      clearTimeout(timerId);
    };
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
    setPendingClipboardText(null);
  }, []);

  const openPendingClipboard = useCallback(() => {
    if (!pendingClipboardText) return;
    setPasteHelperText(null);
    setSelectableText(pendingClipboardText);
    setPendingClipboardText(null);
  }, [pendingClipboardText]);

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

  return (
    <div className="app-shell" ref={appShellRef}>
      <header className="topbar">
        <div className="brand">
          <h1>
            <span className="brand-title">{appTitle}</span>
            <button type="button" className="info-button" onClick={() => setInfoDialogOpen(true)} aria-label="Info">
              i
            </button>
            {(() => {
              const statusLabel =
                connectionStatus === "connected"
                  ? "Connected"
                  : connectionStatus === "connecting"
                    ? "Connecting"
                    : connectionStatus === "error"
                      ? "Error"
                      : "Disconnected";
              return (
                <>
                  <span className={`status-dot status-dot-${connectionStatus} touch-only`} aria-hidden="true" />
                  <span
                    className={`status-badge status-${connectionStatus} pointer-only`}
                    role="status"
                    aria-label={statusLabel}
                  >
                    {connectionStatus === "connecting" ? "..." : connectionStatus}
                  </span>
                </>
              );
            })()}
            {pendingClipboardText === null ? (
              <span className="status-badge clipboard-pending-badge clipboard-idle" style={{ visibility: "hidden" }}>
                <span className="btn-icon">📋</span>
                <span className="btn-label">Clipboard</span>
              </span>
            ) : (
              <button
                key={clipboardSeq}
                type="button"
                className="status-badge clipboard-pending-badge"
                onClick={openPendingClipboard}
              >
                <span className="btn-icon">📋</span>
                <span className="btn-label">Clipboard</span>
              </button>
            )}
          </h1>
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
              <svg
                className="btn-icon"
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01" />
                <path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01" />
                <path d="M8 16h8" />
              </svg>
              <span className="btn-label">Soft Keys</span>
            </button>
            <button
              type="button"
              className="toolbar-button"
              onClick={() => void openSelectableText()}
              title="Copy Text"
            >
              <svg
                className="btn-icon"
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span className="btn-label">Copy Text</span>
            </button>
            <button
              type="button"
              className="toolbar-button"
              onClick={() => void handleToolbarPaste()}
              title="Paste from clipboard. If blocked, a helper panel opens for iOS paste."
            >
              <svg
                className="btn-icon"
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                <rect x="8" y="2" width="8" height="4" rx="1" />
                <path d="M12 11v6" />
                <path d="M9 14l3-3 3 3" />
              </svg>
              <span className="btn-label">Paste Text</span>
            </button>
            <div className="overflow-menu touch-only" ref={overflowMenuRef}>
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
                  <button
                    type="button"
                    className={`toolbar-button overflow-menu-item ${sysKeyActive ? "toolbar-button-active" : ""}`}
                    onClick={() =>
                      overflowAction(() => {
                        setSoftKeysOpen(false);
                        focusSysKeyboard();
                      })
                    }
                  >
                    Sys Keys
                  </button>
                  {connectionStatus === "connected" ? (
                    <button
                      type="button"
                      className="toolbar-button overflow-menu-item"
                      onClick={() =>
                        overflowAction(() => {
                          if (window.confirm("Restart terminal session?")) {
                            setProcessesText(null);
                            restart();
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
                  <button
                    type="button"
                    className="toolbar-button overflow-menu-item"
                    onClick={() => overflowAction(() => setFontSizeMenuOpen(true))}
                  >
                    Font Size: {fontSize ?? "Auto"}
                  </button>
                </div>
              )}
            </div>
            {connectionStatus === "connected" ? (
              <button
                type="button"
                className="toolbar-button pointer-only"
                onClick={() => {
                  if (window.confirm("Restart terminal session?")) {
                    setProcessesText(null);
                    restart();
                  }
                }}
              >
                Restart
              </button>
            ) : (
              <button
                type="button"
                className="toolbar-button reconnect-button pointer-only"
                onClick={reconnect}
                disabled={connectionStatus === "connecting"}
              >
                Reconnect
              </button>
            )}
            <button type="button" className="toolbar-button pointer-only" onClick={() => void inspectProcesses()}>
              Processes
            </button>
            <button
              type="button"
              className={`toolbar-button pointer-only ${fontSizeMenuOpen ? "toolbar-button-active" : ""}`}
              onClick={() => setFontSizeMenuOpen((prev) => !prev)}
            >
              Font Size: {fontSize ?? "Auto"}
            </button>
          </div>
        </div>
      </header>

      <main className="terminal-card">
        <div className="terminal-stage">
          <div
            ref={containerRef}
            className={`terminal-viewport ${horizontalOverflow ? "terminal-viewport-overflow" : ""}`}
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

          <div className="arrow-overlay" role="group" aria-label="Arrow controls">
            <div className="arrow-overlay-grid">
              <div className="arrow-overlay-spacer" />
              <button
                type="button"
                className="toolbar-button arrow-overlay-button"
                aria-label="Arrow Up"
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  startKeyRepeat(OVERLAY_ARROW_UP);
                }}
                onPointerUp={stopKeyRepeat}
                onPointerLeave={stopKeyRepeat}
                onPointerCancel={stopKeyRepeat}
              >
                ▲
              </button>
              <div className="arrow-overlay-spacer" />
              <button
                type="button"
                className="toolbar-button arrow-overlay-button"
                aria-label="Arrow Left"
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  startKeyRepeat(OVERLAY_ARROW_LEFT);
                }}
                onPointerUp={stopKeyRepeat}
                onPointerLeave={stopKeyRepeat}
                onPointerCancel={stopKeyRepeat}
              >
                ◀
              </button>
              <button
                type="button"
                className="toolbar-button arrow-overlay-button"
                aria-label="Arrow Down"
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  startKeyRepeat(OVERLAY_ARROW_DOWN);
                }}
                onPointerUp={stopKeyRepeat}
                onPointerLeave={stopKeyRepeat}
                onPointerCancel={stopKeyRepeat}
              >
                ▼
              </button>
              <button
                type="button"
                className="toolbar-button arrow-overlay-button"
                aria-label="Arrow Right"
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  startKeyRepeat(OVERLAY_ARROW_RIGHT);
                }}
                onPointerUp={stopKeyRepeat}
                onPointerLeave={stopKeyRepeat}
                onPointerCancel={stopKeyRepeat}
              >
                ▶
              </button>
            </div>
          </div>
        </div>
      </main>

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
                  Select Text To Copy ({lineCount} line{lineCount === 1 ? "" : "s"})
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
                          setPendingClipboardText(selectableText);
                          setClipboardSeq((s) => s + 1);
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
              <textarea
                ref={selectableTextRef}
                className="copy-sheet-textarea"
                value={selectableText}
                readOnly
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                inputMode="none"
              />
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
      {infoDialogOpen && (
        <dialog
          className="font-size-dialog-backdrop"
          open
          onClick={(e) => {
            if (e.target === e.currentTarget) setInfoDialogOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setInfoDialogOpen(false);
          }}
        >
          <div className="info-dialog">
            <p className="info-dialog-title">{appTitle}</p>
            <p className="info-tagline">
              Web terminal powered by {appTitle === DEFAULT_APP_TITLE ? "Bun PTY" : DEFAULT_APP_TITLE}
            </p>
            <div className="info-details">
              <div className="info-detail-row">
                <span className="info-detail-label">Status</span>
                <span className="info-detail-value">
                  <span className={`info-status-indicator status-${connectionStatus}`} />
                  {connectionStatus}
                </span>
              </div>
              <div className="info-detail-row">
                <span className="info-detail-label">WebSocket</span>
                <span className="info-detail-value info-detail-mono">{config?.wsUrl ?? "—"}</span>
              </div>
            </div>
            <button type="button" className="toolbar-button" onClick={() => setInfoDialogOpen(false)}>
              Close
            </button>
          </div>
        </dialog>
      )}
      {fontSizeMenuOpen && (
        <dialog
          className="font-size-dialog-backdrop"
          open
          onClick={(e) => {
            if (e.target === e.currentTarget) setFontSizeMenuOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setFontSizeMenuOpen(false);
          }}
        >
          <div className="font-size-dialog">
            <p className="font-size-dialog-label">Font Size</p>
            <div className="font-size-dialog-options">
              <button
                type="button"
                className={`toolbar-button font-size-option ${fontSize === undefined ? "toolbar-button-active" : ""}`}
                onClick={() => {
                  setFontSize(undefined);
                  setFontSizeMenuOpen(false);
                }}
              >
                Auto
              </button>
              {[10, 12, 14, 16].map((size) => (
                <button
                  key={size}
                  type="button"
                  className={`toolbar-button font-size-option ${fontSize === size ? "toolbar-button-active" : ""}`}
                  onClick={() => {
                    setFontSize(size);
                    setFontSizeMenuOpen(false);
                  }}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
        </dialog>
      )}
      <Toaster position="top-right" theme="dark" duration={3000} />
    </div>
  );
}

export default App;
