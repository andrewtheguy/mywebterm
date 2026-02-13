export interface TtydConfig {
  wsUrl: string;
  experimentalHScroll: boolean;
}

function toWebSocketProtocol(protocol: string): "ws:" | "wss:" {
  if (protocol === "https:") {
    return "wss:";
  }

  return "ws:";
}

const HSCROLL_STORAGE_KEY = "experimentalHScroll";

function loadExperimentalHScroll(search: string): boolean {
  const params = new URLSearchParams(search);
  const urlValue = params.get("experimentalHScroll");

  if (urlValue === "1" || urlValue === "0") {
    const enabled = urlValue === "1";
    try {
      localStorage.setItem(HSCROLL_STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      // Storage unavailable — ignore.
    }
    return enabled;
  }

  try {
    return localStorage.getItem(HSCROLL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function loadTtydConfig(locationLike: Pick<Location, "origin" | "search"> = window.location): TtydConfig {
  const proxyWsUrl = new URL("/ttyd/ws", locationLike.origin);
  proxyWsUrl.protocol = toWebSocketProtocol(proxyWsUrl.protocol);

  return {
    wsUrl: proxyWsUrl.toString(),
    experimentalHScroll: loadExperimentalHScroll(locationLike.search),
  };
}
