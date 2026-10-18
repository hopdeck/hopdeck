#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Mateusz T (Tenir)

# Starts a test host as a virtual machine on a Proxmox VE host, for what the
# containers of dev/test-host cannot test: their kernel is this machine's,
# and it writes no packets to its log from a container, nor forwards between
# hosts. A VM has its own kernel: Debian 11's 5.10, RHEL 9's 5.14 and so on.
#
#   dev/vm-host/up.sh [SYSTEM]   debian11 debian12 debian13 (the default)
#                                alma9 alma10 alpine openwrt openwrt24
#
# HOPDECK_PVE is how ssh reaches the Proxmox host (default "pve"; root),
# HOPDECK_PVE_VMID the first of the VMIDs this may use (default 9000; never
# lower): a template at VMID+N per system, its VM at VMID+10+N. The VM gets
# its address by DHCP on HOPDECK_PVE_BRIDGE (default vmbr0), read from its
# serial console, as is its host key, which is checked against what it then
# presents. The state for hopdeck and the host tests goes to .dev/vm-host/SYSTEM.
#
# The bridge is a real network, so logins are by key only. An OpenWrt VM
# would also serve DHCP and router advertisements on it as it ships: it boots
# without a network card first, is made a DHCP client that serves nothing
# through its serial console, and only then gets one.
set -eu

# While scripts/test-hosts.sh --vm runs, it alone starts and removes test VMs.
lock="$(cd "$(dirname "$0")/../.." && pwd)/.dev/vm-host/run.lock"
if [ -d "$lock" ] && [ "${HOPDECK_TEST_RUN:-}" != "$(cat "$lock/pid" 2>/dev/null)" ]; then
	echo "a test run is going on (scripts/test-hosts.sh --vm, pid $(cat "$lock/pid" 2>/dev/null || echo unknown)); wait for it to finish" >&2
	exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
system=${1:-debian13}
pve=${HOPDECK_PVE:-pve}
first=${HOPDECK_PVE_VMID:-9000}
bridge=${HOPDECK_PVE_BRIDGE:-vmbr0}
storage=${HOPDECK_PVE_STORAGE:-local-lvm}
init=systemd
platform=linux
memory=512
cpu=
debian=https://cloud.debian.org/images/cloud
alma=https://repo.almalinux.org/almalinux
openwrt=https://downloads.openwrt.org/releases
case "$system" in
debian11) n=1 url=$debian/bullseye/latest/debian-11-genericcloud-amd64.qcow2 sums=$debian/bullseye/latest/SHA512SUMS sum=sha512 ;;
debian12) n=2 url=$debian/bookworm/latest/debian-12-genericcloud-amd64.qcow2 sums=$debian/bookworm/latest/SHA512SUMS sum=sha512 ;;
debian13) n=3 url=$debian/trixie/latest/debian-13-genericcloud-amd64.qcow2 sums=$debian/trixie/latest/SHA512SUMS sum=sha512 ;;
# RHEL 9 and 10 want x86-64-v2 at least, more than Proxmox's default CPU model offers.
alma9) n=4 url=$alma/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2 sums=$alma/9/cloud/x86_64/images/CHECKSUM sum=sha256 memory=1024 cpu=x86-64-v2-AES ;;
alma10) n=5 url=$alma/10/cloud/x86_64_v2/images/AlmaLinux-10-GenericCloud-latest.x86_64_v2.qcow2 sums=$alma/10/cloud/x86_64_v2/images/CHECKSUM sum=sha256 memory=1024 cpu=x86-64-v2-AES ;;
alpine)
	n=6 init=openrc
	url=https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/cloud/nocloud_alpine-3.22.4-x86_64-bios-cloudinit-r0.qcow2
	sums=$url.sha512 sum=sha512
	;;
openwrt | openwrt24)
	if [ "$system" = openwrt ]; then n=7 release=25.12.5; else n=8 release=24.10.8; fi
	init=procd platform=openwrt memory=128
	url=$openwrt/$release/targets/x86/64/openwrt-$release-x86-64-generic-ext4-combined.img.gz
	sums=$openwrt/$release/targets/x86/64/sha256sums sum=sha256
	;;
*)
	echo "unknown system: $system (debian11, debian12, debian13, alma9, alma10, alpine, openwrt, openwrt24)" >&2
	exit 2
	;;
esac
if [ "$first" -lt 9000 ]; then
	echo "HOPDECK_PVE_VMID must be 9000 or more: the VMIDs below are the Proxmox host's own" >&2
	exit 2
fi
template=$((first + n))
vm=$((first + 10 + n))
file=${url##*/}
# What Proxmox imports the disk from: OpenWrt's is a gzipped raw image.
image=$file
case "$file" in *.img.gz) image=${file%.img.gz}.raw ;; esac
keys="$repo/.dev/test-host"
state="$repo/.dev/vm-host/$system"
mkdir -p "$state/config"
[ -f "$keys/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C hopdeck-test -f "$keys/id_ed25519"
[ -f "$keys/other_host_key" ] || ssh-keygen -q -t ed25519 -N '' -C hopdeck-test-other -f "$keys/other_host_key"
key=$(cat "$keys/id_ed25519.pub")
on_pve() { ssh -o BatchMode=yes "$pve" "$@"; }

echo "The image ($file), checked against its $sum sum..."
on_pve sh -s "$url" "$sums" "$sum" "$image" <<'PVE'
set -eu
cd /var/lib/vz/import
name=$(basename "$1")
[ -f "$4" ] && exit 0
wget -q -O "$name.part" "$1"
wget -q -O "$name.sums" "$2"
expected=$(awk -v f="$name" '$2 == f || $2 == "*" f || NF == 1 { print $1; exit }' "$name.sums")
[ -n "$expected" ] || { echo "no sum for $name in $2" >&2; exit 1; }
echo "$expected  $name.part" | "${3}sum" -c - >/dev/null
if [ "$name" = "$4" ]; then
	mv "$name.part" "$4"
else
	# Padding follows the data in OpenWrt's images, which gzip warns of with status 2.
	gzip -d -c -q "$name.part" >"$4.part" || [ $? -eq 2 ]
	mv "$4.part" "$4"
	rm -f "$name.part"
fi
PVE

echo "The template, VMID $template..."
if [ "$platform" = openwrt ]; then
	# No network card, and no cloud-init: OpenWrt has none.
	on_pve sh -s "$template" "$system" "$image" "$storage" <<'PVE'
set -eu
id=$1
qm status "$id" >/dev/null 2>&1 && exit 0
qm create "$id" --name "hopdeck-tpl-$2" --description "hopdeck test template ($2), made by dev/vm-host/up.sh" \
	--memory 128 --cores 1 --ostype l26 --virtio0 "$4:0,import-from=local:import/$3" --boot order=virtio0 \
	--serial0 socket --vga serial0 >/dev/null
qm template "$id" >/dev/null
PVE
else
	on_pve sh -s "$template" "$system" "$image" "$bridge" "$storage" "\"$key\"" <<'PVE'
set -eu
id=$1
qm status "$id" >/dev/null 2>&1 && exit 0
printf '%s\n' "$6" >/root/hopdeck-test.pub
qm create "$id" --name "hopdeck-tpl-$2" --description "hopdeck test template ($2), made by dev/vm-host/up.sh" \
	--memory 512 --cores 1 --ostype l26 --net0 "virtio,bridge=$4" \
	--scsihw virtio-scsi-single --scsi0 "$5:0,import-from=local:import/$3" \
	--ide2 "$5:cloudinit" --boot order=scsi0 --serial0 socket --vga serial0 \
	--ciuser root --sshkeys /root/hopdeck-test.pub --ipconfig0 ip=dhcp --ciupgrade 0 >/dev/null
# Room for the packages; a disk larger already (AlmaLinux's 10 GB) stays as it is.
size=$(qm config "$id" | sed -n 's/^scsi0:.*size=\([0-9]*\)G.*/\1/p')
[ "${size:-0}" -ge 4 ] || qm disk resize "$id" scsi0 4G >/dev/null
qm template "$id" >/dev/null
PVE
fi

echo "The VM, VMID $vm, a linked clone of it..."
on_pve sh -s "$template" "$vm" "$system" "$memory" "\"$cpu\"" <<'PVE'
set -eu
template=$1 id=$2
if qm status "$id" >/dev/null 2>&1; then
	qm config "$id" | grep -q '^name: hopdeck-' || { echo "VMID $id is not hopdeck's: leaving it alone" >&2; exit 1; }
	qm stop "$id" >/dev/null 2>&1 || :
	qm destroy "$id" --purge >/dev/null
fi
qm clone "$template" "$id" --name "hopdeck-$3" --description "hopdeck test VM ($3), made by dev/vm-host/up.sh" >/dev/null
qm set "$id" --memory "$4" --cores 1 ${5:+--cpu "$5"} >/dev/null
PVE

if [ "$platform" = openwrt ]; then
	console=$(on_pve sh -s "$vm" "$bridge" "\"$key\"" <<'PVE'
set -eu
id=$1 bridge=$2 key=$3
sock=/var/run/qemu-server/$id.serial0
out=/tmp/hopdeck-$id.console
in=/tmp/hopdeck-$id.in
reader=
# Waits until the console has shown what $1 matches, for $2 seconds at most.
wait_for() {
	i=0
	until tr -d '\r' <"$out" | grep -a -q -E -- "$1"; do
		i=$((i + 1))
		if [ "$i" -ge "$2" ]; then
			echo "the console of VM $id did not show \"$1\" within $2 seconds (see $out on the Proxmox host)" >&2
			stop
			exit 1
		fi
		sleep 1
	done
}
# Starts the VM with its console open: what it shows goes to $out, typed lines go to fd 3.
boot() {
	qm start "$id"
	for i in $(seq 1 40); do [ -S "$sock" ] && break; sleep 0.5; done
	: >"$out"
	rm -f "$in"
	mkfifo "$in"
	timeout 600 socat STDIO "UNIX-CONNECT:$sock" <"$in" >>"$out" 2>/dev/null &
	reader=$!
	exec 3>"$in"
	wait_for 'Please press Enter to activate this console' 180
	printf '\r' >&3
	# BusyBox's line editing asks the terminal where its cursor is, and may take
	# the first keys typed for the answer: type until the shell answers.
	for i in $(seq 1 15); do
		printf 'echo "@@rea""dy"\r' >&3
		sleep 1
		tr -d '\r' <"$out" | grep -a -q '@@ready' && break
	done
	wait_for '@@ready' 5
}
type_lines() { while IFS= read -r line; do printf '%s\r' "$line" >&3; done; }
# Powers the VM off from inside, so what it wrote is on its disk; stops it if that takes too long.
stop() {
	[ -n "$reader" ] || return 0
	printf 'sync; poweroff\r' >&3
	for i in $(seq 1 60); do qm status "$id" | grep -q stopped && break; sleep 1; done
	qm status "$id" | grep -q stopped || qm stop "$id" >/dev/null
	exec 3>&-
	kill "$reader" 2>/dev/null || :
	reader=
}

# First boot, with no network card: a DHCP client that serves neither DHCP
# nor router advertisements, dropbear with keys only, LuCI off.
boot
type_lines <<'OWRT'
n=0; while [ -n "$(ls /etc/uci-defaults)" ] && [ "$n" -lt 60 ]; do n=$((n + 1)); sleep 1; done
uci set 'system.@system[0].hostname=hopdeck-openwrt'
uci set network.lan.proto=dhcp; uci -q delete network.lan.ipaddr; uci -q delete network.lan.netmask; uci -q delete network.lan.ip6assign
uci set dhcp.lan.ignore=1; uci set dhcp.lan.dhcpv4=disabled; uci set dhcp.lan.dhcpv6=disabled; uci set dhcp.lan.ra=disabled
uci set 'dropbear.@dropbear[0].PasswordAuth=off'; uci set 'dropbear.@dropbear[0].RootPasswordAuth=off'
uci commit
/etc/init.d/odhcpd disable; [ ! -x /etc/init.d/uhttpd ] || /etc/init.d/uhttpd disable
sed -i 's|^root:[^:]*:|root:*:|' /etc/shadow
OWRT
printf "echo '%s' >/etc/dropbear/authorized_keys; chmod 600 /etc/dropbear/authorized_keys\r" "$key" >&3
type_lines <<'OWRT'
echo "@@chec""k=$(uci get network.lan.proto)/$(uci get dhcp.lan.ignore)/$(uci get 'dropbear.@dropbear[0].PasswordAuth')/$(/etc/init.d/odhcpd enabled && echo on || echo off)/$(grep -c '^root:\*:' /etc/shadow)"
OWRT
wait_for '@@check=' 120
check=$(tr -d '\r' <"$out" | sed -n 's/^.*@@check=\([^ ]*\).*$/\1/p' | tail -n 1)
if [ "$check" != dhcp/1/off/off/1 ]; then
	echo "VM $id was not configured as it should be ($check); it stays without a network card" >&2
	stop
	exit 1
fi
stop

# Second boot, on the network.
qm set "$id" --net0 "virtio,bridge=$bridge" >/dev/null
boot
type_lines <<'OWRT'
for i in $(seq 1 90); do a=$(ifstatus lan | jsonfilter -e "@['ipv4-address'][0].address"); [ -n "$a" ] && break; sleep 1; done
echo "@@add""ress=$a"
echo "@@k""ey=$(dropbearkey -y -f /etc/dropbear/dropbear_ed25519_host_key | grep '^ssh-ed25519' | cut -d' ' -f1,2)"
echo "@@ver""sions=$(uname -r), $(nft --version), OpenWrt $(. /etc/openwrt_release && echo "$DISTRIB_RELEASE")"
OWRT
wait_for '@@versions=' 120
exec 3>&-
kill "$reader" 2>/dev/null || :
tr -d '\r' <"$out"
PVE
	)
	address=$(printf '%s\n' "$console" | sed -n 's/^.*@@address=\([0-9.]*\).*$/\1/p' | head -n 1)
	hostkey=$(printf '%s\n' "$console" | sed -n 's/^.*@@key=\(ssh-ed25519 [A-Za-z0-9+/=]*\).*$/\1/p' | head -n 1)
	versions=$(printf '%s\n' "$console" | sed -n 's/^.*@@versions=//p' | head -n 1)
	if [ -z "$address" ] || [ -z "$hostkey" ]; then
		echo "the VM's console gave no address or host key (see /tmp/hopdeck-$vm.console on $pve)" >&2
		exit 1
	fi
	# The key as the console showed it: ssh checks the VM against it.
	printf '%s %s\n' "$address" "$hostkey" >"$state/known_hosts"
	ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "$keys/id_ed25519" -o UserKnownHostsFile="$state/known_hosts" -o StrictHostKeyChecking=yes \
		"root@$address" true
	printf '%s\n' "$versions" >"$state/versions"
	accounts=root
else
	console=$(on_pve sh -s "$vm" <<'PVE'
set -eu
id=$1
qm start "$id"
for i in $(seq 1 40); do [ -S "/var/run/qemu-server/$id.serial0" ] && break; sleep 0.5; done
out=/tmp/hopdeck-$id.console
: >"$out"
timeout 900 socat -u "UNIX-CONNECT:/var/run/qemu-server/$id.serial0" STDOUT >>"$out" 2>/dev/null &
reader=$!
# cloud-init prints the host keys' fingerprints last, after the address.
for i in $(seq 1 900); do grep -a -q -E 'END SSH HOST KEY FINGERPRINTS|Kernel panic' "$out" && break; sleep 1; done
kill "$reader" 2>/dev/null || :
tr -d '\r' <"$out"
PVE
	)
	if printf '%s\n' "$console" | grep -q 'Kernel panic'; then
		printf '%s\n' "$console" | grep -a -B 3 'Kernel panic' | head -n 8 >&2
		echo "VM $vm did not boot (its console is in /tmp/hopdeck-$vm.console on $pve)" >&2
		exit 1
	fi
	address=$(printf '%s\n' "$console" | grep -a -o -E '\| *[a-z0-9]+ *\| *True *\| *([0-9]+\.){3}[0-9]+ *\|' | grep -v ' lo ' | grep -o -E '([0-9]+\.){3}[0-9]+' | head -n 1)
	fingerprint=$(printf '%s\n' "$console" | sed -n '/BEGIN SSH HOST KEY FINGERPRINTS/,/END SSH HOST KEY FINGERPRINTS/p' | grep -o 'SHA256:[^ ]* .*(ED25519)' | cut -d' ' -f1)
	if [ -z "$address" ] || [ -z "$fingerprint" ]; then
		echo "the VM's console gave no address or host key (see /tmp/hopdeck-$vm.console on $pve)" >&2
		exit 1
	fi

	ssh-keyscan -T 10 -t ed25519 "$address" 2>/dev/null >"$state/known_hosts"
	if [ "$(ssh-keygen -l -f "$state/known_hosts" | cut -d' ' -f2)" != "$fingerprint" ]; then
		rm -f "$state/known_hosts"
		echo "the host key at $address is not the one the VM's console showed ($fingerprint): not trusting it" >&2
		exit 1
	fi

	echo "Accounts and sshd, on $address..."
	ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "$keys/id_ed25519" -o UserKnownHostsFile="$state/known_hosts" -o StrictHostKeyChecking=yes \
		"root@$address" sh -s "\"$key\"" <"$here/provision.sh" >"$state/versions"
	accounts="root admin nopass plain"
fi

: >"$state/known_hosts.unknown"
printf '%s %s\n' "$address" "$(cut -d' ' -f1,2 "$keys/other_host_key.pub")" >"$state/known_hosts.changed"
rm -f "$state/known_hosts.changed.old"
{
	echo "# Generated by dev/vm-host/up.sh $system: VM $vm on $pve"
	for account in $accounts; do
		printf 'Host hopdeck-test-%s\n\tUser %s\n' "$account" "$account"
	done
	printf 'Host hopdeck-test-unknown-key\n\tUser root\n\tUserKnownHostsFile "%s"\n' "$state/known_hosts.unknown"
	printf 'Host hopdeck-test-changed-key\n\tUser root\n\tUserKnownHostsFile "%s"\n' "$state/known_hosts.changed"
	printf 'Host hopdeck-test-*\n\tHostName %s\n\tIdentityFile "%s"\n\tIdentitiesOnly yes\n\tUserKnownHostsFile "%s"\n\tStrictHostKeyChecking yes\n' \
		"$address" "$keys/id_ed25519" "$state/known_hosts"
} >"$state/ssh_config"

label() {
	case "$1" in
	root) echo 'root' ;;
	admin) echo 'sudo with password' ;;
	nopass) echo 'sudo without password' ;;
	plain) echo 'no sudo' ;;
	esac
}
{
	printf '{\n  "version": 1,\n  "hosts": [\n'
	for account in $accounts; do
		printf '    { "id": "vm-%s", "destination": "hopdeck-test-%s", "name": "VM %s: %s" },\n' "$account" "$account" "$system" "$(label "$account")"
	done
	printf '    { "id": "vm-unknown-key", "destination": "hopdeck-test-unknown-key", "name": "VM %s: unknown host key" },\n' "$system"
	printf '    { "id": "vm-changed-key", "destination": "hopdeck-test-changed-key", "name": "VM %s: changed host key" }\n' "$system"
	printf '  ]\n}\n'
} >"$state/config/hosts.json"

json_accounts=$(printf '"%s", ' $accounts | sed 's/, $//')
printf '{ "system": "%s", "port": 22, "address": "%s", "vmid": %s, "init": "%s", "platform": "%s", "accounts": [%s], "passwords": false }\n' \
	"$system" "$address" "$vm" "$init" "$platform" "$json_accounts" >"$state/host.json"

cat <<DONE
Test VM is up: $system as VM $vm on $pve, at $address ($(cat "$state/versions")).
  Log in by hand:   ssh -F .dev/vm-host/$system/ssh_config hopdeck-test-root
  Run the tests:    HOPDECK_TEST_HOST=1 HOPDECK_TEST_HOST_DIR=.dev/vm-host/$system pnpm vitest run --no-file-parallelism
  Remove it:        dev/vm-host/down.sh $system
DONE
