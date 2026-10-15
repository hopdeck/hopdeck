# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Mateusz T (Tenir)

# A Debian host for testing hopdeck over SSH; dev/test-host/up.sh picks the
# release (debian11, debian12, debian13) through BASE.
ARG BASE=docker.io/library/debian:trixie
FROM ${BASE}

ARG DEBIAN_FRONTEND=noninteractive
# Debian 11 is past its long-term support and its security archive is going
# away, so it installs from the archive as it was at the end of that support.
RUN if grep -q '^VERSION_CODENAME=bullseye' /etc/os-release; then \
	printf '%s\n' \
		'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260815T000000Z bullseye main' \
		'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260815T000000Z bullseye-security main' \
		> /etc/apt/sources.list && rm -f /etc/apt/sources.list.d/*; \
 fi
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv openssh-server nftables sudo iproute2 \
 && rm -rf /var/lib/apt/lists/*

# One account per privilege case hopdeck handles: root logs in directly, admin
# needs its sudo password, nopass may run nft through sudo without one, plain
# may not use sudo at all (it has a password, so sudo can say exactly that).
RUN useradd -m -s /bin/bash -G sudo admin \
 && useradd -m -s /bin/bash nopass \
 && useradd -m -s /bin/bash plain \
 && printf 'admin:hopdeck-test\nplain:hopdeck-test\n' | chpasswd \
 && echo 'nopass ALL=(root) NOPASSWD: /usr/sbin/nft' > /etc/sudoers.d/nopass \
 && chmod 0440 /etc/sudoers.d/nopass

COPY sshd.conf /etc/ssh/sshd_config.d/hopdeck-test.conf

# Like a fresh install: Debian's default /etc/nftables.conf is loaded at boot
# (openssh-server enables its own service).
RUN systemctl enable nftables.service

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
