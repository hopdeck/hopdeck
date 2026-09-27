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
- A history of every change, kept on each host: who made it, from where and
  with which SSH key, changes made outside hopdeck, and a way back to any
  version.

Planned: OpenWrt through UCI, and more network tools, such as a topology view.

**Status:** early development, not released yet.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## Development

You need Node.js 24 and pnpm 12 (`npm install -g pnpm@12`).

```sh
pnpm install
pnpm dev         # API on 127.0.0.1:7400 and UI on 127.0.0.1:5173; open the printed URL
pnpm test
pnpm typecheck
pnpm build && pnpm start   # serve the built UI from the backend
```

`hopdeck --sandbox` (used by `pnpm dev`) adds a sandbox host: a private network
namespace with a demo firewall. It needs no root and never touches the real
firewall, so everything can be tried safely.

### Test hosts

`dev/test-host/up.sh [SYSTEM]` starts a container with podman (rootless, needs
`podman`, `passt` and `uidmap`) that plays a remote host: SSH, nftables, and
one account per privilege case (root, sudo with a password, sudo without one,
no sudo). SYSTEM is one of `debian11`, `debian12`, `debian13` (the default),
`alma9`, `alma10` (RHEL-compatible), `alpine` (OpenRC and BusyBox, no systemd)
and `openwrt` (procd, dropbear, fw4; root only).

`pnpm dev:test-host` starts hopdeck with the Debian 13 hosts, and
`pnpm dev:test-hosts [SYSTEM...]` with those of the systems named, or of every
running one, each as "SYSTEM: account".
`pnpm test:host` runs the tests including the ones that need a host; set
`HOPDECK_TEST_HOST_DIR=.dev/test-host/SYSTEM` for another system.
`pnpm test:hosts` starts each system in turn, runs those tests against it and
sums up; logs go to `.dev/test-host/logs`. The key, known_hosts and ssh
configs live in `.dev/test-host`; `~/.ssh` is never touched, and a container's
ruleset is separate from the real one. `dev/test-host/down.sh [SYSTEM|all]`
removes containers.

The containers share this machine's kernel, so they test nft, sudo, sshd,
systemd, OpenRC and the paths of each system, not older kernels.

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

## Author and license

hopdeck was created by Mateusz T ([Tenir](https://github.com/Tenirrr)), who maintains it; see
[AUTHORS](AUTHORS).

Copyright (C) 2026 Mateusz T (Tenir)

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.
