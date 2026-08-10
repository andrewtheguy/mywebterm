#!/bin/sh
# webterm-open — open a URL in the browser that is viewing this terminal,
# instead of on the machine the terminal is running on.
#
# Nobody installs this by hand. It is embedded in the server (imported as text
# by src/openHelper.ts) and planted into every session automatically: into a
# private directory for local shells, and into ~/.cache/mywebterm/bin over the
# ssh command line for remote ones. Both point $BROWSER at it by absolute path
# — $PATH does not survive a login shell — so xdg-open, gh, python -m webbrowser
# and anything else that launches a browser ends up here.
#
# It prints OSC 1338 to the terminal MyWebTerm is showing; the client picks that
# up and offers to open the URL in a new tab. Other terminals ignore the
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
raw="${esc}]1338;${url}${bel}"

# Inside a multiplexer, the terminal behind /dev/tty is the *pane*, not the one
# MyWebTerm is showing, and the pane's owner decides what reaches the outside:
# tmux and screen forward an unknown sequence only when it is wrapped in a DCS
# passthrough (tmux additionally needs `set -g allow-passthrough on`), and
# zellij drops it whatever the wrapping — raw, DCS and DCS-tmux were all
# measured to vanish, and it has no passthrough option (zellij-org/zellij#3954).
#
# So the pane is the fallback, not the target: write to the outer terminal
# directly where it can be found. $pane carries the wrapping that gives the
# sequence its best chance of escaping if we end up there anyway.
#
# Detection goes by $TMUX/$ZELLIJ before $TERM, since both leave $TERM free to
# be configured — zellij's default is plain xterm-256color.
in_mux=0
pane=$raw
if [ -n "${TMUX-}" ]; then
  in_mux=1
  pane="${esc}Ptmux;${esc}${raw}${esc}\\"
elif [ -n "${ZELLIJ-}" ]; then
  in_mux=1
else
  case ${TERM-} in
    screen* | tmux*)
      in_mux=1
      pane="${esc}P${raw}${esc}\\"
      ;;
  esac
fi

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
  [ -n "$1" ] && [ -c "$1" ] || return 1
  ( printf '%s' "$2" > "$1" ) 2> /dev/null
}

# The terminal MyWebTerm is attached to, for when /dev/tty is only a pane.
#
# $WEBTERM_TTY is exported by the session bootstrap, so a multiplexer server
# started from within the session hands it down to every pane. A server that was
# already running (`zellij attach` to a session created in another terminal)
# hands down whatever it was started with instead, so the value can be stale —
# which is why tmux is asked directly first: its answer names the client
# attached right now. $SSH_TTY is sshd's own record of the same pty.
outer_ttys() {
  if [ -n "${TMUX-}" ]; then
    tmux display-message -p '#{client_tty}' 2> /dev/null || :
  fi
  if [ -n "${WEBTERM_TTY-}" ]; then
    echo "$WEBTERM_TTY"
  fi
  if [ -n "${SSH_TTY-}" ]; then
    echo "$SSH_TTY"
  fi
  :
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
  # Only ahead of /dev/tty inside a multiplexer, where the pane would accept the
  # write and quietly drop it. Outside one, /dev/tty is already the right
  # terminal and a stale $WEBTERM_TTY would send the toast to another window.
  if [ "$in_mux" = 1 ]; then
    for outer in $(outer_ttys); do
      write_to "$outer" "$raw" && return 0
    done
  fi

  write_to /dev/tty "$pane" && return 0

  # Set by hand where /proc is unavailable: export WEBTERM_TTY="$(tty)".
  if [ -n "${WEBTERM_TTY-}" ] && write_to "$WEBTERM_TTY" "$pane"; then
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
      if is_terminal "/proc/$pid/fd/$fd" && write_to "/proc/$pid/fd/$fd" "$pane"; then
        return 0
      fi
    done
    depth=$((depth + 1))
  done
  return 1
}

write_seq || printf '%s' "$pane"
