import { type ReactNode, useEffect, useState } from "react";
import type { ConnectionStatus, DisconnectInfo } from "./useTerminal";

// What the server reports about one PTY session (GET /api/sessions/:id).
export interface SessionSummary {
  sessionId: string;
  state: "spawning" | "attached" | "detached" | "dead";
  target: string | null;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number | null;
}

type CardTone = "ok" | "busy" | "warn" | "danger";

// A connection normally completes within a moment, so a way out is offered
// only once it clearly has not: a button flashing past would just be noise.
const CANCEL_CONNECT_AFTER_MS = 2500;

function focusOnMount(el: HTMLElement | null) {
  el?.focus();
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

function describeExit(info: Extract<DisconnectInfo, { kind: "exited" }>): string {
  if (info.signal !== null) return `was terminated (${info.signal})`;
  if (info.exitCode === null || info.exitCode === 0) return "exited";
  return `exited with code ${info.exitCode}`;
}

function RetryCountdown({ retryAt }: { retryAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  return <>Retrying in {Math.max(1, Math.ceil((retryAt - now) / 1000))}s…</>;
}

interface SessionCardProps {
  tone: CardTone;
  title: string;
  // Keep the terminal readable behind the card (its last output explains
  // why the session ended).
  dimLess?: boolean;
  // Something is in progress: pulse the title.
  pulse?: boolean;
  children?: ReactNode;
  actions?: ReactNode;
}

function SessionCard({ tone, title, dimLess, pulse, children, actions }: SessionCardProps) {
  return (
    <div className={`disconnect-overlay start-overlay-static ${dimLess ? "disconnect-overlay-readable" : ""}`}>
      <div
        className={`disconnect-overlay-text session-card session-card-${tone} ${pulse ? "session-card-pulse" : ""}`}
        role="status"
      >
        <span className="session-card-title">{title}</span>
        {children}
        {actions ? <div className="session-card-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

interface ResumeCardProps {
  // Null until the server has answered (or when it cannot be reached).
  session: SessionSummary | null;
  // Fallback label from what this tab remembers about its session.
  targetLabel: string;
  onResume: () => void;
  onRequestEnd: () => void;
}

// Start screen for a tab that still has a session running on the server.
export function ResumeCard({ session, targetLabel, onResume, onRequestEnd }: ResumeCardProps) {
  const now = Date.now();
  const facts: string[] = [];
  if (session) {
    facts.push(`started ${formatDuration(now - session.createdAt)} ago`);
    if (session.expiresAt !== null) {
      facts.push(`kept for ${formatDuration(Math.max(0, session.expiresAt - now))} more`);
    }
  }

  return (
    <SessionCard
      tone="busy"
      title="Session still running"
      actions={
        <>
          <button
            type="button"
            className="toolbar-button toolbar-button-primary session-card-button"
            ref={focusOnMount}
            onClick={onResume}
          >
            Resume
          </button>
          <button
            type="button"
            className="toolbar-button toolbar-button-danger session-card-button"
            onClick={onRequestEnd}
          >
            End Session
          </button>
        </>
      }
    >
      <code className="session-card-target">{targetLabel}</code>
      {facts.length > 0 ? <span className="session-card-detail">{facts.join(" · ")}</span> : null}
      {session?.state === "attached" ? (
        <span className="session-card-detail">Open in another tab or device — resuming here takes it over.</span>
      ) : null}
    </SessionCard>
  );
}

function ConnectingCard({ targetLabel, onCancel }: { targetLabel: string; onCancel: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), CANCEL_CONNECT_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <SessionCard
      tone="busy"
      title="Connecting…"
      pulse
      actions={
        slow ? (
          <button type="button" className="toolbar-button session-card-button" onClick={onCancel}>
            Cancel
          </button>
        ) : undefined
      }
    >
      <code className="session-card-target">{targetLabel}</code>
    </SessionCard>
  );
}

interface SessionOverlayProps {
  connectionStatus: ConnectionStatus;
  disconnectInfo: DisconnectInfo | null;
  // "ssh user@host" or the local shell command
  targetLabel: string;
  onReconnect: () => void;
  // Back to the start screen, leaving the server session alone.
  onLeave: () => void;
  // Ask to kill the session (opens the confirmation dialog).
  onRequestEnd: () => void;
  // Give up on a connection attempt that is taking too long.
  onCancelConnect: () => void;
}

// Covers the terminal whenever a started session is not connected, naming
// what happened and offering the actions that make sense for that state.
export function SessionOverlay({
  connectionStatus,
  disconnectInfo,
  targetLabel,
  onReconnect,
  onLeave,
  onRequestEnd,
  onCancelConnect,
}: SessionOverlayProps) {
  if (connectionStatus === "connected") return null;

  const primary = (label: string) => (
    <button
      type="button"
      className="toolbar-button toolbar-button-primary session-card-button"
      ref={focusOnMount}
      onClick={onReconnect}
    >
      {label}
    </button>
  );
  const backToStart = (
    <button type="button" className="toolbar-button session-card-button" onClick={onLeave}>
      Back to Start
    </button>
  );

  switch (disconnectInfo?.kind) {
    case "lost":
      return (
        <SessionCard
          key="lost"
          tone="warn"
          title="Connection lost"
          actions={
            <>
              {primary("Retry Now")}
              <button
                type="button"
                className="toolbar-button toolbar-button-danger session-card-button"
                onClick={onRequestEnd}
              >
                End Session
              </button>
            </>
          }
        >
          <span className="session-card-detail">
            {disconnectInfo.retryAt === null ? "Reconnecting…" : <RetryCountdown retryAt={disconnectInfo.retryAt} />}
          </span>
          <span className="session-card-detail">The session keeps running on the server for a few minutes.</span>
        </SessionCard>
      );

    case "exited": {
      const clean = disconnectInfo.signal === null && (disconnectInfo.exitCode ?? 0) === 0;
      return (
        <SessionCard
          key="exited"
          tone={clean ? "ok" : "danger"}
          title="Session ended"
          dimLess
          actions={
            <>
              {primary("Start Again")}
              {backToStart}
            </>
          }
        >
          <span className="session-card-detail">
            <code className="session-card-target">{targetLabel}</code> {describeExit(disconnectInfo)}
          </span>
        </SessionCard>
      );
    }

    case "replaced":
      return (
        <SessionCard
          key="replaced"
          tone="warn"
          title="Session moved"
          actions={
            <>
              {primary("Use Here")}
              {backToStart}
            </>
          }
        >
          <span className="session-card-detail">
            This session is now open in another tab or device. Taking it back disconnects the other one.
          </span>
        </SessionCard>
      );

    case "failed":
      return (
        <SessionCard
          key="failed"
          tone="danger"
          title="Could not start session"
          dimLess
          actions={
            <>
              {primary("Try Again")}
              {backToStart}
            </>
          }
        >
          <code className="session-card-target">{targetLabel}</code>
          <span className="session-card-detail">{disconnectInfo.message}</span>
        </SessionCard>
      );
  }

  // Nothing to report, so a connection is being made — or is about to be:
  // the status still reads "disconnected" in the moment between choosing a
  // session and the first attempt starting, which is not worth an alarm.
  return <ConnectingCard targetLabel={targetLabel} onCancel={onCancelConnect} />;
}
