#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Mateusz T (Tenir)

# Stops and removes the test host container; the image and .dev/test-host stay.
set -eu
podman rm -f hopdeck-test-host >/dev/null && echo "Test host removed."
