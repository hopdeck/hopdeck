#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Mateusz T (Tenir)

# Stops and removes a test host container (debian13 unless named), or all of
# them with "all"; images and .dev/test-host stay.
set -eu

# While scripts/test-hosts.sh runs, it alone starts and removes test hosts.
lock="$(cd "$(dirname "$0")/../.." && pwd)/.dev/test-host/run.lock"
if [ -d "$lock" ] && [ "${HOPDECK_TEST_RUN:-}" != "$(cat "$lock/pid" 2>/dev/null)" ]; then
	echo "a test run is going on (scripts/test-hosts.sh, pid $(cat "$lock/pid" 2>/dev/null || echo unknown)); wait for it to finish" >&2
	exit 2
fi
if [ "${1:-}" = all ]; then
	names=$(podman ps -a --format '{{.Names}}' | grep '^hopdeck-test-' || true)
else
	names="hopdeck-test-${1:-debian13}"
fi
for name in $names; do
	podman rm -f -t 0 "$name" >/dev/null && echo "Removed $name."
done
