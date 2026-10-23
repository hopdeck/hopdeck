# hopdeck

A local web panel for running networks, starting with the firewall. It manages
the local machine and remote hosts over SSH, with no agent on the hosts.

The first module is a GUI for nftables that can do everything nftables can do,
only easier:

- Structured editors for rules, sets and maps, plus a full text mode. Nothing
  nftables supports is out of reach.
- Validation by the host's own `nft`, a diff before every change, atomic
  apply, and automatic rollback unless you confirm.
- Coexistence with Docker, firewalld, fail2ban and others: hopdeck edits only the
  tables it manages.
- A packet path view (hooks and priorities across all tables), packet tracing
  and live counters.
- Port forwards with a wizard: DNAT, the accepts every forward chain needs,
  masquerade and hairpin NAT, listed, changed and removed as one.
- A packet log: what rules with a log statement wrote to the host's kernel
  log, each line linked to its rule (on OpenWrt, to its zone or UCI rule),
  the same packet within a second folded into one line; one click logs what
  a chain's policy drops.
- A history of every change, kept on each host: who made it, from where and
  with which SSH key, changes made outside hopdeck, and a way back to any
  version.

- OpenWrt routers through UCI, as LuCI changes them, so LuCI shows every
  change: zones, traffic rules (in the order fw4 follows them, dragged into
  another, with fw4's counts), port forwards, NAT rules (masquerading, SNAT
  to an address or port, or none, in their order too), IP sets, and
  nftables files of your own that fw4 includes where you say. Changes from every tab
  collect for one review, and rpcd rolls them back unless you keep them.

Planned: more network tools, such as a topology view.

**Status:** 0.4.0: usable, and early. See [CHANGELOG.md](CHANGELOG.md).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## Install

hopdeck is one executable file; it brings its own Node.js. It runs on Linux,
x64 or arm64, with glibc 2.28 or later (Debian 10, RHEL 8, Ubuntu 20.04 and
newer) and one system library, libatomic: many installs have it, minimal ones
do not. Without it, starting hopdeck says `libatomic.so.1: cannot open shared
object file`; install it with `apt install libatomic1` (Debian, Ubuntu) or
`dnf install libatomic` (RHEL, AlmaLinux, Fedora).

Download the archive for your machine and `SHA256SUMS` from the
[releases](https://github.com/hopdeck/hopdeck/releases), then:

```sh
sha256sum -c --ignore-missing SHA256SUMS
tar xf hopdeck-0.4.0-linux-x64.tar.xz
hopdeck-0.4.0-linux-x64/hopdeck
```

The sums show the download is whole. That it was built by this repository's
release workflow, from the version's tag, is what its attestation shows
(from 0.2.0 on); with the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify hopdeck-0.4.0-linux-x64.tar.xz --repo hopdeck/hopdeck
```

It prints the address of the panel; open it in a browser on the same
machine. It listens on 127.0.0.1 only, on port 7400, or the next free one up
to 7419 when that is taken (it says by what: another hopdeck, with its
address, or another program); `--port` picks one. `hopdeck --sandbox` adds a
host with a demo firewall to try things on, `hopdeck --help` lists the
options, and `hopdeck --licenses` the licenses of all it contains.

For SSH hosts it uses the system's OpenSSH client (`ssh`, `ssh-keygen`,
`ssh-add`, `ssh-agent`) and your `~/.ssh/config`. A managed host needs `nft`,
and root or sudo.

### Windows

From version 0.2, hopdeck also runs on Windows 10 and 11 (x64 and arm64), as
`hopdeck.exe`. It manages Linux hosts over SSH; the Windows machine itself is
no host, and there is no sandbox. It uses Windows' own OpenSSH client, built
in since Windows 10 version 1809: if `ssh -V` in PowerShell finds nothing, add
it under Settings, Apps, Optional features, "OpenSSH Client".

Download the zip for your machine and `SHA256SUMS`, extract the zip, and start
`hopdeck.exe` from PowerShell:

```powershell
Expand-Archive hopdeck-0.4.0-win-x64.zip -DestinationPath .
.\hopdeck-0.4.0-win-x64\hopdeck.exe
```

To unlock SSH keys that have a passphrase, hopdeck uses Windows' OpenSSH
agent service, which is off by default. Turn it on once, in PowerShell as
administrator:

```powershell
Set-Service ssh-agent -StartupType Manual
Start-Service ssh-agent
```

Windows' OpenSSH has no ControlMaster, so hopdeck keeps one SSH session per
host and runs its commands through it: one login, then commands as fast as on
Linux. The hosts need nothing more for it than they have (`sh`, `awk`, and
`base64`, `hexdump` or `od`).

`hopdeck.exe` is not signed with a code signing certificate, so the first
time Windows SmartScreen says "Windows protected your PC", with an unknown
publisher. Check that the file is the released one, then start it anyway with
"More info" and "Run anyway". In PowerShell, this prints the SHA-256 to find
in `SHA256SUMS`:

```powershell
Get-FileHash hopdeck-0.4.0-win-x64.zip -Algorithm SHA256
```

Rather not run a program without a signature? Run hopdeck from its source
with Node.js, or build the executable yourself: see below. SmartScreen only
warns about files downloaded from the internet, so it says nothing about an
executable you build yourself.

## From source

All of hopdeck is in this repository: you can run it with Node.js instead of
the executable, or build the executable yourself from it. Each release has a
tag, `v0.4.0` for example; use the latest one from the
[releases](https://github.com/hopdeck/hopdeck/releases).

### On Linux

You need Node.js 24 or later from [nodejs.org](https://nodejs.org) (the
Node.js of many distributions is older), git, and the OpenSSH client. Then:

```sh
git clone --branch v0.4.0 https://github.com/hopdeck/hopdeck.git
cd hopdeck
npm install -g pnpm@12            # with sudo, if Node.js is installed system-wide
pnpm install --frozen-lockfile
pnpm build                        # the web UI
pnpm start                        # the panel; options follow, e.g. pnpm start --sandbox
```

To build the executable instead, after `pnpm install`:

```sh
pnpm build:sea
dist/hopdeck-0.4.0-linux-x64/hopdeck
```

The build downloads the official Node.js release the executable is made of
from nodejs.org, and uses it only if its SHA-256 is the one written in
[`packages/cli/scripts/build-sea.ts`](packages/cli/scripts/build-sea.ts); it
needs `tar` and `xz`, and libatomic, as the executable does (see Install).

### On Windows (from version 0.2)

You need Node.js 24 or later and Git, from [nodejs.org](https://nodejs.org)
and [git-scm.com](https://git-scm.com), or in PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Then, in a new PowerShell window:

```powershell
git clone --branch v0.4.0 https://github.com/hopdeck/hopdeck.git
cd hopdeck
npm install -g pnpm@12
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

If PowerShell refuses to run `pnpm` ("running scripts is disabled on this
system"), allow scripts signed or made on this computer for your account
once, with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or type
`pnpm.cmd` instead of `pnpm`.

To build the executable instead, after `pnpm install`:

```powershell
pnpm build:sea
dist\hopdeck-0.4.0-win-x64\hopdeck.exe
```

## Development

You need Node.js 24 and pnpm 12 (`npm install -g pnpm@12`).

```sh
pnpm install
pnpm dev         # API and UI on the first free ports from 7400 and 5173; open the printed URL
pnpm test
pnpm typecheck
pnpm build && pnpm start   # serve the built UI from the backend
```

`hopdeck --sandbox` (used by `pnpm dev`) adds a sandbox host: a private network
namespace with a demo firewall. It needs no root and never touches the real
firewall, so everything can be tried safely.

`pnpm build:sea` builds the executable for this machine into `dist/`
(`--target linux-x64 --target linux-arm64` for both, `--archive` to pack them
with their sums). The build starts each executable and checks its UI, API and
licenses; for another architecture it needs QEMU (`--qemu`). CI builds and
checks both on every push, and a tag `vVERSION` makes a release of them.

### Test hosts

`dev/test-host/up.sh [SYSTEM]` starts a container with podman (rootless, needs
`podman`, `passt` and `uidmap`) that plays a remote host: SSH, nftables, and
one account per privilege case (root, sudo with a password, sudo without one,
no sudo). SYSTEM is one of `debian11`, `debian12`, `debian13` (the default),
`alma9`, `alma10` (RHEL-compatible), `alpine` (OpenRC and BusyBox, no systemd)
and `openwrt` (procd, dropbear, fw4; root only). Logins are by key; the
accounts with a password (`admin` and `plain`, root on OpenWrt, all
`hopdeck-test`) may also use it, for the key setup.

Each system also has a host no key opens yet, "SYSTEM: no key yet" (admin,
or root on OpenWrt, password `hopdeck-test`), to try the key setup on: the
panel shows the SSH key panel, where a key is generated, or one made before
is chosen, and then put on the host with the password. In the test panels,
generated keys go to `.dev/test-host/generated-keys` (`HOPDECK_SSH_DIR`),
not `~/.ssh`, and hopdeck's own ssh-agent holds them, not your session's.

`pnpm dev:test-host` starts hopdeck with the Debian 13 hosts, and
`pnpm dev:test-hosts [SYSTEM...]` with those of the systems named, or of every
running one, each as "SYSTEM: account".
`pnpm test:host` runs the tests including the ones that need a host; set
`HOPDECK_TEST_HOST_DIR=.dev/test-host/SYSTEM` for another system
(`.dev/vm-host/SYSTEM` for a [VM](#test-virtual-machines)).
`pnpm test:hosts` starts each system in turn, runs those tests against it and
sums up; logs go to `.dev/test-host/logs`. The key, known_hosts and ssh
configs live in `.dev/test-host`; `~/.ssh` is never touched, and a container's
ruleset is separate from the real one. `dev/test-host/down.sh [SYSTEM|all]`
removes containers.

The containers share this machine's kernel, so they test nft, sudo, sshd,
systemd, OpenRC and the paths of each system, not older kernels.

### Test virtual machines

For what needs a kernel of its own (the kernels of Debian 11 and RHEL 9, the
packet log, port forwards between machines), `dev/vm-host/up.sh [SYSTEM]`
starts the same systems as virtual machines on a Proxmox VE host, plus
`openwrt24` (OpenWrt 24.10 next to `openwrt`, 25.12). It reaches the host as
`ssh pve` (root; `HOPDECK_PVE` for another name) and uses only VMIDs from
9000 up (`HOPDECK_PVE_VMID`): a template per system made from the system's
official cloud image, checked against its published sum, and a linked clone
of it for the tests. The VMs take an address by DHCP on `vmbr0`
(`HOPDECK_PVE_BRIDGE`), a real network, so logins are by key only; the key
setup tests, which log in with a password, run on the containers alone. An
OpenWrt VM is set up through its serial console before it gets a network
card, so its DHCP server and router advertisements never reach that network.

`pnpm dev:vms [SYSTEM...]` starts the panel with the VMs started before,
those named or all of them, each account as "VM SYSTEM: account", to try
things by hand.
`dev/vm-host/router.sh` starts an OpenWrt router with a Debian client behind
it: the router's LAN is `vmbr9000` (`HOPDECK_PVE_LAN`), a bridge with no port
of its own, so its DHCP server stays there, and its WAN is on `vmbr0`, where
it lets SSH in from this machine's address only. The client is reached
through the router. The host tests then forward a port to the client and
fetch through it from this machine and, by NAT loopback, from the client.
`pnpm test:vms [SYSTEM...]` starts each VM in turn, runs the host tests
against it and removes it again (the templates stay); logs go to
`.dev/vm-host/logs`. `dev/vm-host/down.sh [SYSTEM|all] [--templates]` removes
VMs by hand, and their templates too; it touches only VMs named `hopdeck-…`.

CI on GitHub runs the same: every push tests the Debian 13 host, and every
Monday all systems; "Run workflow" on the CI workflow picks systems by hand.

`scripts/nft-fixture.sh FILE.nft` writes what nft prints for a ruleset (JSON and
the text listing with handles) next to the file, using a throwaway network
namespace. The host ruleset is not touched.

## Translations

The UI is available in English and Polish. Texts live in
`packages/web/src/i18n/locales/<language>.json` (i18next JSON v4 format). To
add a language:

1. Copy `en.json` to e.g. `de.json` and translate the values.
2. Run `pnpm test`. It lists missing keys, including the plural forms your
   language needs.

No code changes are needed: every file in that directory becomes a language.

## Security

Report security problems privately, as [SECURITY.md](SECURITY.md) says, not
in public issues.

## Author and license

hopdeck was created by Mateusz T ([Tenir](https://github.com/Tenirrr)), who maintains it; see
[AUTHORS](AUTHORS).

Copyright (C) 2026 Mateusz T (Tenir)

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. It is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

If you change hopdeck and let others use it over a network, offer them the
source of your version (section 13 of the licence): the panel links to it at
the foot of the host list, from `SOURCE_REPOSITORY` in
[packages/core/src/legal.ts](packages/core/src/legal.ts). hopdeck 0.1.0 and
0.1.1 were released under the GNU General Public License, version 3 or later.
