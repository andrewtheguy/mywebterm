import {
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Toaster, toast } from "sonner";
import { loadTtydConfig, type TtydConfig } from "./config";
import type { SoftKeyModifiers } from "./softKeyboard";
import {
  ARROW_SOFT_KEYS,
  buildSoftKeySequence,
  DEFAULT_SOFT_KEY_MODIFIERS,
  DELETE_SOFT_KEY,
  END_SOFT_KEY,
  FUNCTION_SOFT_KEY_ROWS,
  flattenSoftKeyRows,
  HOME_SOFT_KEY,
  INSERT_SOFT_KEY,
  MAIN_SOFT_KEY_ROWS,
  PAGE_DOWN_SOFT_KEY,
  PAGE_UP_SOFT_KEY,
  type SoftKeyDefinition,
  type SoftModifierName,
} from "./softKeyboard";
import { useTtydTerminal } from "./useTtydTerminal";

function softKeyLabel(key: SoftKeyDefinition, shiftActive: boolean): string {
  if (key.kind === "printable" && /^[a-z]$/.test(key.value)) {
    return shiftActive ? key.value.toUpperCase() : key.value;
  }
  return key.label;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Copy failed.";
}

export function App() {
  const [config, setConfig] = useState<TtydConfig | null>(null);
  const [remoteTitle, setRemoteTitle] = useState<string | null>(null);
  const [selectableText, setSelectableText] = useState<string | null>(null);
  const [pasteHelperText, setPasteHelperText] = useState<string | null>(null);
  const [extraKeysOpen, setExtraKeysOpen] = useState(false);
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
    softKeyboardActive,
    reconnect,
    focusSoftKeyboard,
    sendSoftKeySequence,
    blurTerminalInput,
    suppressMobileKeyboard,
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
    containerElement,
    verticalScrollSyncRef,
    getVerticalScrollState,
  } = useTtydTerminal({
    wsUrl: config?.wsUrl,
    onTitleChange: handleTitleChange,
    experimentalHScroll: config?.experimentalHScroll,
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

  useEffect(() => {
    document.title = remoteTitle ? `${remoteTitle} | MyWebTerm` : "MyWebTerm";
  }, [remoteTitle]);

  useEffect(() => {
    if (!selectableTextRef.current || selectableText === null) {
      return;
    }

    selectableTextRef.current.focus();
    selectableTextRef.current.setSelectionRange(0, selectableText.length);
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
    suppressMobileKeyboard(extraKeysOpen);

    if (extraKeysOpen) {
      return;
    }

    setSoftKeyModifiers({
      ...DEFAULT_SOFT_KEY_MODIFIERS,
    });

    if (repeatTimerRef.current !== null) {
      window.clearTimeout(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
    if (repeatIntervalRef.current !== null) {
      window.clearInterval(repeatIntervalRef.current);
      repeatIntervalRef.current = null;
    }
    repeatModifiersRef.current = null;
  }, [extraKeysOpen, suppressMobileKeyboard]);

  const openSelectableText = useCallback(() => {
    const text = getSelectableText();
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

  const handleCopySelection = useCallback(async (): Promise<boolean> => {
    try {
      await copySelection();
      toast.success("Selection copied.", { id: "copy" });
      return true;
    } catch (error) {
      toast.error(toErrorMessage(error), { id: "copy" });
      return false;
    }
  }, [copySelection]);

  const handleCopyRecentOutput = useCallback(async () => {
    try {
      await copyRecentOutput();
      toast.success("Recent output copied.", { id: "copy" });
    } catch (error) {
      toast.error(toErrorMessage(error), { id: "copy" });
    }
  }, [copyRecentOutput]);

  const handleToolbarPaste = useCallback(async () => {
    const result = await attemptPasteFromClipboard();
    if (result === "pasted") {
      toast.success("Pasted from clipboard.", { id: "paste" });
    } else if (result === "fallback-required") {
      openPasteHelper();
    } else if (result === "empty") {
      toast.error("Clipboard is empty.", { id: "paste" });
    } else if (result === "wrong-mode") {
      toast.error("Switch to Mode: Native to paste.", { id: "paste" });
    } else if (result === "terminal-unavailable") {
      toast.error("Terminal not ready.", { id: "paste" });
    }
  }, [attemptPasteFromClipboard, openPasteHelper]);

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

  const handleMobileCopySelection = useCallback(async () => {
    const copied = await handleCopySelection();
    if (copied) {
      clearMobileSelection();
      return;
    }
    setActiveHandle(null);
  }, [clearMobileSelection, handleCopySelection, setActiveHandle]);

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
            MyWebTerm
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
          <div className="toolbar-actions">
            {isMobile && (
              <button
                type="button"
                className={`toolbar-button ${softKeyboardActive ? "toolbar-button-active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onTouchStart={(e) => e.preventDefault()}
                onClick={() => {
                  setExtraKeysOpen(false);
                  suppressMobileKeyboard(false);
                  focusSoftKeyboard();
                }}
                aria-pressed={softKeyboardActive}
              >
                {softKeyboardActive ? "Hide KB" : "Keyboard"}
              </button>
            )}
            <button
              type="button"
              className={`toolbar-button ${extraKeysOpen ? "toolbar-button-active" : ""}`}
              onClick={() => {
                setExtraKeysOpen((previous) => {
                  const nextOpen = !previous;
                  if (nextOpen) {
                    blurTerminalInput();
                  }
                  return nextOpen;
                });
                setOverflowMenuOpen(false);
              }}
              aria-pressed={extraKeysOpen}
            >
              Extra Keys
            </button>
            <button
              type="button"
              className={`toolbar-button ${mobileMouseMode === "passToTerminal" ? "toolbar-button-active" : ""}`}
              onClick={() => {
                toggleMobileMouseMode();
              }}
              disabled={!mobileSelectionState.enabled}
              aria-pressed={mobileMouseMode === "passToTerminal"}
              title={
                mobileMouseMode === "passToTerminal"
                  ? "Current mode: App. Tap to switch touch scrolling back to Native."
                  : "Current mode: Native. Tap to pass touch scrolling to the App."
              }
            >
              {mobileMouseMode === "passToTerminal" ? "Mode: App" : "Mode: Native"}
            </button>
            <button
              type="button"
              className="toolbar-button"
              onClick={() => void handleToolbarPaste()}
              disabled={mobileMouseMode !== "nativeScroll"}
              title={
                mobileMouseMode === "nativeScroll"
                  ? "Paste from clipboard. If blocked, a helper panel opens for iOS paste."
                  : "Switch to Mode: Native to paste."
              }
            >
              Paste
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
                    <button
                      type="button"
                      className="toolbar-button overflow-menu-item"
                      onClick={() => overflowAction(() => void handleCopySelection())}
                    >
                      Copy Selection
                    </button>
                    <button
                      type="button"
                      className="toolbar-button overflow-menu-item"
                      onClick={() => overflowAction(() => void handleCopyRecentOutput())}
                    >
                      Copy Recent
                    </button>
                    <button
                      type="button"
                      className="toolbar-button overflow-menu-item"
                      onClick={() => overflowAction(openSelectableText)}
                    >
                      Select Text
                    </button>
                    {connectionStatus === "connected" ? (
                      <button
                        type="button"
                        className="toolbar-button overflow-menu-item"
                        onClick={() =>
                          overflowAction(() => {
                            if (window.confirm("Restart terminal session?")) {
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
                  </div>
                )}
              </div>
            ) : (
              <>
                <button type="button" className="toolbar-button" onClick={() => void handleCopySelection()}>
                  Copy Selection
                </button>
                <button type="button" className="toolbar-button" onClick={() => void handleCopyRecentOutput()}>
                  Copy Recent
                </button>
                <button type="button" className="toolbar-button" onClick={openSelectableText}>
                  Select Text
                </button>
                {connectionStatus === "connected" ? (
                  <button
                    type="button"
                    className="toolbar-button"
                    onClick={() => {
                      if (window.confirm("Restart terminal session?")) {
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
              </>
            )}
          </div>
        </div>
      </header>

      <main className="terminal-card">
        <div className="terminal-stage">
          <div
            ref={containerRef}
            className={`terminal-viewport ${mobileMouseMode === "passToTerminal" ? "terminal-viewport-pass-through" : ""} ${horizontalOverflow ? "terminal-viewport-overflow" : ""}`}
          />

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
                  Clear
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

      {extraKeysOpen && (
        <section className="extra-keys-panel" aria-label="Extra key controls">
          <div className="keyboard-layout">
            <div className="keyboard-rows-area">
              <div className="extra-keys-grid" role="group" aria-label="Terminal keys">
                <div className="extra-keys-row extra-keys-function-row">
                  {flattenSoftKeyRows(FUNCTION_SOFT_KEY_ROWS).map((key) => (
                    <button
                      key={key.id}
                      type="button"
                      className="toolbar-button extra-key-button"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        startKeyRepeat(key);
                      }}
                      onPointerUp={stopKeyRepeat}
                      onPointerLeave={stopKeyRepeat}
                      onPointerCancel={stopKeyRepeat}
                    >
                      {key.label}
                    </button>
                  ))}
                </div>
                {MAIN_SOFT_KEY_ROWS.map((row, rowIndex) => (
                  <div key={`main-soft-key-row-${rowIndex + 1}`} className="extra-keys-row">
                    {rowIndex === 2 && <div className="extra-key-spacer extra-key-wide-lg" />}
                    {rowIndex === 3 && (
                      <button
                        type="button"
                        className={`toolbar-button extra-key-button extra-key-wide-xl ${softKeyModifiers.shift ? "toolbar-button-active" : ""}`}
                        onClick={() => toggleSoftModifier("shift")}
                        aria-pressed={softKeyModifiers.shift}
                      >
                        Shift
                      </button>
                    )}
                    {rowIndex === 4 && (
                      <>
                        <button
                          type="button"
                          className={`toolbar-button extra-key-button extra-key-wide-sm ${softKeyModifiers.ctrl ? "toolbar-button-active" : ""}`}
                          onClick={() => toggleSoftModifier("ctrl")}
                          aria-pressed={softKeyModifiers.ctrl}
                        >
                          Ctrl
                        </button>
                        <button
                          type="button"
                          className={`toolbar-button extra-key-button extra-key-wide-sm ${softKeyModifiers.alt ? "toolbar-button-active" : ""}`}
                          onClick={() => toggleSoftModifier("alt")}
                          aria-pressed={softKeyModifiers.alt}
                        >
                          Alt
                        </button>
                        <div className="extra-key-spacer extra-key-wide-sm" />
                      </>
                    )}
                    {row.map((key) => {
                      const wideClass =
                        key.label === "Tab"
                          ? "extra-key-wide-md"
                          : key.label === "Bksp"
                            ? "extra-key-wide-lg"
                            : key.label === "Enter"
                              ? "extra-key-wide-xl"
                              : key.label === "Space"
                                ? "extra-key-button-space"
                                : "";
                      return (
                        <button
                          key={key.id}
                          type="button"
                          className={`toolbar-button extra-key-button ${wideClass}`}
                          onPointerDown={(e) => {
                            e.preventDefault();
                            startKeyRepeat(key);
                          }}
                          onPointerUp={stopKeyRepeat}
                          onPointerLeave={stopKeyRepeat}
                          onPointerCancel={stopKeyRepeat}
                        >
                          {softKeyLabel(key, softKeyModifiers.shift)}
                        </button>
                      );
                    })}
                    {rowIndex === 3 && (
                      <>
                        <div className="extra-key-spacer" style={{ flex: 1 }} />
                        <button
                          type="button"
                          className="toolbar-button extra-key-button extra-key-arrow"
                          onPointerDown={(e) => {
                            e.preventDefault();
                            startKeyRepeat(ARROW_SOFT_KEYS[0]);
                          }}
                          onPointerUp={stopKeyRepeat}
                          onPointerLeave={stopKeyRepeat}
                          onPointerCancel={stopKeyRepeat}
                        >
                          {ARROW_SOFT_KEYS[0].label}
                        </button>
                        <div className="extra-key-spacer extra-key-arrow" />
                      </>
                    )}
                    {rowIndex === 4 && (
                      <>
                        <button
                          type="button"
                          className="toolbar-button extra-key-button extra-key-arrow"
                          onPointerDown={(e) => {
                            e.preventDefault();
                            startKeyRepeat(ARROW_SOFT_KEYS[2]);
                          }}
                          onPointerUp={stopKeyRepeat}
                          onPointerLeave={stopKeyRepeat}
                          onPointerCancel={stopKeyRepeat}
                        >
                          {ARROW_SOFT_KEYS[2].label}
                        </button>
                        <button
                          type="button"
                          className="toolbar-button extra-key-button extra-key-arrow"
                          onPointerDown={(e) => {
                            e.preventDefault();
                            startKeyRepeat(ARROW_SOFT_KEYS[1]);
                          }}
                          onPointerUp={stopKeyRepeat}
                          onPointerLeave={stopKeyRepeat}
                          onPointerCancel={stopKeyRepeat}
                        >
                          {ARROW_SOFT_KEYS[1].label}
                        </button>
                        <button
                          type="button"
                          className="toolbar-button extra-key-button extra-key-arrow"
                          onPointerDown={(e) => {
                            e.preventDefault();
                            startKeyRepeat(ARROW_SOFT_KEYS[3]);
                          }}
                          onPointerUp={stopKeyRepeat}
                          onPointerLeave={stopKeyRepeat}
                          onPointerCancel={stopKeyRepeat}
                        >
                          {ARROW_SOFT_KEYS[3].label}
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="keyboard-right-area">
              <div className="extra-keys-grid" role="group" aria-label="Navigation keys">
                <div className="extra-keys-row">
                  <button
                    type="button"
                    className="toolbar-button extra-key-button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startKeyRepeat(INSERT_SOFT_KEY);
                    }}
                    onPointerUp={stopKeyRepeat}
                    onPointerLeave={stopKeyRepeat}
                    onPointerCancel={stopKeyRepeat}
                  >
                    {INSERT_SOFT_KEY.label}
                  </button>
                </div>
                <div className="extra-keys-row">
                  <button
                    type="button"
                    className="toolbar-button extra-key-button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startKeyRepeat(DELETE_SOFT_KEY);
                    }}
                    onPointerUp={stopKeyRepeat}
                    onPointerLeave={stopKeyRepeat}
                    onPointerCancel={stopKeyRepeat}
                  >
                    {DELETE_SOFT_KEY.label}
                  </button>
                </div>
                <div className="extra-keys-row">
                  <button
                    type="button"
                    className="toolbar-button extra-key-button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startKeyRepeat(HOME_SOFT_KEY);
                    }}
                    onPointerUp={stopKeyRepeat}
                    onPointerLeave={stopKeyRepeat}
                    onPointerCancel={stopKeyRepeat}
                  >
                    {HOME_SOFT_KEY.label}
                  </button>
                </div>
                <div className="extra-keys-row">
                  <button
                    type="button"
                    className="toolbar-button extra-key-button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startKeyRepeat(END_SOFT_KEY);
                    }}
                    onPointerUp={stopKeyRepeat}
                    onPointerLeave={stopKeyRepeat}
                    onPointerCancel={stopKeyRepeat}
                  >
                    {END_SOFT_KEY.label}
                  </button>
                </div>
                <div className="extra-keys-row">
                  <button
                    type="button"
                    className="toolbar-button extra-key-button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startKeyRepeat(PAGE_UP_SOFT_KEY);
                    }}
                    onPointerUp={stopKeyRepeat}
                    onPointerLeave={stopKeyRepeat}
                    onPointerCancel={stopKeyRepeat}
                  >
                    {PAGE_UP_SOFT_KEY.label}
                  </button>
                </div>
                <div className="extra-keys-row">
                  <button
                    type="button"
                    className="toolbar-button extra-key-button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startKeyRepeat(PAGE_DOWN_SOFT_KEY);
                    }}
                    onPointerUp={stopKeyRepeat}
                    onPointerLeave={stopKeyRepeat}
                    onPointerCancel={stopKeyRepeat}
                  >
                    {PAGE_DOWN_SOFT_KEY.label}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {selectableText !== null && (
        <section className="copy-sheet" aria-label="Selectable terminal text">
          <div className="copy-sheet-header">
            <h2>Select And Copy</h2>
            <button type="button" className="toolbar-button" onClick={closeSelectableText}>
              Close
            </button>
          </div>
          <p className="copy-sheet-hint">Use native touch selection handles here, then copy.</p>
          <textarea ref={selectableTextRef} className="copy-sheet-textarea" value={selectableText} readOnly />
        </section>
      )}

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
      <Toaster position="top-right" theme="dark" duration={3000} />
    </div>
  );
}

export default App;
