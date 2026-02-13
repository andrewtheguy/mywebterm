export interface TtydConfig {
  baseUrl: string;
  wsUrl: string;
}

function toWebSocketProtocol(protocol: string): "ws:" | "wss:" {
  if (protocol === "https:") {
    return "wss:";
  }

  return "ws:";
}

export function loadTtydConfig(locationLike: Pick<Location, "origin"> = window.location): TtydConfig {
  const proxyBaseUrl = new URL("/ttyd", locationLike.origin);
  const proxyWsUrl = new URL("/ttyd/ws", locationLike.origin);
  proxyWsUrl.protocol = toWebSocketProtocol(proxyWsUrl.protocol);

  return {
    baseUrl: proxyBaseUrl.toString(),
    wsUrl: proxyWsUrl.toString(),
  };
}
