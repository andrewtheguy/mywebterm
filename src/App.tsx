import { useCallback, useEffect, useMemo, useState } from "react";

import { loadTtydConfig } from "./config";
import "./index.css";
import { useTtydTerminal } from "./useTtydTerminal";

export function App() {
  const config = useMemo(() => loadTtydConfig(), []);
  const [remoteTitle, setRemoteTitle] = useState<string | null>(null);

  const handleTitleChange = useCallback((title: string) => {
    if (title.trim().length === 0) {
      return;
    }
    setRemoteTitle(title);
  }, []);

  const { containerRef, connectionStatus, statusMessage, reconnect } = useTtydTerminal({
    wsUrl: config.wsUrl,
    onTitleChange: handleTitleChange,
  });

  useEffect(() => {
    document.title = remoteTitle ? `${remoteTitle} | myttyd` : "myttyd";
  }, [remoteTitle]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <h1>myttyd</h1>
          <p>Custom xterm.js frontend for ttyd</p>
        </div>
        <div className="toolbar">
          <span className={`status-pill status-${connectionStatus}`}>{connectionStatus.toUpperCase()}</span>
          <button type="button" className="reconnect-button" onClick={reconnect} disabled={connectionStatus === "connecting"}>
            Reconnect
          </button>
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
      </section>

      <main className="terminal-card">
        <div ref={containerRef} className="terminal-viewport" />
      </main>
    </div>
  );
}

export default App;
