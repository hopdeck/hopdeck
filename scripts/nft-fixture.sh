#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Mateusz T (Tenir)

# Loads an .nft file into a throwaway network namespace and writes what nft
# prints for it, next to the input file:
#   NAME.json     nft -j list ruleset, pretty-printed
#   NAME.listing  nft -a list ruleset (text with handles)
# Both come from the same load, so their handles match. The host ruleset is not
# touched. Needs unprivileged user namespaces (enabled by default on Debian 11+).
#
#   scripts/nft-fixture.sh packages/core/test/fixtures/basic.nft
set -eu

if [ $# -ne 1 ]; then
	echo "usage: $0 FILE.nft" >&2
	exit 2
fi

NFT=${NFT:-$(command -v nft || echo /usr/sbin/nft)}
base=${1%.nft}

unshare -rn sh -c '"$1" -f "$2" && "$1" -j list ruleset > "$3.json" && "$1" -a list ruleset > "$3.listing"' \
	sh "$NFT" "$1" "$base"
node -e 'const fs = require("fs"); const p = process.argv[1]; fs.writeFileSync(p, JSON.stringify(JSON.parse(fs.readFileSync(p, "utf8")), null, 2) + "\n")' "$base.json"
