#!/bin/sh
# webterm-open — open a URL in the browser that is viewing this terminal,
# instead of on the machine the terminal is running on.
#
# Nobody installs this by hand. It is embedded in the server (imported as text
# by src/openHelper.ts) and planted into every session automatically: into a
# private directory for local shells, and into ~/.cache/mywebterm/bin over the
# ssh command line for remote ones. Both get it on $PATH with $BROWSER pointed
# at it, so xdg-open, gh, python -m webbrowser and anything else that launches
# a browser ends up here.
#
# It prints OSC 1338 to the controlling terminal; the MyWebTerm client picks
# that up and offers to open the URL in a new tab. Other terminals ignore the
# sequence, so an inherited BROWSER does no harm elsewhere.
#
# Keep this POSIX sh: it runs on whatever the far side happens to have.

set -eu

url=${1-}
if [ -z "$url" ]; then
  echo "usage: webterm-open <url>" >&2
  exit 2
fi

case $url in
  http://* | https://*) ;;
  *)
    echo "webterm-open: only http(s) URLs are supported: $url" >&2
    exit 2
    ;;
esac

# Printable ASCII only. The client re-validates, but a URL carrying control
# characters is never something worth forwarding.
case $url in
  *[!\ -~]* | *" "*)
    echo "webterm-open: URL contains spaces or control characters" >&2
    exit 2
    ;;
esac

esc=$(printf '\033')
bel=$(printf '\007')
seq="${esc}]1338;${url}${bel}"

# tmux and screen swallow OSC sequences they do not understand unless the
# sequence is wrapped in a DCS passthrough. tmux additionally needs
# `set -g allow-passthrough on`.
case ${TERM-} in
  screen* | tmux*)
    if [ -n "${TMUX-}" ]; then
      seq="${esc}Ptmux;${esc}${seq}${esc}\\"
    else
      seq="${esc}P${seq}${esc}\\"
    fi
    ;;
esac

# Write to the terminal rather than stdout: callers such as `gh auth login`
# capture stdout, which would swallow the sequence.
#
# /dev/tty is the right target, but it is not always reachable. Launchers built
# on the npm `open` package (Shopify CLI, Vite, storybook, ...) spawn the
# browser with `detached: true, stdio: 'ignore'` — setsid() leaves the process
# with no controlling terminal, so /dev/tty cannot be opened and stdout is
# /dev/null. The pty is still open, just held by an ancestor, so fall back to
# $WEBTERM_TTY and then to an ancestor's file descriptors.
#
# Each write runs in a subshell so that a redirection failure fails the command
# instead of killing the shell (POSIX special-builtin rules).
write_to() {
  [ -c "$1" ] || return 1
  ( printf '%s' "$seq" > "$1" ) 2> /dev/null
}

# Only a terminal is worth writing to. An ancestor's fd 1 pointing at /dev/null
# is a character device too, and would swallow the sequence silently.
is_terminal() {
  case $(readlink "$1" 2> /dev/null) in
    /dev/pts/[0-9]* | /dev/tty[0-9]* | /dev/ttyS[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

write_seq() {
  write_to /dev/tty && return 0

  # Set by hand where /proc is unavailable: export WEBTERM_TTY="$(tty)".
  if [ -n "${WEBTERM_TTY-}" ] && write_to "$WEBTERM_TTY"; then
    return 0
  fi

  # Walk up the process tree looking for a live terminal. The launcher that
  # spawned us is normally still running and still holding the pty.
  pid=$$
  depth=0
  while [ "$depth" -lt 16 ]; do
    pid=$(awk '/^PPid:/ { print $2 }' "/proc/$pid/status" 2> /dev/null) || return 1
    [ -n "$pid" ] && [ "$pid" != 0 ] || return 1
    for fd in 2 1 0; do
      if is_terminal "/proc/$pid/fd/$fd" && write_to "/proc/$pid/fd/$fd"; then
        return 0
      fi
    done
    depth=$((depth + 1))
  done
  return 1
}

write_seq || printf '%s' "$seq"
