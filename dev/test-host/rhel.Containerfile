# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Mateusz T (Tenir)

# A RHEL-compatible host (AlmaLinux: the same packages, nft and paths as RHEL)
# for testing hopdeck over SSH; dev/test-host/up.sh picks the release (alma9,
# alma10) through BASE.
ARG BASE=docker.io/library/almalinux:10
FROM ${BASE}

RUN dnf install -y systemd openssh-server nftables sudo iproute procps-ng \
 && dnf clean all

# The same accounts as on Debian; wheel is RHEL's sudo group.
RUN useradd -m -s /bin/bash -G wheel admin \
 && useradd -m -s /bin/bash nopass \
 && useradd -m -s /bin/bash plain \
 && printf 'admin:hopdeck-test\nplain:hopdeck-test\n' | chpasswd \
 && echo 'nopass ALL=(root) NOPASSWD: /usr/sbin/nft' > /etc/sudoers.d/nopass \
 && chmod 0440 /etc/sudoers.d/nopass

COPY sshd.conf /etc/ssh/sshd_config.d/hopdeck-test.conf

# Like a fresh install with the firewall service on: it loads
# /etc/sysconfig/nftables.conf at boot.
RUN systemctl enable sshd.service nftables.service

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
