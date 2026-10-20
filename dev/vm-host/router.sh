#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Mateusz T (Tenir)

# Starts an OpenWrt router with a network behind it on the Proxmox host, for
# what a single VM cannot show: port forwards that reach a host behind the
# router, NAT loopback, DHCP leases.
#
#   dev/vm-host/router.sh
#
#   this machine --vmbr0-- [wan  OpenWrt 25.12  lan] --vmbr9000-- client (Debian 13)
#
# The router's LAN is HOPDECK_PVE_LAN (default vmbr9000), a bridge with no
# port of its own, so OpenWrt serves DHCP there as it ships; its WAN takes an
# address by DHCP on HOPDECK_PVE_BRIDGE (default vmbr0). It is set up through
# its serial console before it gets its network cards: SSH from the WAN only
# from this machine's address, by key, and LuCI off. The client is reached
# through the router (ProxyJump). Router VMID+19, client VMID+20; templates
# of dev/vm-host/up.sh openwrt and debian13, made first if missing. The state
# goes to .dev/vm-host/router.
set -eu

# While scripts/test-hosts.sh --vm runs, it alone starts and removes test VMs.
lock="$(cd "$(dirname "$0")/../.." && pwd)/.dev/vm-host/run.lock"
if [ -d "$lock" ] && [ "${HOPDECK_TEST_RUN:-}" != "$(cat "$lock/pid" 2>/dev/null)" ]; then
	echo "a test run is going on (scripts/test-hosts.sh --vm, pid $(cat "$lock/pid" 2>/dev/null || echo unknown)); wait for it to finish" >&2
	exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
pve=${HOPDECK_PVE:-pve}
first=${HOPDECK_PVE_VMID:-9000}
wan_bridge=${HOPDECK_PVE_BRIDGE:-vmbr0}
lan_bridge=${HOPDECK_PVE_LAN:-vmbr9000}
if [ "$first" -lt 9000 ]; then
	echo "HOPDECK_PVE_VMID must be 9000 or more: the VMIDs below are the Proxmox host's own" >&2
	exit 2
fi
router=$((first + 19))
client=$((first + 20))
keys="$repo/.dev/test-host"
state="$repo/.dev/vm-host/router"
mkdir -p "$state/config"
on_pve() { ssh -o BatchMode=yes "$pve" "$@"; }
key=$(cat "$keys/id_ed25519.pub")
# The address the router will see this machine come from: the one it reaches the Proxmox host with.
pve_address=$(ssh -G "$pve" | awk '$1 == "hostname" { print $2; exit }')
admin=$(ip -4 route get "$(getent ahostsv4 "$pve_address" | awk '{ print $1; exit }')" | sed -n 's/.* src \([0-9.]*\).*/\1/p')
[ -n "$admin" ] || { echo "cannot tell this machine's address towards $pve" >&2; exit 1; }

for system in openwrt debian13; do
	case "$system" in openwrt) n=7 ;; debian13) n=3 ;; esac
	if ! on_pve "qm config $((first + n)) 2>/dev/null | grep -q '^template: 1'"; then
		echo "The $system template is missing: making it with up.sh..."
		"$here/up.sh" "$system" >/dev/null
		"$here/down.sh" "$system" >/dev/null
	fi
done

echo "The router, VMID $router, set up through its console with no network card..."
console=$(on_pve sh -s "$first" "$router" "$wan_bridge" "$lan_bridge" "\"$key\"" "$admin" <<'PVE'
set -eu
first=$1 id=$2 wan=$3 lan=$4 key=$5 admin=$6
if qm status "$id" >/dev/null 2>&1; then
	qm config "$id" | grep -q '^name: hopdeck-' || { echo "VMID $id is not hopdeck's: leaving it alone" >&2; exit 1; }
	qm stop "$id" >/dev/null 2>&1 || :
	qm destroy "$id" --purge >/dev/null
fi
qm clone "$((first + 7))" "$id" --name hopdeck-router --description "hopdeck test router, made by dev/vm-host/router.sh" >/dev/null
qm set "$id" --memory 128 --cores 1 >/dev/null
sock=/var/run/qemu-server/$id.serial0
out=/tmp/hopdeck-$id.console
in=/tmp/hopdeck-$id.in
reader=
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
	# BusyBox's line editing may take the first keys typed for the terminal's answer.
	for i in $(seq 1 15); do
		printf 'echo "@@rea""dy"\r' >&3
		sleep 1
		tr -d '\r' <"$out" | grep -a -q '@@ready' && break
	done
	wait_for '@@ready' 5
}
type_lines() { while IFS= read -r line; do printf '%s\r' "$line" >&3; done; }
stop() {
	[ -n "$reader" ] || return 0
	printf 'sync; poweroff\r' >&3
	for i in $(seq 1 60); do qm status "$id" | grep -q stopped && break; sleep 1; done
	qm status "$id" | grep -q stopped || qm stop "$id" >/dev/null
	exec 3>&-
	kill "$reader" 2>/dev/null || :
	reader=
}

# First boot, with no network card: the LAN as OpenWrt ships it (it serves
# DHCP, on a bridge of its own), a WAN on the second card, SSH in from the
# WAN only from this machine, keys only, LuCI off.
boot
type_lines <<'OWRT'
n=0; while [ -n "$(ls /etc/uci-defaults)" ] && [ "$n" -lt 60 ]; do n=$((n + 1)); sleep 1; done
uci set 'system.@system[0].hostname=hopdeck-router'
uci set network.wan=interface; uci set network.wan.device=eth1; uci set network.wan.proto=dhcp
uci set network.wan6=interface; uci set network.wan6.device=eth1; uci set network.wan6.proto=dhcpv6
uci set 'dropbear.@dropbear[0].PasswordAuth=off'; uci set 'dropbear.@dropbear[0].RootPasswordAuth=off'
uci set firewall.hopdeck_ssh=rule; uci set firewall.hopdeck_ssh.name=Allow-SSH-hopdeck; uci set firewall.hopdeck_ssh.src=wan; uci set firewall.hopdeck_ssh.proto=tcp; uci set firewall.hopdeck_ssh.dest_port=22; uci set firewall.hopdeck_ssh.target=ACCEPT
uci commit
[ ! -x /etc/init.d/uhttpd ] || /etc/init.d/uhttpd disable
sed -i 's|^root:[^:]*:|root:*:|' /etc/shadow
OWRT
printf "uci set firewall.hopdeck_ssh.src_ip='%s'; uci commit firewall\r" "$admin" >&3
printf "echo '%s' >/etc/dropbear/authorized_keys; chmod 600 /etc/dropbear/authorized_keys\r" "$key" >&3
type_lines <<'OWRT'
echo "@@chec""k=$(uci get network.wan.proto)/$(uci get firewall.hopdeck_ssh.src_ip)/$(uci get 'dropbear.@dropbear[0].PasswordAuth')/$(grep -c '^root:\*:' /etc/shadow)"
OWRT
wait_for '@@check=' 120
check=$(tr -d '\r' <"$out" | sed -n 's/^.*@@check=\([^ ]*\).*$/\1/p' | tail -n 1)
if [ "$check" != "dhcp/$admin/off/1" ]; then
	echo "VM $id was not configured as it should be ($check); it stays without network cards" >&2
	stop
	exit 1
fi
stop

# The LAN card first, so it is eth0, as on the first boot's configuration.
qm set "$id" --net0 "virtio,bridge=$lan" --net1 "virtio,bridge=$wan" >/dev/null
boot
type_lines <<'OWRT'
for i in $(seq 1 90); do a=$(ifstatus wan | jsonfilter -e "@['ipv4-address'][0].address"); [ -n "$a" ] && break; sleep 1; done
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
	echo "the router's console gave no WAN address or host key (see /tmp/hopdeck-$router.console on $pve)" >&2
	exit 1
fi
printf '%s %s\n' "$address" "$hostkey" >"$state/known_hosts"

echo "The client behind it, VMID $client..."
console=$(on_pve sh -s "$first" "$client" "$lan_bridge" <<'PVE'
set -eu
first=$1 id=$2 lan=$3
if qm status "$id" >/dev/null 2>&1; then
	qm config "$id" | grep -q '^name: hopdeck-' || { echo "VMID $id is not hopdeck's: leaving it alone" >&2; exit 1; }
	qm stop "$id" >/dev/null 2>&1 || :
	qm destroy "$id" --purge >/dev/null
fi
qm clone "$((first + 3))" "$id" --name hopdeck-router-client --description "hopdeck test client behind the router, made by dev/vm-host/router.sh" >/dev/null
qm set "$id" --memory 512 --cores 1 --net0 "virtio,bridge=$lan" >/dev/null
qm start "$id"
for i in $(seq 1 40); do [ -S "/var/run/qemu-server/$id.serial0" ] && break; sleep 0.5; done
out=/tmp/hopdeck-$id.console
: >"$out"
timeout 900 socat -u "UNIX-CONNECT:/var/run/qemu-server/$id.serial0" STDOUT >>"$out" 2>/dev/null &
reader=$!
for i in $(seq 1 900); do grep -a -q -E 'END SSH HOST KEY KEYS|Kernel panic' "$out" && break; sleep 1; done
kill "$reader" 2>/dev/null || :
tr -d '\r' <"$out"
PVE
)
client_address=$(printf '%s\n' "$console" | grep -a -o -E '\| *[a-z0-9]+ *\| *True *\| *([0-9]+\.){3}[0-9]+ *\|' | grep -v ' lo ' | grep -o -E '([0-9]+\.){3}[0-9]+' | head -n 1)
# cloud-init prints the host keys themselves too: the client is no address of this machine's to scan.
client_key=$(printf '%s\n' "$console" | sed -n '/BEGIN SSH HOST KEY KEYS/,/END SSH HOST KEY KEYS/p' | grep -o 'ssh-ed25519 [A-Za-z0-9+/=]*' | head -n 1)
if [ -z "$client_address" ] || [ -z "$client_key" ]; then
	echo "the client's console gave no address or host key (see /tmp/hopdeck-$client.console on $pve)" >&2
	exit 1
fi
printf '%s %s\n' "$client_address" "$client_key" >>"$state/known_hosts"

: >"$state/known_hosts.unknown"
printf '%s %s\n' "$address" "$(cut -d' ' -f1,2 "$keys/other_host_key.pub")" >"$state/known_hosts.changed"
{
	echo "# Generated by dev/vm-host/router.sh: router VM $router, client VM $client on $pve"
	printf 'Host hopdeck-test-root\n\tUser root\n\tHostName %s\n' "$address"
	printf 'Host hopdeck-test-unknown-key\n\tUser root\n\tHostName %s\n\tUserKnownHostsFile "%s"\n' "$address" "$state/known_hosts.unknown"
	printf 'Host hopdeck-test-changed-key\n\tUser root\n\tHostName %s\n\tUserKnownHostsFile "%s"\n' "$address" "$state/known_hosts.changed"
	printf 'Host hopdeck-test-client\n\tUser root\n\tHostName %s\n\tProxyJump hopdeck-test-root\n' "$client_address"
	printf 'Host hopdeck-test-*\n\tIdentityFile "%s"\n\tIdentitiesOnly yes\n\tUserKnownHostsFile "%s"\n\tStrictHostKeyChecking yes\n' "$keys/id_ed25519" "$state/known_hosts"
} >"$state/ssh_config"
ssh -F "$state/ssh_config" -o BatchMode=yes hopdeck-test-root true
# The client as every test VM is: nftables, sudo, the test accounts, keys only.
echo "Accounts, nftables and sshd on the client..."
ssh -F "$state/ssh_config" -o BatchMode=yes hopdeck-test-client sh -s "\"$key\"" <"$here/provision.sh" >/dev/null

{
	printf '{\n  "version": 1,\n  "hosts": [\n'
	printf '    { "id": "vm-router", "destination": "hopdeck-test-root", "name": "VM router: root" },\n'
	printf '    { "id": "vm-router-client", "destination": "hopdeck-test-client", "name": "VM router: client behind it" }\n'
	printf '  ]\n}\n'
} >"$state/config/hosts.json"
printf '{ "system": "router", "port": 22, "address": "%s", "vmid": %s, "init": "procd", "platform": "openwrt", "accounts": ["root"], "passwords": false, "client": { "address": "%s", "vmid": %s } }\n' \
	"$address" "$router" "$client_address" "$client" >"$state/host.json"
printf '%s\n' "$versions" >"$state/versions"

cat <<DONE
Test router is up: VM $router at $address on $pve ($versions), with a client VM $client at $client_address behind it.
  Log in by hand:   ssh -F .dev/vm-host/router/ssh_config hopdeck-test-root   (the client: hopdeck-test-client)
  Run the tests:    HOPDECK_TEST_HOST=1 HOPDECK_TEST_HOST_DIR=.dev/vm-host/router pnpm vitest run --no-file-parallelism
  Remove them:      dev/vm-host/down.sh router
DONE
