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
  try {
    const configUrl = new URL("/api/config", locationLike.origin);
    const res = await fetch(configUrl);
    if (res.ok) {
      const json = await res.json();
      experimentalHScroll = json.experimentalHScroll === true;
    }
  } catch {
    // Endpoint unavailable — keep default.
  }

  return {
    wsUrl: proxyWsUrl.toString(),
    experimentalHScroll,
  };
}
