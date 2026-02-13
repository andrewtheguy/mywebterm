export interface TtydConfig {
  wsUrl: string;
}

function toWebSocketProtocol(protocol: string): "ws:" | "wss:" {
  if (protocol === "https:") {
    return "wss:";
  }

  return "ws:";
}

export function loadTtydConfig(locationLike: Pick<Location, "origin"> = window.location): TtydConfig {
  const proxyWsUrl = new URL("/ttyd/ws", locationLike.origin);
  proxyWsUrl.protocol = toWebSocketProtocol(proxyWsUrl.protocol);

  return {
    wsUrl: proxyWsUrl.toString(),
  };
}
