#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Mateusz T (Tenir)

# Runs the tests that need a remote host against each test host system in
# turn, then sums up. Each host is started with dev/test-host/up.sh and
# removed afterwards; logs go to .dev/test-host/logs. With --vm, the hosts are
# virtual machines on a Proxmox host instead, from dev/vm-host (whose
# templates stay), and the logs go to .dev/vm-host/logs.
#
#   scripts/test-hosts.sh [--vm] [SYSTEM...]   (default: all of them)
set -u

repo=$(cd "$(dirname "$0")/.." && pwd)
kind=test-host
if [ "${1:-}" = --vm ]; then
	kind=vm-host
	shift
fi
if [ "$kind" = vm-host ]; then
	systems=${*:-debian11 debian12 debian13 alma9 alma10 alpine openwrt openwrt24}
else
	systems=${*:-debian11 debian12 debian13 alma9 alma10 alpine openwrt}
fi
logs="$repo/.dev/$kind/logs"
mkdir -p "$logs"

# One run at a time: two would start and remove the same containers under each
# other. up.sh and down.sh refuse to work by hand while the lock is there.
lock="$repo/.dev/$kind/run.lock"
if ! mkdir "$lock" 2>/dev/null; then
	echo "another test run is going on (pid $(cat "$lock/pid" 2>/dev/null || echo unknown)); if it is not, remove $lock" >&2
	exit 2
fi
echo $$ >"$lock/pid"
trap 'rm -rf "$lock"' EXIT INT TERM
export HOPDECK_TEST_RUN=$$
tests="packages/server/src/hosts/host-keys.test.ts packages/server/src/hosts/key-login.test.ts packages/server/src/hosts/usage.test.ts packages/server/src/firewall packages/server/src/openwrt"
summary=""
failed=0

for system in $systems; do
	echo "== $system"
	if ! "$repo/dev/$kind/up.sh" "$system" >"$logs/$system-up.log" 2>&1; then
		summary="$summary$system: the host did not start, see .dev/$kind/logs/$system-up.log\n"
		failed=1
		# What started of it goes too; the log says why the rest did not.
		"$repo/dev/$kind/down.sh" "$system" >/dev/null
		continue
	fi
	if (cd "$repo" && HOPDECK_TEST_HOST=1 HOPDECK_TEST_HOST_DIR="$repo/.dev/$kind/$system" \
		pnpm exec vitest run --no-file-parallelism $tests) >"$logs/$system.log" 2>&1; then
		result=passed
	else
		result=FAILED
		failed=1
	fi
	counts=$(grep -E '^ +Tests ' "$logs/$system.log" | tail -n 1 | sed 's/^ *Tests *//')
	summary="$summary$system: $result ($counts), see .dev/$kind/logs/$system.log\n"
	"$repo/dev/$kind/down.sh" "$system" >/dev/null
done

printf '\n%b' "$summary"
exit "$failed"
