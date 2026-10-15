# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Mateusz T (Tenir)

# An Alpine host for testing hopdeck over SSH: OpenRC instead of systemd,
# BusyBox instead of GNU tools. Start it with dev/test-host/up.sh alpine.
ARG BASE=docker.io/library/alpine:3.22
FROM ${BASE}

RUN apk add --no-cache openrc busybox-openrc openssh nftables sudo iproute2 bash shadow

# OpenRC in a container: no hardware to set up, and services that need the
# network may start, since the container's network is there already.
RUN sed -i 's/^#\?rc_sys=.*/rc_sys="docker"/' /etc/rc.conf \
 && sed -i 's/^#\?rc_provide=.*/rc_provide="loopback net"/' /etc/rc.conf \
 && sed -i '/^tty/d' /etc/inittab \
 && rc-update add syslog boot \
 && rc-update add sshd default \
 && rc-update add nftables default

# The same accounts as on Debian; wheel is Alpine's sudo group. Accounts need a
# password or "*": sshd refuses locked ones ("!"), even for keys.
RUN adduser -D -s /bin/bash admin \
 && adduser -D -s /bin/bash nopass \
 && adduser -D -s /bin/bash plain \
 && addgroup admin wheel \
 && printf 'admin:hopdeck-test\nplain:hopdeck-test\n' | chpasswd \
 && usermod -p '*' nopass \
 && usermod -p '*' root \
 && echo '%wheel ALL=(ALL:ALL) ALL' > /etc/sudoers.d/wheel \
 && echo 'nopass ALL=(root) NOPASSWD: /usr/sbin/nft' > /etc/sudoers.d/nopass \
 && chmod 0440 /etc/sudoers.d/wheel /etc/sudoers.d/nopass

COPY sshd.conf /etc/ssh/sshd_config.d/hopdeck-test.conf

CMD ["/sbin/init"]
