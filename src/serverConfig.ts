export interface ServerTtydConfig {
  httpBaseUrl: URL;
  wsBaseUrl: URL;
}

export type ServerTtydConfigResult =
  | { ok: true; config: ServerTtydConfig }
  | { ok: false; error: string };

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

function trimTrailingSlash(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function toHttpProtocol(protocol: string): "http:" | "https:" {
  if (protocol === "wss:" || protocol === "https:") {
    return "https:";
  }

  return "http:";
}

function toWsProtocol(protocol: string): "ws:" | "wss:" {
  if (protocol === "https:" || protocol === "wss:") {
    return "wss:";
  }

  return "ws:";
}

export function parseTtydBaseUrl(rawValue: string | undefined): ServerTtydConfigResult {
  const trimmedValue = rawValue?.trim();
  if (!trimmedValue) {
    return {
      ok: false,
      error: "Missing TTYD_BASE_URL. Example: TTYD_BASE_URL=http://127.0.0.1:7681",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmedValue);
  } catch {
    return {
      ok: false,
      error: `Invalid TTYD_BASE_URL: ${trimmedValue}`,
    };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      error: `Unsupported protocol "${parsed.protocol}". Use http(s) or ws(s).`,
    };
  }

  parsed.pathname = trimTrailingSlash(parsed.pathname);
  parsed.search = "";
  parsed.hash = "";

  const httpBaseUrl = new URL(parsed.toString());
  httpBaseUrl.protocol = toHttpProtocol(parsed.protocol);

  const wsBaseUrl = new URL(parsed.toString());
  wsBaseUrl.protocol = toWsProtocol(parsed.protocol);

  return {
    ok: true,
    config: {
      httpBaseUrl,
      wsBaseUrl,
    },
  };
}

export function loadServerTtydConfig(env: NodeJS.ProcessEnv = process.env): ServerTtydConfig {
  const result = parseTtydBaseUrl(env.TTYD_BASE_URL);

  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.config;
}
