const encoder = new TextEncoder();

export const ClientCommand = {
  INPUT: "0",
  RESIZE_TERMINAL: "1",
} as const;

export const ServerCommand = {
  OUTPUT: "0",
  SET_WINDOW_TITLE: "1",
  SET_PREFERENCES: "2",
} as const;

export interface DecodedFrame {
  command: string;
  payload: Uint8Array;
}

// --- Control messages (JSON text frames) ---

export type ClientControlMessage =
  | { type: "handshake"; columns: number; rows: number }
  | { type: "reconnect"; sessionId: string; columns: number; rows: number }
  | { type: "pong"; timestamp: number };

export type ServerControlMessage =
  | { type: "session_info"; sessionId: string }
  | { type: "ping"; timestamp: number }
  | { type: "session_ended"; exitCode: number | null; signal: string | null }
  | { type: "error"; message: string };

export function parseClientControl(text: string): ClientControlMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    return null;
  }

  const msg = parsed as Record<string, unknown>;
  switch (msg.type) {
    case "handshake":
      if (typeof msg.columns === "number" && typeof msg.rows === "number") {
        return { type: "handshake", columns: msg.columns, rows: msg.rows };
      }
      return null;
    case "reconnect":
      if (typeof msg.sessionId === "string" && typeof msg.columns === "number" && typeof msg.rows === "number") {
        return { type: "reconnect", sessionId: msg.sessionId, columns: msg.columns, rows: msg.rows };
      }
      return null;
    case "pong":
      if (typeof msg.timestamp === "number") {
        return { type: "pong", timestamp: msg.timestamp };
      }
      return null;
    default:
      return null;
  }
}

export function encodeServerControl(msg: ServerControlMessage): string {
  return JSON.stringify(msg);
}

function encodePrefixedPayload(command: string, payload: Uint8Array): Uint8Array {
  const prefixed = new Uint8Array(payload.length + 1);
  prefixed[0] = command.charCodeAt(0);
  prefixed.set(payload, 1);
  return prefixed;
}

function normalizeHandshakeDimension(name: "columns" | "rows", value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Invalid ${name}: expected a finite number, got ${value}.`);
  }

  if (value <= 0) {
    throw new TypeError(`Invalid ${name}: expected a positive number, got ${value}.`);
  }

  return Math.max(1, Math.floor(value));
}

export function buildHandshake(columns: number, rows: number): string {
  // Contract: ttyd handshake dimensions must be finite, positive integers.
  const normalizedColumns = normalizeHandshakeDimension("columns", columns);
  const normalizedRows = normalizeHandshakeDimension("rows", rows);
  return JSON.stringify({ columns: normalizedColumns, rows: normalizedRows });
}

export function encodeInput(data: string | Uint8Array): Uint8Array {
  const payload = typeof data === "string" ? encoder.encode(data) : data;
  return encodePrefixedPayload(ClientCommand.INPUT, payload);
}

export function encodeResize(columns: number, rows: number): Uint8Array {
  const payload = encoder.encode(JSON.stringify({ columns, rows }));
  return encodePrefixedPayload(ClientCommand.RESIZE_TERMINAL, payload);
}

export function decodeFrame(arrayBuffer: ArrayBuffer): DecodedFrame {
  const payload = new Uint8Array(arrayBuffer);
  if (payload.length === 0) {
    throw new Error("Cannot decode an empty ttyd frame.");
  }

  return {
    command: String.fromCharCode(payload[0] as number),
    payload: payload.slice(1),
  };
}
