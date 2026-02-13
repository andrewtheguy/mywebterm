import { serve, type Server, type ServerWebSocket } from "bun";
import index from "./index.html";
import { loadServerTtydConfig } from "./serverConfig";
import { isWebSocketUpgradeRequest, rewriteProxyRequestUrl, TTYD_PROXY_PREFIX } from "./ttydProxy";

interface ProxySocketData {
  connectionId: string;
}

const ttydConfig = loadServerTtydConfig();

const upstreamSockets = new Map<string, WebSocket>();
const clientSockets = new Map<string, ServerWebSocket<ProxySocketData>>();
const pendingClientMessages = new Map<string, Array<string | BufferSource>>();
let nextConnectionId = 0;

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const UPSTREAM_HTTP_TIMEOUT_MS = 15_000;

function stripHopByHopHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  const connectionHeader = headers.get("connection");

  for (const header of HOP_BY_HOP_HEADERS) {
    sanitized.delete(header);
  }

  if (connectionHeader) {
    const dynamicHopByHopHeaders = connectionHeader
      .split(",")
      .map(token => token.trim().toLowerCase())
      .filter(Boolean);

    for (const header of dynamicHopByHopHeaders) {
      sanitized.delete(header);
    }
  }

  sanitized.delete("connection");
  sanitized.delete("host");
  return sanitized;
}

function closeUpstreamSocket(upstreamSocket: WebSocket | undefined): void {
  if (!upstreamSocket) {
    return;
  }

  if (upstreamSocket.readyState === WebSocket.CONNECTING || upstreamSocket.readyState === WebSocket.OPEN) {
    upstreamSocket.close();
  }
}

function closeClientSocket(
  clientSocket: ServerWebSocket<ProxySocketData> | undefined,
  code?: number,
  reason?: string,
): void {
  if (!clientSocket) {
    return;
  }

  if (clientSocket.readyState === WebSocket.CONNECTING || clientSocket.readyState === WebSocket.OPEN) {
    if (code === undefined) {
      clientSocket.close();
      return;
    }

    clientSocket.close(code, reason);
  }
}

function removeConnection(connectionId: string): {
  upstreamSocket?: WebSocket;
  clientSocket?: ServerWebSocket<ProxySocketData>;
} {
  const upstreamSocket = upstreamSockets.get(connectionId);
  const clientSocket = clientSockets.get(connectionId);
  upstreamSockets.delete(connectionId);
  clientSockets.delete(connectionId);
  pendingClientMessages.delete(connectionId);
  return { upstreamSocket, clientSocket };
}

function proxyUpstreamMessage(connectionId: string, data: unknown): void {
  const clientSocket = clientSockets.get(connectionId);
  if (!clientSocket || clientSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  if (typeof data === "string") {
    clientSocket.send(data);
    return;
  }

  if (data instanceof ArrayBuffer) {
    clientSocket.send(data);
    return;
  }

  if (ArrayBuffer.isView(data)) {
    clientSocket.send(data);
    return;
  }

  if (data instanceof Blob) {
    void data
      .arrayBuffer()
      .then(buffer => {
        const activeClient = clientSockets.get(connectionId);
        if (!activeClient || activeClient.readyState !== WebSocket.OPEN) {
          return;
        }
        activeClient.send(buffer);
      })
      .catch(error => {
        // Ignore malformed frames, but keep debug visibility for proxy troubleshooting.
        console.debug("Failed to forward upstream Blob frame", {
          connectionId,
          error,
        });
      });
  }
}

function createConnectionId(): string {
  nextConnectionId += 1;
  return `${Date.now()}-${nextConnectionId}`;
}

function describeReadyState(readyState: number): "CONNECTING" | "OPEN" | "CLOSING" | "CLOSED" | "UNKNOWN" {
  switch (readyState) {
    case WebSocket.CONNECTING:
      return "CONNECTING";
    case WebSocket.OPEN:
      return "OPEN";
    case WebSocket.CLOSING:
      return "CLOSING";
    case WebSocket.CLOSED:
      return "CLOSED";
    default:
      return "UNKNOWN";
  }
}

function describeMessagePayload(message: string | Buffer): Record<string, number | string> {
  if (typeof message === "string") {
    return {
      type: "string",
      length: message.length,
      preview: message.slice(0, 120),
    };
  }

  return {
    type: "buffer",
    length: message.byteLength,
  };
}

function openUpstreamSocket(connectionId: string, upstreamWsUrl: URL): WebSocket {
  const upstreamSocket = new WebSocket(upstreamWsUrl.toString(), ["tty"]);
  upstreamSocket.binaryType = "arraybuffer";

  upstreamSocket.onopen = () => {
    const bufferedMessages = pendingClientMessages.get(connectionId);
    if (!bufferedMessages || bufferedMessages.length === 0) {
      return;
    }

    pendingClientMessages.delete(connectionId);
    for (const bufferedMessage of bufferedMessages) {
      upstreamSocket.send(bufferedMessage);
    }
  };

  upstreamSocket.onmessage = event => {
    proxyUpstreamMessage(connectionId, event.data);
  };

  upstreamSocket.onerror = () => {
    const { upstreamSocket: activeUpstream, clientSocket } = removeConnection(connectionId);
    closeUpstreamSocket(activeUpstream);
    closeClientSocket(clientSocket, 1011, "Upstream WebSocket error");
  };

  upstreamSocket.onclose = event => {
    const { clientSocket } = removeConnection(connectionId);
    closeClientSocket(clientSocket, event.code, event.reason);
  };

  return upstreamSocket;
}

function handleWebSocketProxyRequest(
  req: Request,
  server: Server<ProxySocketData>,
): Response | undefined {
  let upstreamWsUrl: URL;
  try {
    upstreamWsUrl = rewriteProxyRequestUrl(req.url, ttydConfig.wsBaseUrl, TTYD_PROXY_PREFIX);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Invalid proxy path", { status: 400 });
  }

  const connectionId = createConnectionId();
  const upstreamSocket = openUpstreamSocket(connectionId, upstreamWsUrl);

  upstreamSockets.set(connectionId, upstreamSocket);
  const upgraded = server.upgrade(req, {
    data: { connectionId },
  });

  if (!upgraded) {
    const { upstreamSocket: activeUpstream } = removeConnection(connectionId);
    closeUpstreamSocket(activeUpstream ?? upstreamSocket);
    return new Response("WebSocket upgrade failed", { status: 400 });
  }
  return undefined;
}

async function handleHttpProxyRequest(req: Request): Promise<Response> {
  let upstreamHttpUrl: URL;
  try {
    upstreamHttpUrl = rewriteProxyRequestUrl(req.url, ttydConfig.httpBaseUrl, TTYD_PROXY_PREFIX);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Invalid proxy path", { status: 400 });
  }

  const headers = stripHopByHopHeaders(req.headers);
  const requestInit: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    requestInit.body = req.body;
  }

  const upstreamTimeout = new AbortController();
  const timeoutId = setTimeout(() => {
    upstreamTimeout.abort();
  }, UPSTREAM_HTTP_TIMEOUT_MS);
  requestInit.signal = upstreamTimeout.signal;

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamHttpUrl, requestInit);
  } catch {
    if (upstreamTimeout.signal.aborted) {
      return new Response("ttyd upstream request timed out.", { status: 504 });
    }

    return new Response("Unable to reach ttyd upstream.", { status: 502 });
  } finally {
    clearTimeout(timeoutId);
  }

  const responseHeaders = stripHopByHopHeaders(upstreamResponse.headers);
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

async function handleTtydProxyRequest(
  req: Request,
  server: Server<ProxySocketData>,
): Promise<Response | undefined> {
  if (isWebSocketUpgradeRequest(req)) {
    return handleWebSocketProxyRequest(req, server);
  }

  return handleHttpProxyRequest(req);
}

const server = serve<ProxySocketData>({
  routes: {
    "/ttyd": handleTtydProxyRequest,
    "/ttyd/*": handleTtydProxyRequest,
    "/*": index,
  },

  websocket: {
    data: {} as ProxySocketData,
    open(ws) {
      clientSockets.set(ws.data.connectionId, ws);
    },
    message(ws, message) {
      const upstreamSocket = upstreamSockets.get(ws.data.connectionId);
      if (!upstreamSocket) {
        console.warn("Dropping client message because upstream socket is missing", {
          connectionId: ws.data.connectionId,
          readyState: "MISSING",
          message: describeMessagePayload(message),
        });
        ws.close(1011, "Upstream WebSocket unavailable");
        return;
      }

      if (upstreamSocket.readyState === WebSocket.OPEN) {
        upstreamSocket.send(message);
        return;
      }

      if (upstreamSocket.readyState === WebSocket.CONNECTING) {
        const queue = pendingClientMessages.get(ws.data.connectionId) ?? [];
        queue.push(message);
        pendingClientMessages.set(ws.data.connectionId, queue);
        return;
      }

      console.warn("Dropping client message because upstream socket is not writable", {
        connectionId: ws.data.connectionId,
        readyState: describeReadyState(upstreamSocket.readyState),
        message: describeMessagePayload(message),
      });
      ws.close(1011, "Upstream WebSocket not writable");
    },
    close(ws) {
      const { upstreamSocket } = removeConnection(ws.data.connectionId);
      closeUpstreamSocket(upstreamSocket);
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
