import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helperSource = await Bun.file(new globalThis.URL("../scripts/webterm-open", import.meta.url)).text();

const URL = "https://example.com/preview";
const OSC = `\x1b]1338;${URL}\x07`;

const scratch = mkdtempSync(join(tmpdir(), "mywebterm-helper-"));
const helper = join(scratch, "webterm-open");
writeFileSync(helper, helperSource);
chmodSync(helper, 0o700);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Pty {
  path: string;
  received: () => string;
  close: () => void;
}

/**
 * A pty held open by an idle process, standing in for the terminal MyWebTerm is
 * attached to. Anything written to its slave path shows up in `received`, which
 * is exactly how the helper reaches a terminal it does not own.
 */
async function openPty(): Promise<Pty> {
  let buffer = "";
  let resolvePath: (path: string) => void = () => {};
  const found = new Promise<string>((resolve) => {
    resolvePath = resolve;
  });

  const proc = Bun.spawn(["sh", "-c", "tty; exec sleep 60"], {
    terminal: {
      cols: 80,
      rows: 24,
      data(_terminal, data) {
        buffer += new TextDecoder().decode(data);
        const match = buffer.match(/(\/dev\/pts\/\d+)/);
        if (match) resolvePath(match[1] as string);
      },
    },
  });

  const path = await found;
  buffer = ""; // drop the `tty` output; only later writes are interesting
  return {
    path,
    received: () => buffer,
    close: () => {
      proc.terminal?.close();
      proc.kill();
    },
  };
}

/** Runs the helper on its own pty — the pane — and reports what each side saw. */
async function runHelper(env: Record<string, string>): Promise<{ pane: string; outer: Pty }> {
  const outer = await openPty();
  let pane = "";

  const proc = Bun.spawn([helper, URL], {
    env: { PATH: process.env.PATH as string, WEBTERM_TTY: outer.path, ...env },
    terminal: {
      cols: 80,
      rows: 24,
      data(_terminal, data) {
        pane += new TextDecoder().decode(data);
      },
    },
  });
  await proc.exited;
  // The write lands on the other pty's master through the kernel, not through
  // this process, so give the read loop a turn before looking.
  await Bun.sleep(50);
  return { pane, outer };
}

describe("webterm-open delivery", () => {
  test("writes to its own terminal when no multiplexer is in the way", async () => {
    // $WEBTERM_TTY is set here too and must lose: outside a multiplexer /dev/tty
    // is already right, and a stale value would surface the toast elsewhere.
    const { pane, outer } = await runHelper({});
    try {
      expect(pane).toInclude(OSC);
      expect(outer.received()).toBe("");
    } finally {
      outer.close();
    }
  });

  test("reaches past a zellij pane to the terminal MyWebTerm is showing", async () => {
    // Measured, not assumed: zellij drops OSC 1338 in every wrapping there is,
    // so the pane is not a delivery route at all.
    const { pane, outer } = await runHelper({ ZELLIJ: "0", ZELLIJ_SESSION_NAME: "test" });
    try {
      expect(outer.received()).toInclude(OSC);
      expect(pane).toBe("");
    } finally {
      outer.close();
    }
  });

  test("sends the outer terminal the bare sequence, with no DCS wrapping", async () => {
    // The wrapping exists to escape a pane. Writing it to the terminal itself
    // would just render as garbage.
    const { outer } = await runHelper({ TMUX: "/tmp/tmux-1000/default,1,0" });
    try {
      expect(outer.received()).toBe(OSC);
    } finally {
      outer.close();
    }
  });

  test("falls back to a tmux passthrough when the outer terminal is unreachable", async () => {
    const { pane, outer } = await runHelper({ TMUX: "/tmp/tmux-1000/default,1,0", WEBTERM_TTY: "/nonexistent" });
    try {
      expect(pane).toInclude(`\x1bPtmux;\x1b${OSC}\x1b\\`);
      expect(outer.received()).toBe("");
    } finally {
      outer.close();
    }
  });

  test("treats a screen-flavoured TERM as a multiplexer", async () => {
    const { outer } = await runHelper({ TERM: "screen-256color" });
    try {
      expect(outer.received()).toBe(OSC);
    } finally {
      outer.close();
    }
  });

  test("uses SSH_TTY when the multiplexer inherited no WEBTERM_TTY", async () => {
    const outer = await openPty();
    let pane = "";
    const proc = Bun.spawn([helper, URL], {
      // No WEBTERM_TTY at all: sshd's own record points at the outer pty.
      env: { PATH: process.env.PATH as string, ZELLIJ: "0", SSH_TTY: outer.path },
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, data) {
          pane += new TextDecoder().decode(data);
        },
      },
    });
    await proc.exited;
    await Bun.sleep(50);
    try {
      expect(outer.received()).toInclude(OSC);
      expect(pane).toBe("");
    } finally {
      outer.close();
    }
  });

  test("rejects a URL that is not http(s)", async () => {
    const proc = Bun.spawn([helper, "file:///etc/passwd"], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(2);
  });
});
