import {
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { loadTtydConfig } from "./config";
import "./index.css";
import {
  buildSoftKeySequence,
  DEFAULT_SOFT_KEY_MODIFIERS,
  FUNCTION_SOFT_KEY_ROWS,
  MAIN_SOFT_KEY_ROWS,
  SOFT_MODIFIER_ORDER,
  type SoftKeyDefinition,
  type SoftModifierName,
} from "./softKeyboard";
import { useTtydTerminal } from "./useTtydTerminal";

type CopyFeedback = { tone: "success" | "error"; message: string };

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Copy failed.";
}

function toModifierLabel(modifier: SoftModifierName): string {
  switch (modifier) {
    case "ctrl":
      return "Ctrl";
    case "alt":
      return "Alt";
    case "shift":
      return "Shift";
    default:
      return modifier;
  }
}

export function App() {
  const config = useMemo(() => loadTtydConfig(), []);
  const [remoteTitle, setRemoteTitle] = useState<string | null>(null);
  const [selectableText, setSelectableText] = useState<string | null>(null);
  const [pasteHelperText, setPasteHelperText] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback | null>(null);
  const [extraKeysOpen, setExtraKeysOpen] = useState(false);
  const [functionKeysOpen, setFunctionKeysOpen] = useState(false);
  const [softKeyModifiers, setSoftKeyModifiers] = useState(() => ({
    ...DEFAULT_SOFT_KEY_MODIFIERS,
  }));
  const selectableTextRef = useRef<HTMLTextAreaElement | null>(null);
  const pasteHelperRef = useRef<HTMLTextAreaElement | null>(null);
  const pasteHelperFocusedRef = useRef(false);

  const handleTitleChange = useCallback((title: string) => {
    if (title.trim().length === 0) {
      return;
    }
    setRemoteTitle(title);
  }, []);

  const {
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
    containerElement,
  } = useTtydTerminal({
    wsUrl: config.wsUrl,
    onTitleChange: handleTitleChange,
  });

  const scrollbarTrackRef = useRef<HTMLDivElement>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement>(null);
  const scrollbarDraggingRef = useRef(false);
  const scrollbarDragStartXRef = useRef(0);
  const scrollbarDragStartScrollLeftRef = useRef(0);

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
    if (!copyFeedback) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setCopyFeedback(null);
    }, 2600);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [copyFeedback]);

  useEffect(() => {
    if (extraKeysOpen) {
      return;
    }

    setFunctionKeysOpen(false);
    setSoftKeyModifiers({
      ...DEFAULT_SOFT_KEY_MODIFIERS,
    });
  }, [extraKeysOpen]);

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
      setCopyFeedback({
        tone: "success",
        message: "Selection copied.",
      });
      return true;
    } catch (error) {
      setCopyFeedback({
        tone: "error",
        message: toErrorMessage(error),
      });
      return false;
    }
  }, [copySelection]);

  const handleCopyRecentOutput = useCallback(async () => {
    try {
      await copyRecentOutput();
      setCopyFeedback({
        tone: "success",
        message: "Recent output copied.",
      });
    } catch (error) {
      setCopyFeedback({
        tone: "error",
        message: toErrorMessage(error),
      });
    }
  }, [copyRecentOutput]);

  const handleToolbarPaste = useCallback(async () => {
    const result = await attemptPasteFromClipboard();
    if (result === "fallback-required") {
      openPasteHelper();
    }
  }, [attemptPasteFromClipboard, openPasteHelper]);

  const submitPasteHelperText = useCallback(() => {
    if (pasteHelperText === null) {
      return;
    }
    const pasted = pasteTextIntoTerminal(pasteHelperText);
    if (pasted) {
      closePasteHelper();
    }
  }, [closePasteHelper, pasteHelperText, pasteTextIntoTerminal]);

  const hasActiveSoftModifiers = softKeyModifiers.ctrl || softKeyModifiers.alt || softKeyModifiers.shift;

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

  const handleSoftKeyPress = useCallback(
    (key: SoftKeyDefinition) => {
      const sequence = buildSoftKeySequence(key, softKeyModifiers);
      if (sequence.ok) {
        sendSoftKeySequence(sequence.sequence, sequence.description);
      } else {
        setCopyFeedback({
          tone: "error",
          message: `${sequence.description}: ${sequence.reason}.`,
        });
      }
      clearSoftModifiers();
    },
    [clearSoftModifiers, sendSoftKeySequence, softKeyModifiers],
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
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <h1>MyWebTerm</h1>
          <p>Web terminal powered by Bun PTY</p>
        </div>
        <div className="toolbar">
          <span className={`status-pill status-${connectionStatus}`}>{connectionStatus.toUpperCase()}</span>
          <div className="toolbar-actions">
            <button type="button" className="toolbar-button" onClick={() => void handleCopySelection()}>
              Copy Selection
            </button>
            <button type="button" className="toolbar-button" onClick={() => void handleCopyRecentOutput()}>
              Copy Recent
            </button>
            <button type="button" className="toolbar-button" onClick={focusSoftKeyboard}>
              Keyboard
            </button>
            <button
              type="button"
              className={`toolbar-button ${extraKeysOpen ? "toolbar-button-active" : ""}`}
              onClick={() => setExtraKeysOpen((previous) => !previous)}
              aria-pressed={extraKeysOpen}
            >
              Extra Keys
            </button>
            {mobileSelectionState.enabled && (
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
            )}
            <button
              type="button"
              className="toolbar-button"
              onClick={toggleMobileMouseMode}
              disabled={!mobileSelectionState.enabled}
              title={
                mobileMouseMode === "passToTerminal"
                  ? "Current mode: App. Tap to switch touch scrolling back to Native."
                  : "Current mode: Native. Tap to pass touch scrolling to the App."
              }
            >
              {mobileMouseMode === "passToTerminal" ? "Mode: App" : "Mode: Native"}
            </button>
            <button type="button" className="toolbar-button" onClick={openSelectableText}>
              Select Text
            </button>
            <button
              type="button"
              className="toolbar-button reconnect-button"
              onClick={reconnect}
              disabled={connectionStatus === "connecting"}
            >
              Reconnect
            </button>
          </div>
        </div>
        {extraKeysOpen && (
          <section className="extra-keys-panel" aria-label="Extra key controls">
            <div className="extra-keys-header">
              <p className="extra-keys-hint">Tap modifiers, then key. Modifiers reset after one send.</p>
              <button
                type="button"
                className={`toolbar-button extra-keys-function-toggle ${functionKeysOpen ? "toolbar-button-active" : ""}`}
                onClick={() => setFunctionKeysOpen((previous) => !previous)}
                aria-expanded={functionKeysOpen}
              >
                Function
              </button>
            </div>
            <div className="extra-keys-modifier-row" role="group" aria-label="Modifier keys">
              {SOFT_MODIFIER_ORDER.map((modifier) => (
                <button
                  key={modifier}
                  type="button"
                  className={`toolbar-button extra-key-button ${softKeyModifiers[modifier] ? "toolbar-button-active" : ""}`}
                  onClick={() => toggleSoftModifier(modifier)}
                  aria-pressed={softKeyModifiers[modifier]}
                >
                  {toModifierLabel(modifier)}
                </button>
              ))}
              <button
                type="button"
                className="toolbar-button extra-key-button"
                onClick={clearSoftModifiers}
                disabled={!hasActiveSoftModifiers}
              >
                Clear Mods
              </button>
            </div>
            <div className="extra-keys-grid" role="group" aria-label="Terminal keys">
              {MAIN_SOFT_KEY_ROWS.map((row, rowIndex) => (
                <div key={`main-soft-key-row-${rowIndex + 1}`} className="extra-keys-row">
                  {row.map((key) => (
                    <button
                      key={key.id}
                      type="button"
                      className={`toolbar-button extra-key-button ${key.label === "Space" ? "extra-key-button-space" : ""}`}
                      onClick={() => handleSoftKeyPress(key)}
                    >
                      {key.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            {functionKeysOpen && (
              <div className="extra-keys-grid extra-keys-grid-function" role="group" aria-label="Function keys">
                {FUNCTION_SOFT_KEY_ROWS.map((row, rowIndex) => (
                  <div key={`function-soft-key-row-${rowIndex + 1}`} className="extra-keys-row">
                    {row.map((key) => (
                      <button
                        key={key.id}
                        type="button"
                        className="toolbar-button extra-key-button"
                        onClick={() => handleSoftKeyPress(key)}
                      >
                        {key.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {(statusMessage || copyFeedback !== null) && (
          <div className="topbar-feedback">
            {statusMessage && <p className="status-message">{statusMessage}</p>}
            {copyFeedback !== null && (
              <p className={`copy-feedback copy-feedback-${copyFeedback.tone}`} role="status" aria-live="polite">
                {copyFeedback.message}
              </p>
            )}
          </div>
        )}
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
    </div>
  );
}

export default App;
