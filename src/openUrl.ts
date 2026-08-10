// Opening links in the browser that is running MyWebTerm, rather than on the
// machine the terminal is attached to.
//
// Two things feed this:
//   - clicking a link in the terminal (OSC 8 hyperlinks, or a plain URL in the
//     output picked up by the web-links addon). That is already a user
//     gesture, so it opens straight away.
//   - OSC 1338 emitted by a program on the far side ("please open this URL").
//     That is not a user gesture — popup blockers would eat it, and a remote
//     host should not be able to navigate the browser on its own — so it is
//     confirmed by the user before anything opens.

// Private OSC identifier for "open this URL in the viewing browser". One past
// iTerm2's proprietary 1337, and not claimed by any terminal MyWebTerm cares
// about (see docs/architecture.md#opening-links).
export const OPEN_URL_OSC = 1338;

const MAX_URL_LENGTH = 2048;
const MAX_DISPLAY_LENGTH = 96;

// Control characters, spaces and the Unicode direction overrides never belong
// in a URL that arrived over a tty, and are the usual way to smuggle something
// past a check like this one (bidi overrides in particular can make a URL
// render as a completely different host).
function hasUnsafeChars(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (code >= 0x200e && code <= 0x200f) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
  }
  return false;
}

/**
 * Returns the URL to hand to the browser, or null when it is not something
 * MyWebTerm is willing to open.
 */
export function normalizeOpenableUrl(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_URL_LENGTH) return null;
  if (hasUnsafeChars(text)) return null;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  // http(s) only: javascript:, data: and file: are all ways for terminal
  // output to run something in the browser or read the viewer's disk.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // "https://trusted.example@evil.example" reads as the trusted host at a
  // glance, which defeats the point of showing the URL in the confirmation.
  if (url.username !== "" || url.password !== "") return null;

  return url.toString();
}

interface OpenUrlOscHandlers {
  /** The payload was an openable URL; ask the user whether to open it. */
  onOpenRequest: (url: string) => void;
  /** The payload was missing or not an openable http(s) URL. */
  onRejected: (raw: string) => void;
}

/**
 * Builds the `OSC 1338 ; <url> BEL` handler. Always returns true: the sequence
 * is ours, so it must never fall through to the terminal as text.
 */
export function createOpenUrlOscHandler(handlers: OpenUrlOscHandlers): (data: string) => boolean {
  return (data: string) => {
    const url = normalizeOpenableUrl(data);
    if (url) {
      handlers.onOpenRequest(url);
    } else {
      handlers.onRejected(data);
    }
    return true;
  };
}

/** Shortens a URL for the confirmation toast so it cannot overflow the layout. */
export function formatUrlForDisplay(url: string): string {
  if (url.length <= MAX_DISPLAY_LENGTH) return url;
  return `${url.slice(0, MAX_DISPLAY_LENGTH - 1)}…`;
}

/**
 * Opens a URL in a new tab of this browser. Uses a synthetic anchor rather than
 * `window.open` so `noopener` does not cost the return value, and so the click
 * inherits the user gesture that triggered it.
 */
export function openUrlInNewTab(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
