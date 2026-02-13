import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

  const { containerRef, connectionStatus, statusMessage, reconnect, focusSoftKeyboard, copySelection, copyRecentOutput, getSelectableText } = useTtydTerminal({
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

  const handleCopySelection = useCallback(async () => {
    try {
      await copySelection();
      setCopyFeedback({
        tone: "success",
        message: "Selection copied.",
      });
    } catch (error) {
      setCopyFeedback({
        tone: "error",
        message: toErrorMessage(error),
      });
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
        <div ref={containerRef} className="terminal-viewport" />
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
