// Planting `webterm-open` on the far side of every session.
//
// Clicking a URL in the output is handled entirely in the browser, but a
// program that *launches* a browser itself (`gh auth login`, `xdg-open`,
// Shopify CLI's preview shortcut) runs on the session's host and needs a
// command there to run. The server can't reach into that host after the fact,
// so it plants the helper as the session starts: a private directory on $PATH
// for local shells, and a base64 payload carried over the ssh command line for
// remote ones. Nothing is installed by hand on any host.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import helperSource from "./webtermOpen.sh" with { type: "text" };

export const HELPER_NAME = "webterm-open";

/** Where the helper lands on a remote host. Reused, so sessions don't litter. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
const REMOTE_DIR = "${XDG_CACHE_HOME:-$HOME/.cache}/mywebterm/bin";

let localHelperDir: string | null = null;

/**
 * Writes the helper somewhere local shells can reach it. Returns the directory
 * to prepend to $PATH, or null if it could not be written — a session without
 * the helper is still a working session, so this never throws.
 */
export function provisionLocalHelper(): string | null {
  if (localHelperDir !== null) return localHelperDir;
  try {
    // 0700 from mkdtemp: the helper is executable, so keep it to this user.
    const dir = mkdtempSync(join(tmpdir(), "mywebterm-"));
    const path = join(dir, HELPER_NAME);
    writeFileSync(path, helperSource);
    chmodSync(path, 0o700); // writeFileSync's mode is subject to umask; this is not.
    localHelperDir = dir;
    return dir;
  } catch (err) {
    console.error(`Could not install ${HELPER_NAME}, browser-opening from local shells will not work:`, err);
    return null;
  }
}

export function getLocalHelperDir(): string | null {
  return localHelperDir;
}

/** Removes the local helper directory. Safe to call when nothing was written. */
export function removeLocalHelper(): void {
  if (localHelperDir === null) return;
  try {
    rmSync(localHelperDir, { recursive: true, force: true });
  } catch {
    // Exiting anyway; a leftover temp directory is not worth a message.
  }
  localHelperDir = null;
}

/**
 * The remote command for an ssh session: install the helper, then become the
 * login shell.
 *
 * Two constraints shape the quoting. ssh hands the command to the *user's*
 * login shell, which may be fish — so the real work is wrapped in `/bin/sh -c
 * '...'`, and the wrapped text therefore may not contain a single quote. That
 * is why the payload is base64, whose alphabet is also shell-safe unquoted.
 *
 * Every failure path still reaches the `exec`: a remote host with no base64,
 * an unwritable cache directory or a read-only home loses the helper, never
 * the shell.
 */
export function buildRemoteBootstrap(): string {
  const payload = Buffer.from(helperSource).toString("base64");
  const target = `"$d/${HELPER_NAME}"`;
  const inner = [
    `d=${REMOTE_DIR};`,
    `if mkdir -p "$d" && printf %s ${payload} | base64 -d > ${target} 2>/dev/null; then`,
    `chmod 700 ${target};`,
    `PATH="$d:$PATH";`,
    `BROWSER=${HELPER_NAME};`,
    "export PATH BROWSER;",
    "fi;",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
    'exec "${SHELL:-/bin/sh}" -l',
  ].join(" ");
  return `/bin/sh -c '${inner}'`;
}

/**
 * Adds the helper to a local session's environment. `$BROWSER` is overwritten
 * deliberately: a browser command inherited from the server's own environment
 * would open on the server, which is the behaviour this exists to replace.
 */
export function applyLocalHelperEnv(env: Record<string, string | undefined>): void {
  const dir = getLocalHelperDir();
  if (dir === null) return;
  env.PATH = env.PATH === undefined || env.PATH === "" ? dir : `${dir}:${env.PATH}`;
  env.BROWSER = HELPER_NAME;
}
