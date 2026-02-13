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

export async function loadTtydConfig(locationLike: Pick<Location, "origin"> = window.location): Promise<TtydConfig> {
  const proxyWsUrl = new URL("/ttyd/ws", locationLike.origin);
  proxyWsUrl.protocol = toWebSocketProtocol(proxyWsUrl.protocol);

  let experimentalHScroll = false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const configUrl = new URL("/api/config", locationLike.origin);
    const res = await fetch(configUrl, { signal: controller.signal });
    if (res.ok) {
      const json = await res.json();
      experimentalHScroll = json.experimentalHScroll === true;
    }
  } catch {
    // Endpoint unavailable or timed out — keep default.
  } finally {
    clearTimeout(timeoutId);
  }

  return {
    wsUrl: proxyWsUrl.toString(),
    experimentalHScroll,
  };
}
