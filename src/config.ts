export interface TtydConfig {
  baseUrl: string;
  wsUrl: string;
}

export type TtydConfigResult =
  | { ok: true; config: TtydConfig }
  | { ok: false; error: string };

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

function trimTrailingSlash(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function buildPath(basePath: string, next: string): string {
  if (basePath === "/") {
    return `/${next}`;
  }

  return `${basePath}/${next}`;
}

export function loadTtydConfig(): TtydConfigResult {
  const rawValue = process.env.BUN_PUBLIC_TTYD_BASE_URL?.trim();

  if (!rawValue) {
    return {
      ok: false,
      error:
        "Missing BUN_PUBLIC_TTYD_BASE_URL. Example: BUN_PUBLIC_TTYD_BASE_URL=http://127.0.0.1:7681",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    return {
      ok: false,
      error: `Invalid BUN_PUBLIC_TTYD_BASE_URL: ${rawValue}`,
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

  const wsUrl = new URL(parsed.toString());
  switch (wsUrl.protocol) {
    case "http:":
      wsUrl.protocol = "ws:";
      break;
    case "https:":
      wsUrl.protocol = "wss:";
      break;
    case "ws:":
    case "wss:":
      break;
    default:
      throw new Error(
        `Unreachable protocol in wsUrl switch: ${wsUrl.protocol}`,
      );
  }

  wsUrl.pathname = buildPath(parsed.pathname, "ws");

  return {
    ok: true,
    config: {
      baseUrl: parsed.toString(),
      wsUrl: wsUrl.toString(),
    },
  };
}
