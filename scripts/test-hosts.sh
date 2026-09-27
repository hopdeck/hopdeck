#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Mateusz T (Tenir)

# Runs the tests that need a remote host against each test host system in
# turn, then sums up. Each host is started with dev/test-host/up.sh and
# removed afterwards; logs go to .dev/test-host/logs.
#
#   scripts/test-hosts.sh [SYSTEM...]   (default: all of them)
set -u

repo=$(cd "$(dirname "$0")/.." && pwd)
systems=${*:-debian11 debian12 debian13 alma9 alma10 alpine openwrt}
logs="$repo/.dev/test-host/logs"
mkdir -p "$logs"

# One run at a time: two would start and remove the same containers under each
# other. up.sh and down.sh refuse to work by hand while the lock is there.
lock="$repo/.dev/test-host/run.lock"
if ! mkdir "$lock" 2>/dev/null; then
	echo "another test run is going on (pid $(cat "$lock/pid" 2>/dev/null || echo unknown)); if it is not, remove $lock" >&2
	exit 2
fi
echo $$ >"$lock/pid"
trap 'rm -rf "$lock"' EXIT INT TERM
export HOPDECK_TEST_RUN=$$
tests="packages/server/src/hosts/host-keys.test.ts packages/server/src/hosts/key-login.test.ts packages/server/src/hosts/usage.test.ts packages/server/src/firewall"
summary=""
failed=0

for system in $systems; do
	echo "== $system"
	if ! "$repo/dev/test-host/up.sh" "$system" >"$logs/$system-up.log" 2>&1; then
		summary="$summary$system: the host did not start, see .dev/test-host/logs/$system-up.log\n"
		failed=1
		continue
	fi
	if (cd "$repo" && HOPDECK_TEST_HOST=1 HOPDECK_TEST_HOST_DIR="$repo/.dev/test-host/$system" \
		pnpm exec vitest run --no-file-parallelism $tests) >"$logs/$system.log" 2>&1; then
		result=passed
	else
		result=FAILED
		failed=1
	fi
	counts=$(grep -E '^ +Tests ' "$logs/$system.log" | tail -n 1 | sed 's/^ *Tests *//')
	summary="$summary$system: $result ($counts), see .dev/test-host/logs/$system.log\n"
	"$repo/dev/test-host/down.sh" "$system" >/dev/null
done

printf '\n%b' "$summary"
exit "$failed"
