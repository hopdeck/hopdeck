#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Mateusz T (Tenir)

# Removes test VMs that dev/vm-host/up.sh made on the Proxmox host: one
# system's, or all of them; with --templates, their templates too. It removes
# only VMIDs from HOPDECK_PVE_VMID (default 9000) on whose name starts with
# "hopdeck-", whatever else is there.
#
#   dev/vm-host/down.sh [SYSTEM|all] [--templates]
set -eu

# While scripts/test-hosts.sh --vm runs, it alone starts and removes test VMs.
lock="$(cd "$(dirname "$0")/../.." && pwd)/.dev/vm-host/run.lock"
if [ -d "$lock" ] && [ "${HOPDECK_TEST_RUN:-}" != "$(cat "$lock/pid" 2>/dev/null)" ]; then
	echo "a test run is going on (scripts/test-hosts.sh --vm, pid $(cat "$lock/pid" 2>/dev/null || echo unknown)); wait for it to finish" >&2
	exit 2
fi

pve=${HOPDECK_PVE:-pve}
first=${HOPDECK_PVE_VMID:-9000}
repo=$(cd "$(dirname "$0")/../.." && pwd)
what=${1:-debian13}
templates=${2:-}
if [ "$first" -lt 9000 ]; then
	echo "HOPDECK_PVE_VMID must be 9000 or more" >&2
	exit 2
fi
case "$what" in
all) systems="debian11 debian12 debian13 alma9 alma10 alpine openwrt openwrt24" ;;
*) systems=$what ;;
esac

for system in $systems; do
	case "$system" in
	debian11) n=1 ;; debian12) n=2 ;; debian13) n=3 ;; alma9) n=4 ;; alma10) n=5 ;; alpine) n=6 ;; openwrt) n=7 ;; openwrt24) n=8 ;;
	*) echo "unknown system: $system" >&2; exit 2 ;;
	esac
	ids=$((first + 10 + n))
	[ "$templates" = --templates ] && ids="$ids $((first + n))"
	for id in $ids; do
		ssh -o BatchMode=yes "$pve" sh -s "$id" <<'PVE'
set -eu
id=$1
qm status "$id" >/dev/null 2>&1 || exit 0
qm config "$id" | grep -q '^name: hopdeck-' || { echo "VMID $id is not hopdeck's: leaving it alone" >&2; exit 0; }
qm stop "$id" >/dev/null 2>&1 || :
qm destroy "$id" --purge >/dev/null
echo "Removed VM $id."
PVE
	done
	rm -rf "$repo/.dev/vm-host/$system"
done
