#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Mateusz T (Tenir)

# Stops and removes a test host container (debian13 unless named), or all of
# them with "all"; images and .dev/test-host stay.
set -eu
if [ "${1:-}" = all ]; then
	names=$(podman ps -a --format '{{.Names}}' | grep '^hopdeck-test-' || true)
else
	names="hopdeck-test-${1:-debian13}"
fi
for name in $names; do
	podman rm -f -t 0 "$name" >/dev/null && echo "Removed $name."
done
