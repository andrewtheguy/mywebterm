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

// Where the helper lands on a remote host, best first.
//
// $XDG_RUNTIME_DIR is the ephemeral choice: user-private, mode 0700, and torn
// down by logind when the user's last session ends, so ssh'ing somewhere leaves
// nothing behind. It does not exist everywhere (no logind, macOS), hence the
// cache fallback — a fixed path either way, so repeat sessions overwrite one
// file instead of accumulating per-session directories. Cleaning up on exit
// instead is not an option: the bootstrap ends in exec, which discards traps,
// and the sessions that matter end by network drop, where no trap runs anyway.
//
// /tmp is deliberately not in this list: it is mounted noexec often enough that
// the helper would silently fail to run.
const REMOTE_DIRS = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
  "${XDG_RUNTIME_DIR}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
  "${XDG_CACHE_HOME:-$HOME/.cache}",
];

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
  // Writing the file is not proof it can run — a noexec mount refuses only at
  // exec time. Calling it with no arguments is the cheap check: it answers 2,
  // where a filesystem that will not run it answers 126.
  const install = [
    // Guard the empty case: unset $XDG_RUNTIME_DIR would otherwise aim at
    // /mywebterm/bin, which a root session would happily create.
    `i() { [ -n "$1" ] || return 1; d=$1/mywebterm/bin;`,
    `mkdir -p "$d" 2>/dev/null &&`,
    `printf %s ${payload} | base64 -d > ${target} 2>/dev/null &&`,
    `chmod 700 ${target} 2>/dev/null || return 1;`,
    `${target} >/dev/null 2>&1;`,
    "[ $? -eq 2 ]; };",
  ].join(" ");
  const attempts = REMOTE_DIRS.map((dir) => `i "${dir}"`).join(" || ");
  const inner = [
    install,
    `if ${attempts}; then`,
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
