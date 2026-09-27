# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Mateusz T (Tenir)

# An OpenWrt host for testing hopdeck over SSH: procd, dropbear, BusyBox, and
# the firewall as fw4 makes it from UCI. Root is the only account, as on a
# router. Start it with dev/test-host/up.sh openwrt.
ARG BASE=docker.io/openwrt/rootfs:x86-64-openwrt-24.10
FROM ${BASE}

# The container's interface is the LAN, configured by DHCP from podman, so its
# address stays the one podman forwards to, and fw4's LAN zone lets SSH in.
RUN printf "config interface 'loopback'\n\toption device 'lo'\n\toption proto 'static'\n\toption ipaddr '127.0.0.1'\n\toption netmask '255.0.0.0'\n\nconfig interface 'lan'\n\toption device 'eth0'\n\toption proto 'dhcp'\n" > /etc/config/network

# The key setup logs in with root's password once; dropbear takes passwords as
# OpenWrt ships it.
RUN printf 'hopdeck-test\nhopdeck-test\n' | passwd root

CMD ["/sbin/init"]
