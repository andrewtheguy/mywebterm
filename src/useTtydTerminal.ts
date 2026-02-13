import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type IDisposable, type ITerminalOptions } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";

import "@xterm/xterm/css/xterm.css";

import { ServerCommand, buildHandshake, decodeFrame, encodeInput, encodeResize } from "./ttydProtocol";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface UseTtydTerminalOptions {
  wsUrl?: string;
  onTitleChange?: (title: string) => void;
}

interface UseTtydTerminalResult {
  containerRef: (node: HTMLDivElement | null) => void;
  connectionStatus: ConnectionStatus;
  statusMessage: string;
  reconnect: () => void;
  focusSoftKeyboard: () => void;
  copySelection: () => Promise<void>;
  copyRecentOutput: () => Promise<void>;
  getSelectableText: () => string;
}

const terminalOptions: ITerminalOptions = {
  cursorBlink: true,
  convertEol: true,
  scrollback: 5000,
  fontSize: 14,
  fontFamily: "Iosevka Term, JetBrains Mono, Menlo, monospace",
  theme: {
    background: "#041425",
    foreground: "#d8ecff",
    cursor: "#71f1d6",
    selectionBackground: "#17416a",
  },
};

const RECENT_OUTPUT_LINES = 120;

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

export function useTtydTerminal({
  wsUrl,
  onTitleChange,
}: UseTtydTerminalOptions): UseTtydTerminalResult {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [statusMessage, setStatusMessage] = useState("Waiting for terminal.");
  const [reconnectToken, setReconnectToken] = useState(0);

  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const decoderRef = useRef(new TextDecoder());
  const terminalDisposablesRef = useRef<IDisposable[]>([]);
  const onTitleChangeRef = useRef(onTitleChange);
  const connectionEpochRef = useRef(0);

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setContainer(node);
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

  useEffect(() => {
    if (!container) {
      return;
    }

    const terminal = new Terminal(terminalOptions);
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();
    terminal.focus();

    const terminalDisposables: IDisposable[] = [
      terminal.onData(data => {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(encodeInput(data));
        }
      }),
      terminal.onResize(({ cols, rows }) => {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(encodeResize(cols, rows));
        }
      }),
    ];

    const fitThrottleMs = 100;
    let lastFitTime = 0;
    let throttledFitTimeout: ReturnType<typeof window.setTimeout> | undefined;
    const throttledFit = () => {
      const now = Date.now();
      const elapsed = now - lastFitTime;
      if (elapsed >= fitThrottleMs) {
        lastFitTime = now;
        fitAddon.fit();
        return;
      }

      if (throttledFitTimeout !== undefined) {
        return;
      }

      throttledFitTimeout = window.setTimeout(() => {
        throttledFitTimeout = undefined;
        lastFitTime = Date.now();
        fitAddon.fit();
      }, fitThrottleMs - elapsed);
    };

    window.addEventListener("resize", throttledFit);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    terminalDisposablesRef.current = terminalDisposables;

    return () => {
      closeSocket();
      window.removeEventListener("resize", throttledFit);
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
    };
  }, [container, closeSocket]);

  useEffect(() => {
    if (!wsUrl) {
      closeSocket();
      setConnectionStatus("disconnected");
      setStatusMessage("Missing ttyd endpoint configuration.");
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      setConnectionStatus("disconnected");
      setStatusMessage("Initializing terminal.");
      return;
    }

    closeSocket();
    setConnectionStatus("connecting");
    setStatusMessage(`Connecting to ${wsUrl}`);

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
        case ServerCommand.SET_PREFERENCES:
        default:
          break;
      }
    };

    socket.onopen = () => {
      if (!isCurrentConnection()) {
        return;
      }

      fitAddonRef.current?.fit();
      socket.send(buildHandshake(terminal.cols, terminal.rows));
      terminal.focus();
      setConnectionStatus("connected");
      setStatusMessage(`Connected to ${wsUrl}`);
    };

    socket.onmessage = event => {
      if (!isCurrentConnection()) {
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        handleFrame(event.data);
        return;
      }

      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then(arrayBuffer => {
          handleFrame(arrayBuffer);
        }).catch(() => {
          // Ignore malformed binary frames.
        });
        return;
      }

      if (typeof event.data === "string") {
        terminal.write(event.data);
      }
    };

    socket.onerror = () => {
      if (!isCurrentConnection()) {
        return;
      }
      setConnectionStatus("error");
      setStatusMessage("WebSocket error.");
    };

    socket.onclose = event => {
      if (!isCurrentConnection()) {
        return;
      }
      socketRef.current = null;
      setConnectionStatus("disconnected");
      setStatusMessage(`Disconnected (code ${event.code}).`);
    };

    return () => {
      if (connectionEpochRef.current === connectionEpoch) {
        connectionEpochRef.current += 1;
      }
      if (socket === socketRef.current) {
        closeSocket();
      }
    };
  }, [wsUrl, reconnectToken, closeSocket, container]);

  const reconnect = useCallback(() => {
    if (!wsUrl) {
      return;
    }
    closeSocket();
    setReconnectToken(previous => previous + 1);
  }, [closeSocket, wsUrl]);

  const focusSoftKeyboard = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      setStatusMessage("Terminal not ready for keyboard.");
      return;
    }

    terminal.focus();
    const input = terminal.textarea;
    if (!input) {
      setStatusMessage("Tap terminal area to open keyboard.");
      return;
    }

    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    setStatusMessage("Requested mobile keyboard.");
  }, []);

  const copySelection = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      setStatusMessage("Terminal not ready for copy.");
      throw new Error("Terminal not ready for copy.");
    }

    const selectedText = terminal.getSelection();
    if (selectedText.length === 0) {
      setStatusMessage("No terminal selection to copy.");
      throw new Error("No terminal selection to copy.");
    }

    const copied = await writeClipboardText(selectedText);
    if (!copied) {
      setStatusMessage("Clipboard copy failed.");
      throw new Error("Clipboard copy failed.");
    }

    setStatusMessage(`Copied selection (${selectedText.length} chars).`);
  }, []);

  const copyRecentOutput = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      setStatusMessage("Terminal not ready for copy.");
      throw new Error("Terminal not ready for copy.");
    }

    const recentOutput = collectRecentOutput(terminal, RECENT_OUTPUT_LINES);
    if (recentOutput.length === 0) {
      setStatusMessage("No terminal output available to copy.");
      throw new Error("No terminal output available to copy.");
    }

    const copied = await writeClipboardText(recentOutput);
    if (!copied) {
      setStatusMessage("Clipboard copy failed.");
      throw new Error("Clipboard copy failed.");
    }

    setStatusMessage(`Copied recent output (${RECENT_OUTPUT_LINES} lines max).`);
  }, []);

  const getSelectableText = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      setStatusMessage("Terminal not ready for selection.");
      return "";
    }

    const selectedText = terminal.getSelection();
    if (selectedText.length > 0) {
      return selectedText;
    }

    const recentOutput = collectRecentOutput(terminal, RECENT_OUTPUT_LINES);
    if (recentOutput.length === 0) {
      setStatusMessage("No terminal output available.");
      return "";
    }

    return recentOutput;
  }, []);

  return {
    containerRef,
    connectionStatus,
    statusMessage,
    reconnect,
    focusSoftKeyboard,
    copySelection,
    copyRecentOutput,
    getSelectableText,
  };
}
