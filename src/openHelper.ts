// Planting `webterm-open` on the far side of every session.
//
// Clicking a URL in the output is handled entirely in the browser, but a
// program that *launches* a browser itself (`gh auth login`, `xdg-open`,
// Shopify CLI's preview shortcut) runs on the session's host and needs a
// command there to run. The server can't reach into that host after the fact,
// so it plants the helper as the session starts: a fixed, user-private
// directory named by $BROWSER for local shells, and a base64 payload carried
// over the ssh command line for remote ones. Nothing is installed by hand on
// any host.

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
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
// Both candidates must expand to nothing rather than to a root-relative path
// when their variables are unset, so the empty-argument guard in the bootstrap
// can reject them: a plain $HOME/.cache would become /.cache, which a root
// session would create.
export const REMOTE_DIRS = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
  "${XDG_RUNTIME_DIR}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
  "${XDG_CACHE_HOME:-${HOME:+$HOME/.cache}}",
];

// Every session records the pty it was handed, so that a multiplexer started
// inside it passes the address of the real terminal down to its panes.
//
// `tty` answers "not a tty" on stdout as well as non-zero on status, so failure
// has to clear the variable rather than leave it holding that sentence — and
// clear it outright, since an inherited value (a nested session, or an ssh that
// forwards it) would otherwise survive and point the helper at some other
// terminal.
const TTY_EXPORT = "WEBTERM_TTY=$(tty) && export WEBTERM_TTY || unset WEBTERM_TTY;";

/**
 * Where the helper lands locally, best first — the same preference the remote
 * bootstrap applies in shell, for the same reasons (see REMOTE_DIRS).
 *
 * The path is fixed rather than unique per run, because things outside this
 * process remember it. A tmux server started inside a session copies $BROWSER
 * into its own environment and hands that copy to panes for the rest of its
 * life; a per-run mkdtemp would leave those panes pointing at a directory that
 * was deleted the next time mywebterm restarted, and $BROWSER failing is silent
 * — xdg-open reports "no method available" and opens nothing.
 */
function localCandidates(env: Record<string, string | undefined>): string[] {
  const dirs: string[] = [];
  if (env.XDG_RUNTIME_DIR) dirs.push(env.XDG_RUNTIME_DIR);
  if (env.XDG_CACHE_HOME) dirs.push(env.XDG_CACHE_HOME);
  else if (env.HOME) dirs.push(join(env.HOME, ".cache"));
  // Last resort, for a server running without a home or a runtime dir. Named by
  // uid because /tmp is shared: a fixed path someone else owns is one this user
  // cannot write, and falling back is better than failing.
  dirs.push(join(tmpdir(), `mywebterm-${userInfo().uid}`));
  return dirs.map((dir) => join(dir, "mywebterm", "bin"));
}

/**
 * Whether what is already installed is what we would write. The path is fixed,
 * so most startups find their own work from last time — and rewriting it would
 * be worse than pointless: on Linux, writing to a file another process is
 * executing fails with ETXTBSY, and a second mywebterm instance serving
 * sessions is exactly when that happens.
 */
function alreadyInstalled(path: string): boolean {
  try {
    return (statSync(path).mode & 0o777) === 0o700 && readFileSync(path, "utf8") === helperSource;
  } catch {
    return false;
  }
}

/**
 * Writing the helper is not proof it can run: a noexec mount accepts the file
 * and refuses only at exec time. Calling it with no arguments is the cheap
 * check — it answers 2, where a filesystem that will not run it answers 126.
 */
function canExecute(path: string): boolean {
  try {
    return Bun.spawnSync([path], { stdout: "ignore", stderr: "ignore" }).exitCode === 2;
  } catch {
    return false;
  }
}

let localHelperDir: string | null = null;

/**
 * Writes the helper somewhere local shells can reach it. Returns the directory
 * to prepend to $PATH, or null if nowhere worked — a session without the helper
 * is still a working session, so this never throws.
 */
export function provisionLocalHelper(): string | null {
  if (localHelperDir !== null) return localHelperDir;
  for (const dir of localCandidates(process.env)) {
    try {
      // 0700 throughout: the helper is executable, so keep it to this user.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, HELPER_NAME);
      if (!alreadyInstalled(path)) {
        writeFileSync(path, helperSource);
        chmodSync(path, 0o700); // writeFileSync's mode is subject to umask; this is not.
      }
      if (!canExecute(path)) continue;
      localHelperDir = dir;
      return dir;
    } catch {
      // Try the next candidate; the last failure is the one worth reporting.
    }
  }
  console.error(`Could not install ${HELPER_NAME}, browser-opening from local shells will not work`);
  return null;
}

export function getLocalHelperDir(): string | null {
  return localHelperDir;
}

/**
 * Removes the installed helper. Safe to call when nothing was written.
 *
 * Deliberately not wired to process exit. The path is fixed and shared, so an
 * instance shutting down would pull the helper out from under a second instance
 * still serving sessions — and out from under any tmux server holding the path
 * in its copy of $BROWSER. One file left behind is the cheaper mistake, which is
 * the same trade the remote bootstrap makes.
 */
export function removeLocalHelper(): void {
  if (localHelperDir === null) return;
  try {
    rmSync(join(localHelperDir, HELPER_NAME), { force: true });
  } catch {
    // Nothing depends on this succeeding; a leftover file is not worth a message.
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
    // Absolute, because $PATH does not survive what comes next: a login shell
    // sources /etc/profile, which on Debian assigns $PATH outright rather than
    // adding to it. $BROWSER is left alone, and is what the launchers read.
    `BROWSER=${target};`,
    "export PATH BROWSER;",
    "fi;",
    // Recorded before the multiplexers get a chance to hide it: inside a zellij
    // or tmux pane /dev/tty is the pane, and this is the only pointer back to
    // the terminal MyWebTerm is actually showing.
    TTY_EXPORT,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
    'exec "${SHELL:-/bin/sh}" -l',
  ].join(" ");
  return `/bin/sh -c '${inner}'`;
}

/**
 * Wraps a local session's command so it records its pty before becoming the
 * shell. `exec` keeps the wrapper from outliving the assignment, so the session
 * still consists of exactly the process that was asked for.
 */
export function wrapLocalCommand(command: string[]): string[] {
  return ["/bin/sh", "-c", `${TTY_EXPORT} exec "$@"`, "sh", ...command];
}

/**
 * Adds the helper to a local session's environment. `$BROWSER` is overwritten
 * deliberately: a browser command inherited from the server's own environment
 * would open on the server, which is the behaviour this exists to replace.
 *
 * It holds the absolute path rather than the bare name because `$PATH` is not
 * dependable — any login shell in the session, such as the one tmux gives each
 * new pane, sources /etc/profile and has its `$PATH` replaced wholesale. The
 * directory is still prepended for shells that keep it, so the command can also
 * be typed by hand.
 */
export function applyLocalHelperEnv(env: Record<string, string | undefined>): void {
  const dir = getLocalHelperDir();
  if (dir === null) return;
  env.PATH = env.PATH === undefined || env.PATH === "" ? dir : `${dir}:${env.PATH}`;
  env.BROWSER = join(dir, HELPER_NAME);
}
