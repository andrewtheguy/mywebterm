export const TTYD_PROXY_PREFIX = "/ttyd";

function trimTrailingSlash(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function joinPath(basePathname: string, proxySuffixPathname: string): string {
  const normalizedBase = trimTrailingSlash(basePathname);
  const normalizedSuffix =
    proxySuffixPathname === ""
      ? "/"
      : proxySuffixPathname.startsWith("/")
        ? proxySuffixPathname
        : `/${proxySuffixPathname}`;

  if (normalizedBase === "/") {
    return normalizedSuffix;
  }

  if (normalizedSuffix === "/") {
    return normalizedBase;
  }

  return `${normalizedBase}${normalizedSuffix}`;
}

export function rewriteProxyRequestUrl(
  requestUrl: string,
  upstreamBaseUrl: URL,
  proxyPrefix = TTYD_PROXY_PREFIX,
): URL {
  const incomingUrl = new URL(requestUrl);
  const normalizedProxyPrefix = trimTrailingSlash(proxyPrefix);

  if (
    incomingUrl.pathname !== normalizedProxyPrefix &&
    !incomingUrl.pathname.startsWith(`${normalizedProxyPrefix}/`)
  ) {
    throw new Error(`Proxy path must start with "${normalizedProxyPrefix}"`);
  }

  const suffixPathname =
    incomingUrl.pathname === normalizedProxyPrefix
      ? "/"
      : incomingUrl.pathname.slice(normalizedProxyPrefix.length);

  const targetUrl = new URL(upstreamBaseUrl.toString());
  targetUrl.pathname = joinPath(targetUrl.pathname, suffixPathname);
  targetUrl.search = incomingUrl.search;
  targetUrl.hash = "";
  return targetUrl;
}

export function isWebSocketUpgradeRequest(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}
