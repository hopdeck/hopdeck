# Changelog

## Unreleased

### Added

- IP sets on OpenWrt: named sets of addresses, networks, ports or MAC
  addresses that fw4 declares, with their entries in UCI and, if wanted, a
  file on the router for more; traffic rules match a set, or packets not in
  it. Renaming a set renames it in the rules that use it, and a set in use
  is not removed.
- nftables files on OpenWrt: nftables of your own that fw4 includes where
  you say (before or after its table, inside it, or in one of its chains,
  before or after its rules), pointed to by an include section, so LuCI and a
  rollback see them. hopdeck writes each version as a file of its own in
  /etc/hopdeck/fw4, so a rollback brings back the one before, and removes
  the versions nothing points to once a change is kept. Other includes, and
  the files fw4 includes by themselves, are shown.
- A history of the firewall's configuration on OpenWrt, kept on the router
  as the nftables history is on other hosts: the configuration before
  hopdeck's first change, every change kept, with who made it (the SSH key
  as dropbear logged it), and changes made in LuCI or with uci, noticed when
  hopdeck reads the configuration. Each version keeps /etc/config/firewall
  and hopdeck's nftables files, shows what changed in them, and can be put
  back through the usual review and rollback.
- The port forward form on OpenWrt offers the hosts the router knows as the
  internal address: its DHCP leases and the fixed addresses of
  /etc/config/dhcp.

### Changed

- A traffic rule dragged elsewhere on OpenWrt is marked as changed, not the
  rules it passed.
- The tabs of a host wrap onto a second row when they do not fit, each group
  together, instead of scrolling out of sight.

### Fixed

- A new panel link pasted into a tab that has the panel open already loads
  the panel with its token, instead of going on with the old one and
  refusing every request.

## 0.4.0 (2026-10-18)

### Added

- OpenWrt's firewall can be changed now, through UCI as LuCI changes it, so
  LuCI shows every change: zones (networks, policies, masquerading, the
  zones each forwards to), traffic rules in the order fw4 follows them,
  dragged or moved into another, with what fw4 counted for each, and port
  forwards with NAT loopback. Changes from every tab collect, as LuCI's
  unsaved changes do, for one review of what rpcd will write; applying them
  arms rpcd's own rollback, reloads the firewall and checks it, tries a new
  SSH connection, and shows the nftables fw4 made, before and after, until
  you keep the change. Changes made on a configuration that changed since
  are refused. OpenWrt 22.03 and later, tested on 24.10 and 25.12; the
  nftables view stays read-only there, as fw4 makes it.
- The host's header shows how long the host has been up, next to CPU and
  RAM, and when it booted on hover.

## 0.3.0 (2026-10-18)

### Added

- A Logs tab: the packets that rules with a log statement wrote to the
  host's kernel log, newest first, read from the journal, a syslog file,
  dmesg, or logread on OpenWrt. Each line names the rule its prefix belongs
  to and what the rule did with the packet; the same packet again within a
  second is one line with its count. hopdeck stores nothing: it reads the
  host's log.
- "Log drops" in the editor, for a base chain with policy drop: a last rule
  that counts every packet the policy drops and logs them, at most 50 a
  second, so a flood cannot fill the host's log.
- A Port forwards tab with a wizard: the protocol and ports, the incoming
  interfaces (chosen from the host's, with their addresses), the address of
  the host, the sources allowed, the target and its port, the interfaces
  towards it (suggested from the host's route), masquerade, hairpin NAT,
  logging and a limit of new connections. hopdeck writes the DNAT, lets
  the connections through every managed forward chain that would drop them
  (with replies, where nothing let them through yet), and warns of a forward
  chain of another tool, such as Docker's, that would drop them. Forwards
  are listed with their connections, and can be changed and removed; the
  changes go through the usual review and rollback.
- When the host does not forward packets (`net.ipv4.ip_forward`), the tab
  says so and offers to turn it on, now and at boot
  (`/etc/sysctl.d/90-hopdeck-forwarding.conf`) or until the next boot.
- Where the main nftables configuration, such as `/etc/nftables.conf`,
  defines a table hopdeck manages, a comment above it there says that
  hopdeck's file replaces the table at boot, so changes made there have no
  effect. It goes when that is no longer true.

### Changed

- A rule added in the editor, with "Add rule" or "Log drops", is scrolled
  into view and flashes, as it lands at the end of its chain.

### Fixed

- On RHEL, AlmaLinux and others with SELinux enforcing, the watchdog that
  systemd starts could not read its file: a change that cut hopdeck off was
  not rolled back when time ran out, and a packet trace left its table on
  the host. nft now reads the file from its standard input, which SELinux
  allows.

## 0.2.0 (2026-10-15)

### Added

- Windows 10 and 11 (x64 and arm64) as the machine hopdeck runs on, as
  `hopdeck.exe` in a zip. Windows' OpenSSH has no ControlMaster, so hopdeck
  keeps one SSH session per host and runs its commands through it. Keys with
  a passphrase are unlocked into Windows' OpenSSH agent service; as that
  agent takes no time limit, hopdeck removes a key itself when its time is
  up, or when hopdeck stops. The Windows machine itself is no host, and there
  is no sandbox there. The x64 executable was tried on Windows 10: adding a
  host, editing rules, history, CPU and memory. Not tried on Windows yet:
  unlocking a key into its agent since that first try (which failed with
  "agent refused operation", now fixed), generating keys, and the arm64
  executable, which is built the same way.
- `HOPDECK_SSH_SESSIONS=1` uses these sessions on Linux too, where ssh's
  ControlMaster does not work.
- The panel and the startup message link to the source code of the running
  version.
- SSH keys are generated in the panel: Ed25519, or RSA of 2048, 3072 or 4096
  bits, with a passphrase or, with a warning, without. hopdeck keeps the new
  key for its host, or adds it to `~/.ssh/config` (keeping a copy of the file
  as it was); with a passphrase it goes to the agent at once, and the key
  setup below puts it on the host.
- A key already in `~/.ssh` can be given to a host instead of a new one,
  kept by hopdeck or added to `~/.ssh/config` in the same way; the panel
  lists the private keys there that ssh does not offer the host yet.
- `HOPDECK_SSH_DIR` puts generated keys elsewhere than `~/.ssh`, and is
  where hopdeck looks for existing ones.
- Password fields can show what they hold, and say when Caps Lock is on or
  the value begins or ends with a space.

### Changed

- hopdeck is now under the GNU Affero General Public License, version 3 or
  later, instead of the GNU General Public License: whoever lets others use
  a changed hopdeck over a network must offer them its source. 0.1.0 and
  0.1.1 stay under the GPL.

### Security

- What a host prints can no longer drive the terminal hopdeck runs in: in
  error messages, its control characters are shown escaped, so a host
  cannot clear the screen, hide text or set the clipboard (OSC 52).
- A host printing one line without end over an SSH session (Windows) ends
  the session instead of filling this machine's memory.
- The password for the key setup goes only to a host whose key known_hosts
  has, even where the ssh config would take any host key.
- Names of tables and sets that nft input cannot hold (with `"` or control
  characters) are refused, as is a line break in a trace filter: nft knows no
  escapes in quoted names, and a line break ends a statement.
- A key file whose path ssh config cannot hold, or in which ssh would read
  `%` as a token, is not offered.
- Releases carry signed attestations of where their archives were built;
  README says how to check them.
- SECURITY.md says how to report a vulnerability.

### Fixed

- A key the agent refused was reported as a wrong passphrase; the agent's
  own message is shown now.
- A key unlocked for a host that still refused the login went on showing as
  needing its passphrase.

## 0.1.1 (2026-09-28)

### Fixed

- A host that stops accepting the login, say because an SSH key unlocked for
  a limited time left the agent, is no longer asked to log in every few
  seconds: sshd (PerSourcePenalties) and fail2ban answer that by shutting
  this machine's address out. hopdeck tries once, then waits for a
  reconnect, and shows the key panel so the key can be unlocked again; the
  rules are read again once it is.
- A port already in use ended hopdeck with Node.js's error message.
- Error hints in the rules showed "{{destination}}" instead of the host.

### Changed

- Without `--port`, hopdeck takes the first free port from 7400 to 7419, and
  says which ports were taken and by what: another hopdeck (with its address)
  or another program. `--port` (or `HOPDECK_PORT`) still means that port.
- `pnpm dev` picks free ports for the API and the UI.

## 0.1.0 (2026-09-27)

The first release: a local web panel for nftables on the machine it runs on
and on hosts reached over SSH. One executable for Linux (x64 and arm64) that
brings its own Node.js; it needs only libatomic from the system
(`apt install libatomic1`, or `dnf install libatomic`), which many installs
have. See the README for installing it.

### Firewall

- Every table, chain, set, map and rule, as a tree, a table of rules or text,
  and the path a packet takes through all hooks and priorities.
- A visual editor for rules, chains, sets and maps, with a text mode that
  takes anything nft does; set and map elements change live.
- Every change is checked by the host's own nft, shown as a diff, applied
  atomically, changed rule by rule where it can be, and rolled back unless
  confirmed. Tables of other tools (Docker, firewalld, fail2ban) are left
  alone; hopdeck changes only the tables it manages.
- Persistence across reboots, packet tracing, live counters, and notice of
  changes made on the host outside hopdeck.
- A history kept on each host: every version with who made it, from where and
  with which SSH key, and a way back to any of them.

### Hosts

- The local machine, and SSH hosts as ~/.ssh/config describes them
  (ProxyJump, ssh-agent, FIDO keys). Host keys are shown and accepted only on
  confirmation.
- Root, sudo without a password, and sudo with one, kept in memory only.
- SSH keys with a passphrase are unlocked from the panel into the ssh-agent
  for as long as chosen; a key not yet on a host is put there with one
  password login, and hopdeck says what in sshd keeps keys out and can let
  them in.
- CPU and memory use of each host.
- Tested on Debian 11, 12 and 13, AlmaLinux 9 and 10 (RHEL), and Alpine;
  OpenWrt is read-only for now.

### Panel

- English and Polish.
- A sandbox host with a demo firewall (`--sandbox`), which never touches the
  real one.

### Not yet

- Windows and macOS as the machine hopdeck runs on.
- Changing OpenWrt's firewall (through UCI).
- Kernels older than the test machine's (5.10 of Debian 11, 5.14 of RHEL 9)
  are untested.
