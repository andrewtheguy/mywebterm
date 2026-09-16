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
  appTitle: string;
  shellCommand: string[];
  authEnabled: boolean;
}

export interface SshHostsResult {
  // Host aliases from the --ssh-config file, offered on the start screen
  hosts: string[];
  // Set when the config file could not be read; the page shows it instead of
  // a host list and keeps the local shell entry working.
  error: string | null;
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
    appTitle,
    shellCommand,
    authEnabled,
  };
}

// Queried every time the start screen is shown rather than once at load, so
// edits to the --ssh-config file are picked up without reloading the page.
export async function loadSshHosts(locationLike: Pick<Location, "origin"> = window.location): Promise<SshHostsResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(new URL("/api/ssh-hosts", locationLike.origin), { signal: controller.signal });
    if (res.status === 401) {
      window.location.href = "/login";
      throw new AuthError();
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return { hosts: [], error: typeof json?.error === "string" ? json.error : `Request failed (${res.status})` };
    }
    const hosts = Array.isArray(json?.hosts) ? json.hosts.filter((h: unknown) => typeof h === "string") : [];
    return { hosts, error: null };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    return { hosts: [], error: "Could not reach the server." };
  } finally {
    clearTimeout(timeoutId);
  }
}
