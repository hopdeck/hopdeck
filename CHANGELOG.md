# Changelog

## Unreleased

### Added

- Windows 10 and 11 (x64 and arm64) as the machine hopdeck runs on, as
  `hopdeck.exe` in a zip. Windows' OpenSSH has no ControlMaster, so hopdeck
  keeps one SSH session per host and runs its commands through it. Keys with
  a passphrase are unlocked into Windows' OpenSSH agent service; as that
  agent takes no time limit, hopdeck removes a key itself when its time is
  up, or when hopdeck stops. The Windows machine itself is no host, and there
  is no sandbox there. The x64 executable was tested on Windows 10; the
  arm64 one is built the same way, but has not been tried on such a machine
  yet.
- `HOPDECK_SSH_SESSIONS=1` uses these sessions on Linux too, where ssh's
  ControlMaster does not work.
- The startup message links to the source code.

### Fixed

- A key the agent refused was reported as a wrong passphrase.

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
