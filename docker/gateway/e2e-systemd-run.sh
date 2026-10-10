#!/bin/sh
# J393 e2e: stands in for `systemd-run --user --wait --pipe …` (the test relay has no user bus): applies --setenv, then runs the command
while [ $# -gt 0 ]; do case "$1" in --setenv=*) export "${1#--setenv=}";; --*) ;; *) break;; esac; shift; done
echo "$@" >> "$E2E_DIR/handoffs"; exec "$@"
