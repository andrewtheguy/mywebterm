import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyLocalHelperEnv,
  buildRemoteBootstrap,
  getLocalHelperDir,
  HELPER_NAME,
  provisionLocalHelper,
  REMOTE_DIRS,
  removeLocalHelper,
} from "./openHelper";
import helperSource from "./webtermOpen.sh" with { type: "text" };

const scratch: string[] = [];

// The parent's own values would decide these tests: editors export BROWSER, and
// a logind session exports XDG_RUNTIME_DIR, which outranks the cache fallback.
const ISOLATED = ["BROWSER", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "HOME"];

function cleanEnv(overrides: Record<string, string>): Record<string, string> {
  const env = { ...process.env, ...overrides } as Record<string, string>;
  for (const key of ISOLATED) {
    if (overrides[key] === undefined) delete env[key];
  }
  return env;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mywebterm-test-"));
  scratch.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  removeLocalHelper();
});

describe("buildRemoteBootstrap", () => {
  const bootstrap = buildRemoteBootstrap();

  test("wraps the work in /bin/sh so the remote login shell need not be POSIX", () => {
    // ssh hands the command to the user's login shell, which may be fish. Every
    // shell agrees on how to read a single-quoted argument, so that is the only
    // syntax the outer layer relies on — and the inner text must therefore not
    // contain a single quote of its own.
    expect(bootstrap.startsWith("/bin/sh -c '")).toBe(true);
    expect(bootstrap.endsWith("'")).toBe(true);
    expect(bootstrap.slice("/bin/sh -c '".length, -1)).not.toInclude("'");
  });

  test("carries the helper as base64 and ends by becoming the login shell", () => {
    const payload = bootstrap.match(/printf %s ([A-Za-z0-9+/=]+) \|/)?.[1];
    expect(payload).toBeDefined();
    expect(Buffer.from(payload as string, "base64").toString()).toBe(helperSource);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
    expect(bootstrap).toInclude('exec "${SHELL:-/bin/sh}" -l');
  });

  /** Runs the bootstrap with a stand-in login shell that reports its env. */
  async function runBootstrap(env: Record<string, string>): Promise<{ stdout: string; exitCode: number }> {
    const home = env.HOME as string;
    const fakeShell = join(home, "fake-shell");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
    writeFileSync(fakeShell, '#!/bin/sh\nprintf "%s\\n%s\\n" "${BROWSER-unset}" "$PATH"\n', { mode: 0o755 });

    const proc = Bun.spawn(["sh", "-c", bootstrap], {
      env: cleanEnv({ ...env, SHELL: fakeShell }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, exitCode };
  }

  test("installs the helper, exports BROWSER, and execs — run for real", async () => {
    const home = tempDir();
    const runtime = join(home, "run");
    const { stdout, exitCode } = await runBootstrap({ HOME: home, XDG_RUNTIME_DIR: runtime });
    expect(exitCode).toBe(0);

    const [browser, path] = stdout.split("\n");
    expect(browser).toBe(HELPER_NAME);

    const installed = join(runtime, "mywebterm", "bin");
    expect(path?.split(":")[0]).toBe(installed);
    expect(await Bun.file(join(installed, HELPER_NAME)).text()).toBe(helperSource);
    expect(statSync(join(installed, HELPER_NAME)).mode & 0o777).toBe(0o700);
  });

  test("prefers the runtime dir, falls back to the cache dir", async () => {
    // No XDG_RUNTIME_DIR is the common case off systemd, and on macOS.
    const home = tempDir();
    const { stdout } = await runBootstrap({ HOME: home, XDG_CACHE_HOME: join(home, "cache") });
    expect(stdout.split("\n")[1]?.split(":")[0]).toBe(join(home, "cache", "mywebterm", "bin"));
  });

  test("falls through when the first choice cannot execute what it stored", async () => {
    // The reason the bootstrap runs the helper rather than trusting the write:
    // a noexec mount accepts the file and refuses to run it. /proc stands in
    // here as a directory that accepts neither.
    const home = tempDir();
    const { stdout } = await runBootstrap({
      HOME: home,
      XDG_RUNTIME_DIR: "/proc/nonexistent",
      XDG_CACHE_HOME: join(home, "cache"),
    });
    expect(stdout.split("\n")[0]).toBe(HELPER_NAME);
    expect(stdout.split("\n")[1]?.split(":")[0]).toBe(join(home, "cache", "mywebterm", "bin"));
  });

  test("never aims at the filesystem root when the runtime dir is unset", () => {
    // A root session would happily create /mywebterm/bin.
    expect(bootstrap).toInclude('[ -n "$1" ] || return 1');
  });

  test("every candidate expands to nothing when its variables are unset", async () => {
    // The guard above only helps if the expansion is empty. $HOME/.cache would
    // have become /.cache — non-empty, so accepted, and created under root.
    for (const dir of REMOTE_DIRS) {
      const proc = Bun.spawn(["sh", "-c", `printf %s "${dir}"`], {
        env: cleanEnv({}),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
    }
  });

  test("installs nowhere when HOME and both XDG variables are unset", async () => {
    // The fake login shell has to live outside $HOME here, since there is none.
    const elsewhere = tempDir();
    const fakeShell = join(elsewhere, "fake-shell");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
    writeFileSync(fakeShell, '#!/bin/sh\nprintf "%s\\n" "${BROWSER-unset}"\n', { mode: 0o755 });

    const proc = Bun.spawn(["sh", "-c", bootstrap], {
      env: cleanEnv({ SHELL: fakeShell }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(stdout.split("\n")[0]).toBe("unset");
    expect(existsSync("/.cache/mywebterm")).toBe(false);
  });

  test("reaches the login shell even when no location works", async () => {
    // A read-only home is the realistic version of this: every candidate fails,
    // the install is skipped, and the session must still come up.
    const home = tempDir();
    const { stdout, exitCode } = await runBootstrap({
      HOME: home,
      XDG_RUNTIME_DIR: "/proc/nonexistent",
      XDG_CACHE_HOME: "/proc/nonexistent",
    });
    expect(exitCode).toBe(0);
    expect(stdout.split("\n")[0]).toBe("unset");
  });
});

describe("provisionLocalHelper", () => {
  test("writes an owner-only executable and puts it on PATH", () => {
    const dir = provisionLocalHelper();
    expect(dir).not.toBeNull();
    expect(getLocalHelperDir()).toBe(dir);

    const helper = join(dir as string, HELPER_NAME);
    expect(statSync(helper).mode & 0o777).toBe(0o700);

    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    applyLocalHelperEnv(env);
    expect(env.PATH).toBe(`${dir}:/usr/bin`);
    expect(env.BROWSER).toBe(HELPER_NAME);
  });

  test("is idempotent, and removal is final", () => {
    const dir = provisionLocalHelper();
    expect(provisionLocalHelper()).toBe(dir);

    removeLocalHelper();
    expect(getLocalHelperDir()).toBeNull();
    expect(() => statSync(dir as string)).toThrow();

    // A session started after removal simply goes without.
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    applyLocalHelperEnv(env);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.BROWSER).toBeUndefined();
  });
});
