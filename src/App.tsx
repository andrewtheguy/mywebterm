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
import { useTtydTerminal } from "./useTtydTerminal";

type CopyFeedback =
  | { tone: "success"; message: string }
  | { tone: "error"; message: string };

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Copy failed.";
}

export function App() {
  const config = useMemo(() => loadTtydConfig(), []);
  const [remoteTitle, setRemoteTitle] = useState<string | null>(null);
  const [selectableText, setSelectableText] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback | null>(null);
  const selectableTextRef = useRef<HTMLTextAreaElement | null>(null);

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
    copySelection,
    copyRecentOutput,
    getSelectableText,
    mobileSelectionState,
    mobileMouseMode,
    clearMobileSelection,
    setActiveHandle,
    updateActiveHandleFromClientPoint,
    toggleMobileMouseMode,
  } = useTtydTerminal({
    wsUrl: config.wsUrl,
    onTitleChange: handleTitleChange,
  });

  useEffect(() => {
    document.title = remoteTitle ? `${remoteTitle} | myttyd` : "myttyd";
  }, [remoteTitle]);

  useEffect(() => {
    if (!selectableTextRef.current || selectableText === null) {
      return;
    }

    selectableTextRef.current.focus();
    selectableTextRef.current.setSelectionRange(0, selectableText.length);
  }, [selectableText]);

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

  const openSelectableText = useCallback(() => {
    const text = getSelectableText();
    if (text.length === 0) {
      return;
    }
    setSelectableText(text);
  }, [getSelectableText]);

  const closeSelectableText = useCallback(() => {
    setSelectableText(null);
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

  const hasMobileSelectionOverlay =
    mobileSelectionState.enabled &&
    mobileSelectionState.range !== null &&
    mobileSelectionState.startHandle !== null &&
    mobileSelectionState.endHandle !== null &&
    mobileSelectionState.toolbarAnchor !== null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <h1>myttyd</h1>
          <p>Custom xterm.js frontend for ttyd</p>
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
      </header>

      <section className="endpoint-card">
        <div className="endpoint-row">
          <span>ttyd HTTP</span>
          <code>{config.baseUrl}</code>
        </div>
        <div className="endpoint-row">
          <span>ttyd WS</span>
          <code>{config.wsUrl}</code>
        </div>
        <p className="status-message">{statusMessage}</p>
        {copyFeedback !== null && (
          <p className={`copy-feedback copy-feedback-${copyFeedback.tone}`} role="status" aria-live="polite">
            {copyFeedback.message}
          </p>
        )}
      </section>

      <main className="terminal-card">
        <div className="terminal-stage">
          <div
            ref={containerRef}
            className={`terminal-viewport ${mobileMouseMode === "passToTerminal" ? "terminal-viewport-pass-through" : ""}`}
          />

          {hasMobileSelectionOverlay && (
            <div className="mobile-selection-overlay">
              <button
                type="button"
                className="mobile-selection-handle mobile-selection-handle-start"
                style={{
                  left: `${mobileSelectionState.startHandle.left}px`,
                  top: `${mobileSelectionState.startHandle.top}px`,
                }}
                onPointerDown={event => beginSelectionHandleDrag("start", event)}
                onPointerMove={handleSelectionHandleMove}
                onPointerUp={finishSelectionHandleDrag}
                onPointerCancel={finishSelectionHandleDrag}
                onLostPointerCapture={finishSelectionHandleDrag}
                onTouchStart={event => beginSelectionHandleTouch("start", event)}
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
                  left: `${mobileSelectionState.endHandle.left}px`,
                  top: `${mobileSelectionState.endHandle.top}px`,
                }}
                onPointerDown={event => beginSelectionHandleDrag("end", event)}
                onPointerMove={handleSelectionHandleMove}
                onPointerUp={finishSelectionHandleDrag}
                onPointerCancel={finishSelectionHandleDrag}
                onLostPointerCapture={finishSelectionHandleDrag}
                onTouchStart={event => beginSelectionHandleTouch("end", event)}
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
                  left: `${mobileSelectionState.toolbarAnchor.left}px`,
                  top: `${mobileSelectionState.toolbarAnchor.top}px`,
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

      {selectableText !== null && (
        <section className="copy-sheet" aria-label="Selectable terminal text">
          <div className="copy-sheet-header">
            <h2>Select And Copy</h2>
            <button type="button" className="toolbar-button" onClick={closeSelectableText}>
              Close
            </button>
          </div>
          <p className="copy-sheet-hint">Use native touch selection handles here, then copy.</p>
          <textarea
            ref={selectableTextRef}
            className="copy-sheet-textarea"
            value={selectableText}
            readOnly
          />
        </section>
      )}
    </div>
  );
}

export default App;
