#!/bin/sh
# Loads an .nft file into a throwaway network namespace and prints the
# resulting ruleset as pretty-printed JSON. The host ruleset is not touched.
# Needs unprivileged user namespaces (enabled by default on Debian 11+).
#
#   scripts/nft-json-fixture.sh packages/core/test/fixtures/basic.nft \
#     > packages/core/test/fixtures/basic.json
set -eu

if [ $# -ne 1 ]; then
	echo "usage: $0 FILE.nft" >&2
	exit 2
fi

NFT=${NFT:-$(command -v nft || echo /usr/sbin/nft)}

unshare -rn sh -c '"$1" -f "$2" && "$1" -j list ruleset' sh "$NFT" "$1" |
	node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0, "utf8")), null, 2) + "\n")'
