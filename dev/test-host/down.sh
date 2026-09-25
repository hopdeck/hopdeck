#!/bin/sh
# Stops and removes the test host container; the image and .dev/test-host stay.
set -eu
podman rm -f nftm-test-host >/dev/null && echo "Test host removed."
