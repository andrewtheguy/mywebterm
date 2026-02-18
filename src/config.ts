export class AuthError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "AuthError";
  }
}

export const DEFAULT_APP_TITLE = "MyWebTerm";

export interface TtyConfig {
  wsUrl: string;
  version: string;
  hscroll: boolean;
  appTitle: string;
  shellCommand: string[];
  authEnabled: boolean;
}

function toWebSocketProtocol(protocol: string): "ws:" | "wss:" {
  if (protocol === "https:") {
    return "wss:";
  }

  return "ws:";
}

export async function loadTtyConfig(locationLike: Pick<Location, "origin"> = window.location): Promise<TtyConfig> {
  const proxyWsUrl = new URL("/tty/ws", locationLike.origin);
  proxyWsUrl.protocol = toWebSocketProtocol(proxyWsUrl.protocol);

  let version = "";
  let hscroll = true;
  let appTitle = DEFAULT_APP_TITLE;
  let shellCommand: string[] = [];
  let authEnabled = true;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const configUrl = new URL("/api/config", locationLike.origin);
    const res = await fetch(configUrl, { signal: controller.signal });
    if (res.status === 401) {
      window.location.href = "/login";
      throw new AuthError();
    }
    if (res.ok) {
      const json = await res.json();
      version = json.version ?? "";
      hscroll = json.hscroll ?? true;
      appTitle = json.appTitle ?? DEFAULT_APP_TITLE;
      shellCommand = Array.isArray(json.shellCommand) ? json.shellCommand : [];
      authEnabled = typeof json.authEnabled === "boolean" ? json.authEnabled : true;
    }
  } catch (err) {
    if (err instanceof AuthError) throw err;
    // Endpoint unavailable or timed out — keep default.
  } finally {
    clearTimeout(timeoutId);
  }

  return {
    wsUrl: proxyWsUrl.toString(),
    version,
    hscroll,
    appTitle,
    shellCommand,
    authEnabled,
  };
}
