import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyLocalHelperEnv,
  buildRemoteBootstrap,
  getLocalHelperDir,
  HELPER_NAME,
  provisionLocalHelper,
  removeLocalHelper,
} from "./openHelper";
import helperSource from "./webtermOpen.sh" with { type: "text" };

const scratch: string[] = [];

/** The parent may export BROWSER (editors do); these tests assert on our own. */
function cleanEnv(overrides: Record<string, string>): Record<string, string> {
  const env = { ...process.env, ...overrides } as Record<string, string>;
  if (overrides.BROWSER === undefined) delete env.BROWSER;
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

  test("installs the helper, exports BROWSER, and execs — run for real", async () => {
    const home = tempDir();
    // A stand-in login shell that reports the environment it inherited.
    const fakeShell = join(home, "fake-shell");
    writeFileSync(fakeShell, '#!/bin/sh\nprintf "%s\\n%s\\n" "$BROWSER" "$PATH"\n', { mode: 0o755 });

    const proc = Bun.spawn(["sh", "-c", bootstrap], {
      env: cleanEnv({ HOME: home, XDG_CACHE_HOME: join(home, "cache"), SHELL: fakeShell }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);

    const [browser, path] = stdout.split("\n");
    expect(browser).toBe(HELPER_NAME);

    const installed = join(home, "cache", "mywebterm", "bin");
    expect(path?.split(":")[0]).toBe(installed);
    expect(await Bun.file(join(installed, HELPER_NAME)).text()).toBe(helperSource);
    expect(statSync(join(installed, HELPER_NAME)).mode & 0o777).toBe(0o700);
  });

  test("reaches the login shell even when the helper cannot be written", async () => {
    // A read-only home is the realistic version of this: mkdir -p fails, the
    // whole install is skipped, and the session must still come up.
    const home = tempDir();
    const fakeShell = join(home, "fake-shell");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
    writeFileSync(fakeShell, '#!/bin/sh\nprintf "%s\\n" "${BROWSER-unset}"\n', { mode: 0o755 });

    const proc = Bun.spawn(["sh", "-c", bootstrap], {
      env: cleanEnv({ HOME: home, XDG_CACHE_HOME: "/proc/nonexistent", SHELL: fakeShell }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("unset");
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
