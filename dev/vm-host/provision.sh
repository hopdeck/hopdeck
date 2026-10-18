#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Mateusz T (Tenir)

# Run as root on a test VM by dev/vm-host/up.sh, with the test public key as
# $1: the accounts of hopdeck's test hosts (root; admin, whose sudo wants its
# password; nopass, with sudo for nft alone; plain, without sudo) and sshd
# taking the test key for each. Logins are by key only: the VMs are on a
# real network, so the passwords serve sudo alone. Debian, AlmaLinux, Alpine.
set -eu
key=$1

if command -v apt-get >/dev/null 2>&1; then
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -q >/dev/null
	apt-get install -y -q --no-install-recommends nftables sudo iproute2 >/dev/null
	group=sudo
elif command -v dnf >/dev/null 2>&1; then
	dnf install -y -q nftables sudo iproute >/dev/null
	group=wheel
elif command -v apk >/dev/null 2>&1; then
	apk add -q nftables sudo iproute2 bash shadow
	group=wheel
	echo '%wheel ALL=(ALL:ALL) ALL' >/etc/sudoers.d/wheel
	chmod 0440 /etc/sudoers.d/wheel
	# Kernel messages in /var/log/messages, as a syslog file source of the packet log.
	rc-update add syslog boot >/dev/null 2>&1 || :
	rc-update add klogd boot >/dev/null 2>&1 || :
	rc-service syslog start >/dev/null 2>&1 || :
	rc-service klogd start >/dev/null 2>&1 || :
else
	echo 'no apt-get, dnf or apk here' >&2
	exit 1
fi

for account in admin nopass plain; do
	id "$account" >/dev/null 2>&1 || useradd -m -s /bin/bash "$account"
done
usermod -aG "$group" admin
printf 'admin:hopdeck-test\nplain:hopdeck-test\n' | chpasswd
# No password, but not locked: sshd without PAM (Alpine) turns locked accounts away.
usermod -p '*' nopass
echo 'nopass ALL=(root) NOPASSWD: /usr/sbin/nft' >/etc/sudoers.d/nopass
chmod 0440 /etc/sudoers.d/nopass

printf '%s\n' "$key" >/etc/ssh/hopdeck_authorized_keys
chmod 644 /etc/ssh/hopdeck_authorized_keys
command -v restorecon >/dev/null 2>&1 && restorecon /etc/ssh/hopdeck_authorized_keys
# cloud-init's key for root may only say to log in as another user; the file above lets root in.
rm -f /root/.ssh/authorized_keys
mkdir -p /etc/ssh/sshd_config.d
grep -q '^Include /etc/ssh/sshd_config.d/' /etc/ssh/sshd_config || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
cat >/etc/ssh/sshd_config.d/00-hopdeck-test.conf <<'CONF'
# hopdeck test VM: key logins only, with the test key accepted for every account.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
AuthorizedKeysFile .ssh/authorized_keys /etc/ssh/hopdeck_authorized_keys
CONF
sshd -t

if command -v systemctl >/dev/null 2>&1; then
	systemctl reload ssh 2>/dev/null || systemctl reload sshd
	systemctl enable --now nftables.service >/dev/null 2>&1
else
	rc-service sshd reload >/dev/null
	# Alpine's /etc/nftables.nft drops what comes in and what passes through,
	# so its admin lets SSH in: here, in a file it includes. Its forward chain
	# lets the network of the port forward test through, the hd* interfaces,
	# where hopdeck's own table decides.
	cat >/etc/nftables.d/00-hopdeck-test.nft <<'NFT'
table inet filter {
	chain input {
		tcp dport 22 accept comment "hopdeck test VM: SSH"
	}
	chain forward {
		iifname "hd*" accept comment "hopdeck test VM: the port forward test's network"
	}
}
NFT
	rc-update add nftables default >/dev/null 2>&1 || :
	rc-service nftables restart >/dev/null
fi
echo "$(uname -r), $(nft --version)"
