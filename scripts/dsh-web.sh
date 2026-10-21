#!/bin/sh
# Start the DSH web host with its stdout/stderr captured in a log file.
# The Host prints plugin load failures and stack traces to stdout; without this
# wrapper they only exist in the terminal scrollback.
set -eu
log="${DSH_LOG:-$HOME/.dsh/dsh.log}"
mkdir -p "$(dirname "$log")"
printf 'dsh-web: logging to %s\n' "$log" >&2
"${DSH_BIN:-dsh}" web "$@" 2>&1 | tee -a "$log"
