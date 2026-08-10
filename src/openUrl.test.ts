import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";

import { createOpenUrlOscHandler, formatUrlForDisplay, normalizeOpenableUrl, OPEN_URL_OSC } from "./openUrl";

describe("normalizeOpenableUrl", () => {
  test("accepts http and https, trimming surrounding whitespace", () => {
    expect(normalizeOpenableUrl("  https://example.com/a?b=1#c  ")).toBe("https://example.com/a?b=1#c");
    expect(normalizeOpenableUrl("http://example.com")).toBe("http://example.com/");
  });

  test("rejects non-http schemes", () => {
    expect(normalizeOpenableUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeOpenableUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(normalizeOpenableUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeOpenableUrl("example.com")).toBeNull();
  });

  test("rejects embedded credentials that disguise the real host", () => {
    expect(normalizeOpenableUrl("https://github.com@evil.example/")).toBeNull();
    expect(normalizeOpenableUrl("https://user:pw@evil.example/")).toBeNull();
  });

  test("rejects control characters, spaces and bidi overrides", () => {
    const newline = String.fromCharCode(0x0a);
    const rtlOverride = String.fromCharCode(0x202e);
    expect(normalizeOpenableUrl(`https://example.com/${newline}extra`)).toBeNull();
    expect(normalizeOpenableUrl("https://exa mple.com/")).toBeNull();
    expect(normalizeOpenableUrl(`https://example.com/${rtlOverride}gnp.exe`)).toBeNull();
  });

  test("rejects empty and oversized input", () => {
    expect(normalizeOpenableUrl("")).toBeNull();
    expect(normalizeOpenableUrl("   ")).toBeNull();
    expect(normalizeOpenableUrl(`https://example.com/${"a".repeat(2048)}`)).toBeNull();
  });
});

describe("createOpenUrlOscHandler", () => {
  // Drives the sequence through a real xterm parser, so the OSC identifier and
  // the payload split are covered too, not just the URL check.
  async function writeToTerminal(data: string): Promise<{ opened: string[]; rejected: string[] }> {
    const opened: string[] = [];
    const rejected: string[] = [];
    const terminal = new Terminal({ allowProposedApi: true });
    terminal.parser.registerOscHandler(
      OPEN_URL_OSC,
      createOpenUrlOscHandler({
        onOpenRequest: (url) => opened.push(url),
        onRejected: (raw) => rejected.push(raw),
      }),
    );

    await new Promise<void>((resolve) => {
      terminal.write(data, resolve);
    });
    terminal.dispose();
    return { opened, rejected };
  }

  test("opens the URL from a BEL-terminated sequence", async () => {
    const { opened, rejected } = await writeToTerminal("\x1b]1338;https://example.com/a\x07");
    expect(opened).toEqual(["https://example.com/a"]);
    expect(rejected).toEqual([]);
  });

  test("opens the URL from an ST-terminated sequence", async () => {
    const { opened } = await writeToTerminal("\x1b]1338;https://example.com/b\x1b\\");
    expect(opened).toEqual(["https://example.com/b"]);
  });

  test("rejects a non-http payload without writing it to the screen", async () => {
    const { opened, rejected } = await writeToTerminal("\x1b]1338;javascript:alert(1)\x07");
    expect(opened).toEqual([]);
    expect(rejected).toEqual(["javascript:alert(1)"]);
  });
});

describe("formatUrlForDisplay", () => {
  test("leaves short URLs alone", () => {
    expect(formatUrlForDisplay("https://example.com/")).toBe("https://example.com/");
  });

  test("truncates long URLs to a single ellipsis-terminated line", () => {
    const long = `https://example.com/${"a".repeat(200)}`;
    const shown = formatUrlForDisplay(long);
    expect(shown).toHaveLength(96);
    expect(shown.endsWith("…")).toBe(true);
  });
});
