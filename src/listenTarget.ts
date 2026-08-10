// Parsing for `--listen`, the single option that says where the server binds.
//
// Accepted forms:
//   8671                        port on the default loopback address
//   127.0.0.1:8671              host and port
//   0.0.0.0:8671                all interfaces
//   [::1]:8671                  IPv6 literal, brackets required so the port is
//                               distinguishable from an address group
//   unix:/run/mywebterm.sock            unix socket, owner-only (mode 600)
//   unix:/run/mywebterm.sock,mode=660   unix socket with explicit permissions

export type ListenTarget =
  | { kind: "tcp"; hostname: string; port: number; isLoopback: boolean }
  | { kind: "unix"; path: string; mode: number };

export const DEFAULT_LISTEN = "127.0.0.1:8671";

const DEFAULT_UNIX_MODE = 0o600;
const UNIX_MODE_SUFFIX = /^(.*),mode=([0-7]{3,4})$/;

function parsePort(text: string): number {
  const port = Number(text);
  if (!/^\d{1,5}$/.test(text) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port ${JSON.stringify(text)} (must be an integer 1-65535)`);
  }
  return port;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/**
 * Parses a `--listen` value. Throws an `Error` whose message completes the
 * sentence "invalid --listen value: ..." — the caller turns that into an exit.
 */
export function parseListenTarget(raw: string): ListenTarget {
  const text = raw.trim();
  if (text === "") throw new Error("value is empty");

  if (text.startsWith("unix:")) {
    let path = text.slice("unix:".length);
    let mode = DEFAULT_UNIX_MODE;

    const withMode = UNIX_MODE_SUFFIX.exec(path);
    if (withMode?.[1] !== undefined && withMode[2] !== undefined) {
      path = withMode[1];
      mode = parseInt(withMode[2], 8);
    }

    if (path === "") throw new Error("unix socket path is empty");
    return { kind: "unix", path, mode };
  }

  // Bare number: a port on the default loopback address.
  if (/^\d+$/.test(text)) {
    return { kind: "tcp", hostname: "127.0.0.1", port: parsePort(text), isLoopback: true };
  }

  let hostname: string;
  let portText: string;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end === -1) throw new Error("unterminated [ in IPv6 address");
    hostname = text.slice(1, end);
    const tail = text.slice(end + 1);
    if (!tail.startsWith(":")) throw new Error("IPv6 address needs a :port suffix, e.g. [::1]:8671");
    portText = tail.slice(1);
  } else {
    const colon = text.lastIndexOf(":");
    if (colon === -1) throw new Error(`missing port in ${JSON.stringify(text)}, e.g. ${text}:8671`);
    hostname = text.slice(0, colon);
    portText = text.slice(colon + 1);
    // A bare IPv6 literal has several colons and no bracket to delimit the
    // port; requiring brackets is the only unambiguous rule.
    if (hostname.includes(":")) throw new Error("IPv6 addresses must be bracketed, e.g. [::1]:8671");
  }

  if (hostname === "") throw new Error("host is empty");
  return { kind: "tcp", hostname, port: parsePort(portText), isLoopback: isLoopbackHost(hostname) };
}

/** How the target is shown in the startup line and in error messages. */
export function describeListenTarget(target: ListenTarget): string {
  if (target.kind === "unix") {
    return `${target.path} (mode ${target.mode.toString(8)})`;
  }
  const host = target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname;
  return `http://${host}:${target.port}/`;
}
