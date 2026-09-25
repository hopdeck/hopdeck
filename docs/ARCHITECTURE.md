# nftm architecture

Status: draft, agreed on 2026-09-24. Update it when a decision changes.

nftm is a GUI for nftables that can do everything nftables can do, only
easier. It manages the local machine and remote hosts over SSH.

## Principles

1. **Lossless.** The data model is the libnftables JSON format
   (libnftables-json(5)). Constructs nftm understands get structured editors;
   everything else is shown as nft text or raw JSON and passed through
   untouched. A plain text editor is always available as the escape hatch.
2. **The host's own `nft` parses and validates.** nftm contains no nft grammar.
   Each host decides what is valid for its nft and kernel version.
3. **Never break what nftm does not own.** No `flush ruleset`. Tables of other
   tools (Docker, firewalld, libvirt, fail2ban, iptables-nft, ...) are
   read-only.
4. **Every change is reversible.** Validate, show a diff, apply atomically,
   roll back automatically unless the user confirms.
5. **Agentless.** Hosts need `nft`, `sh` and optionally systemd. Nothing is
   installed on them.
6. **Host output is untrusted.** A compromised host must not be able to attack
   the admin's browser or machine through what it prints.

## Decisions

| Topic | Choice | Why |
|---|---|---|
| Form factor | Local web panel in the browser | Rich UI ecosystem: graph layout, code editors, diff views. A desktop wrapper can come later. |
| Language | TypeScript everywhere | One model shared by the server, the UI and the CLI |
| Runtime | Node.js 24 LTS | Runs `.ts` directly (type stripping), so the server and the CLI need no build step |
| Package manager | pnpm 12 | Safe dependency defaults, see [Dependency policy](#dependency-policy) |
| UI | React + Vite | Ecosystem for the complex editors listed in [UI plan](#ui-plan) |
| Transport | System OpenSSH (`ssh` binary) | Honours `~/.ssh/config`, ProxyJump, ssh-agent, FIDO keys, known_hosts |
| Source of truth | Live host first (model A), project files later (model B) | Same pipeline; see [Model B](#model-b-future) |
| Privileges | Root login, or sudo: passwordless, or a password typed in the panel | See [Talking to hosts](#talking-to-hosts) |
| UI languages | English and Polish | One JSON file per language; adding one needs no code changes |
| Styling | Plain CSS with design tokens, light and dark theme, system fonts | No UI framework to trust or update; the CSP blocks external fonts anyway |
| Managed hosts | Debian 11+ (nft 0.9.8), RHEL 9+ | Admin machine: Linux; macOS likely works; Windows later |
| License | GPL-3.0-or-later | |

## Components

```
 browser ── packages/web (React)
    │  HTTP (+ WebSocket later), 127.0.0.1 only, token
 nftm backend ── packages/server, started by packages/cli
    │  Executor: local, system ssh, or sandbox namespace
 managed host ── nft, sh, systemd-run
```

| Package | Role |
|---|---|
| `packages/core` | No I/O; runs in Node and in the browser. libnftables JSON types, ruleset parsing and grouping; later normalization, diff, ownership rules, transaction building. Defines the `Executor` and `RulesetSource` interfaces. |
| `packages/server` | HTTP API, access control, executors, host inventory, snapshots, the apply pipeline, audit log |
| `packages/web` | The UI |
| `packages/cli` | The `nftm` command. Starts the panel; later also `diff`, `apply` and `rollback` for scripting. |

The two seams that keep options open are in
[`packages/core/src/host.ts`](../packages/core/src/host.ts):

- `Executor` runs a command on one host. Implementations: local, SSH, and
  possibly an agent later.
- `RulesetSource` supplies the ruleset being edited. Implementations: a live
  host (model A), a project (model B).

## Talking to hosts

There are three kinds of hosts, one `Executor` implementation each:

| Kind | How commands run |
|---|---|
| **Local** | Spawned directly, never through a local shell |
| **SSH** | System `ssh` with ControlMaster (see below) |
| **Sandbox** | `nsenter` into a private user and network namespace (see [Sandbox host](#sandbox-host)) |

**SSH command line.** The SSH executor runs `ssh -o BatchMode=yes
-o ControlMaster=auto -o ControlPath=... -o ControlPersist=... -- DEST
<quoted argv>`. Each nftm host gets its own ControlPath, a hash of the exact
destination and ssh config file. ssh's own `%C` hashes the resolved user,
address and port instead, so two aliases of one server would share a
connection and the second would skip its host key check (found on the test
host). ssh joins its arguments into one command line for the remote
login shell, so every argument is single-quoted. The login shell must be
POSIX-compatible (sh, bash, dash, zsh, ksh, ash); fish and csh are not
supported.

**SSH authentication.** Keys or ssh-agent only; no SSH passwords. `BatchMode`
rules out interactive prompts. An unknown host key makes the connection fail:
the panel then shows the key's fingerprint, and adds it to `known_hosts` only
after the user confirms. Keys are never accepted automatically.

**Host keys** (`hosts/host-keys.ts`). `ssh -G` gives the host's effective
settings (known_hosts files, host name form, hashing). To read the key the
server presents, nftm runs ssh with every authentication method off and a
throwaway known_hosts in `accept-new` mode: the key is recorded during key
exchange and nothing is sent to the unverified server. Unlike `ssh-keyscan`,
this honours ProxyJump. On confirmation the server is asked again, and the key
is written only if its fingerprint is still the one the user saw. A changed
key is replaced only on explicit request, through `ssh-keygen -R` (which keeps
`FILE.old`); keys in system-wide files are left to root.

**Privileges.** nft needs root. On connect nftm checks, in order:

1. `id -u` is 0 (root login, or the sandbox): run nft directly.
2. `sudo -n <nft> --version` succeeds: prefix commands with `sudo -n --`.
3. sudo wants a password: the panel asks for it once per host and session.
   nftm keeps it in backend memory only, never on disk, and sends it with
   `sudo -S -p ''` as the first line of standard input. Consequence: under
   `sudo -S` a ruleset is never piped to `nft -f -`. It is uploaded to a file
   first, because a password line mixed into the ruleset could end up in
   nft's error message.
4. Otherwise the host is read-only: nothing can be listed or changed.

A sudoers rule that allows only `nft` is **not** a real restriction:
`nft -f /any/file` run as root prints lines of that file in its error messages.
It reduces mistakes, nothing more.

**nft location.** `/usr/sbin` is often missing from a normal user's PATH, so
the absolute path of `nft` is detected once per host and used everywhere.

**Host facts.** On connect, nftm also collects: nft and kernel versions,
systemd presence, distribution and its persistence file, and which tables
belong to other tools.

## Sandbox host

`unshare -rn` creates a user and network namespace without root, on
distributions that allow unprivileged user namespaces (Debian 11+ does). A
keep-alive process holds the namespace open, and each command enters it with
`nsenter --preserve-credentials`. Inside, nftm is root with its own empty
nftables ruleset. The real firewall is never touched.

- **Development and tests:** every feature can be exercised against a real
  `nft` without root and without the risk of a lockout.
- **Later, for users:** a place to try a ruleset before applying it anywhere.

The keep-alive process reads its standard input from nftm. When nftm exits,
even by crashing, the input closes, the process ends and the namespace
disappears with it.

## Reading, validating, converting

- Read: `nft -j list ruleset`, then `parseRuleset` from core. The text of
  each rule, base chain definition and set/map/object block comes from
  `nft -a list ruleset` (`parseListing`), matched to the JSON by handle, so
  the UI shows exactly what the host's nft prints and needs no nft printer.
- Validate: `nft -c -f -` on the host.
- Convert text to JSON and normalize: load the ruleset into a throwaway network
  namespace and list it back (`unshare -rn` works without root when
  unprivileged user namespaces are enabled). This is needed for diffs: the
  kernel rewrites rules (`10.0.0.1/8` becomes `10.0.0.0/8`, port lists become
  anonymous sets), so comparing the text as written does not work.
  [`scripts/nft-fixture.sh`](../scripts/nft-fixture.sh) uses the same
  technique for test fixtures.
- Limitation: the namespace has only `lo`. Constructs bound to real interfaces
  (flowtables, netdev chains, `iif "eth0"`) need dummy interfaces with the same
  names created there first.

## Ownership and coexistence

- nftm edits only tables it manages: ones it created, or ones the user
  **adopted** with an explicit action. Everything else stays visible
  (including in the packet path view) but read-only.
- **Marker:** a managed table carries `comment "managed by nftm"`, visible in
  a plain `nft list ruleset` and independent of which admin machine connects.
  nft cannot add a comment to an existing table: `nft add table ... {
  comment ... }` exits 0 and silently changes nothing (nft 1.1.3). Adopting
  therefore rewrites the table in one transaction (`table X {}`, `delete
  table X`, then the table as listed plus the comment), which keeps counter
  values and dynamic set elements with their expiry. It goes through the same
  pipeline as any change: diff, validation, automatic rollback. Tables of
  other tools cannot be adopted.
- **Manual override** (PL: Ręczne sterowanie). A per-host switch that lifts
  the ownership rule: any table can be edited without adopting, including
  other tools' tables (each with a warning that the tool may overwrite the
  change). It lasts for the session only, is never saved to disk, shows a
  short warning when switched on, stays visible as a banner, and is noted in
  the change log. It never switches off the safety net (validation, diff,
  atomic apply, rollback, fresh-connection check). Tables with xt
  expressions stay read-only even then: nft cannot recreate those
  statements, so rewriting them would silently lose rules.
- Owners are guessed (`tableOwner` in core) and the UI always shows the
  evidence: the iptables-nft marker nft prints, xt expressions, iptables chain
  names, or a known tool's table name (firewalld, fail2ban, libvirt, ...).
- Tables written by iptables-nft contain `xt` expressions that nft cannot
  recreate. They are always read-only.
- There are two ways to change a managed table:
  - **Replace the whole table** in one transaction. Both editors do this
    today. Lines the editor did not touch go back exactly as nft printed them,
    so unchanged rules keep their counter values (`counter packets N bytes M`)
    and sets keep their elements; edited rules start counting from zero.
  - **Targeted changes by rule handle** (later). Needed where a replacement
    would disturb live state, e.g. sets filled by the data path.

## Applying changes

Implemented in [`packages/server/src/hosts/deploy.ts`](../packages/server/src/hosts/deploy.ts).
A change is a list of table operations: adopt, replace (or create), delete.

1. **Plan.** Ownership rules decide what may change (see above). Each table
   is read with `nft list table` (the rollback is built from that, so
   counter values and set elements come back too). A replacement must be a
   single, indented block for the named table, without `include`. The change
   and the way back are written as `table X {}; delete table X; ...` scripts
   into a private directory on the host (`mktemp -d`, mode 0700), and **both**
   are checked with `nft -c`: nftm applies nothing it could not undo. The UI
   shows the diff, nft's verdict and how the change is protected.
2. **Apply.** First, the tables are compared with the plan, ignoring counter
   values, quota usage and expiry countdowns; if someone changed them
   meanwhile, nftm stops. Then the **watchdog** is armed: a small POSIX script
   that, unless a `confirmed` file appears within the deadline (60 s by
   default), restores the tables from the rollback script. It runs as a
   transient systemd unit when root may start one, otherwise as a process
   detached with `setsid` (hosts without systemd, the sandbox), or as the
   login user calling `sudo -n nft` when sudo allows only nft. If none is
   possible, nftm refuses to apply. The change is applied with `nft -f` in one
   transaction.
3. **Check.** For SSH hosts, a new connection that shares nothing with the
   existing one runs `true`. An existing connection usually survives a rule
   that blocks every new one (thanks to `ct state established`), so it would
   report a false "works". If the new connection fails, nftm undoes the change
   at once through the existing connection. Afterwards nftm checks whether the
   watchdog already fired (a check can outlast a short deadline) and reports
   what really happened.
4. **Confirm or roll back.** Keeping the change creates `confirmed`; the
   watchdog then removes the directory. "Roll back now" restores the tables
   through nft. Without a decision the host rolls back by itself, and nftm
   reads the watchdog's record to report it. Directories older than a day are
   cleaned up by the next deployment.
5. **Persist** ([`persist.ts`](../packages/server/src/hosts/persist.ts)). A
   kept change is saved for boot at once: each managed table goes to
   `/etc/nftm/<family>-<name>.nft` (counters at zero, expiring elements with
   their full timeout), written as root through a staged file and a rename;
   a deleted table's file is removed. Tables changed with Manual override that
   nftm does not manage are not saved: their owner decides what loads at boot.
   The file loaded at boot is read from the nftables service's command line
   (`systemctl show -p ExecStart`), else found at its usual path. With the
   user's consent, nftm adds `include "/etc/nftm/*.nft"` at its end, keeping a
   dated copy, and checks the whole file with `nft -c`, putting the copy back
   if nft rejects it. Because the include comes last, nftm's copy of a table
   replaces a definition earlier in the file; the UI says when a table is
   defined there too, since deleting it in nftm does not remove it from there.
   Saving needs root: with sudo for nft only, the UI explains why it cannot.
   Tested with a real restart of the Debian test host.

Every step is logged as a JSON line in `changes.log` next to `hosts.json`.

## Local panel security

The backend holds root-level SSH access to firewalls. Any website open in the
browser, and any local user, can send requests to `127.0.0.1`.
Implemented in [`packages/server/src/security.ts`](../packages/server/src/security.ts):

- **Binding:** listens on `127.0.0.1` only.
- **Token:** a random 256-bit token per run. It is printed in the URL
  *fragment* (`/#token=...`), which browsers never send to servers. The UI
  moves it to sessionStorage and sends `Authorization: Bearer`.
- **Host header:** must be `127.0.0.1:<port>` or `localhost:<port>`. This
  defeats DNS rebinding.
- **Origin header:** when present, must be the panel itself, or the Vite dev
  server in `--dev` mode.
- **Response headers:** no CORS headers. CSP `default-src 'self';
  frame-ancestors 'none'`, plus `nosniff` and `no-referrer`.
- **WebSocket (later):** same checks. Browsers cannot set headers on
  WebSocket connections, so the token goes in the first message.
- **Host output:** rendered as text, never as HTML and never evaluated.

## Dependency policy

The npm supply chain is a real risk for a tool with this access.

- Keep backend dependencies minimal and prefer Node built-ins. The server
  currently has none.
- pnpm blocks dependency build scripts by default. Adding one to `allowBuilds`
  needs a review.
- `minimumReleaseAge` is 7 days and `trustPolicy` is `no-downgrade`, set in
  [`pnpm-workspace.yaml`](../pnpm-workspace.yaml).
- The lockfile is committed, and lockfile changes get reviewed.

## UI plan

- Host list, ruleset tree, text view.
- **Packet path view:** base chains from all tables, ordered by hook and
  priority. This is the most confusing part of nftables, and nothing else
  shows it well.
- **Table editor** with two modes over the same table:
  - **Visual**, MikroTik style: a grid per chain (action, protocol, addresses,
    ports, interfaces, connection state, other statements, comment, counter),
    reordering, copying and deleting rules, the base chain policy, and a
    dialog with tabs to edit one rule with a live preview of its nft text.
    A rule gets the form only when the form renders back exactly what nft
    printed (`ruleForm` in core); any other rule stays in the grid as nft
    text and is edited as text, so the form never drops part of a rule.
  - **Text**: the whole table in nft syntax. A textarea over highlighted text
    keeps selection, clipboard and undo native without an editor dependency.
  - Errors from `nft -c` name lines of the change file; the panel maps them
    to lines of the text and rows of the grid.
  - Text edits cannot be turned back into the grid, so after editing text by
    hand the visual mode stays off until the change is applied or discarded.
  - A new table starts in the same editor and reaches the host through the
    same review; it is created with the nftm marker, so nftm manages it from
    the start.
- **Diff view** before every apply.
- **Set and map editor** that adds and removes elements live, without
  reloading the ruleset.
- **Packet tracing:** `meta nftrace set 1` plus `nft monitor trace`, drawn as
  the path through the rules.
- **Live data:** counters and events from `nft monitor`.

## Milestones

1. **Read-only** (done, 2026-09-24). Sandbox, local and SSH executors, host
   facts and privilege detection, tree and text views, packet path diagram.
   Tested against a real Debian 13 host over SSH (`dev/test-host`), including
   confirming unknown and changed host keys in the panel.
2. **Text-mode editing** of managed tables, with diff, safe apply with
   rollback, and persistence (done, 2026-09-25). From here nftm can do
   everything nftables can: safe apply with the watchdog, adopting and
   deleting tables, Manual override, persistence across reboots, the text
   editor.
3. **Structured rule forms** and live set/map element editing. This is where
   "easier" starts. Done so far: the visual rules grid and the rule dialog,
   creating tables (empty, or from a host firewall template) and adding or
   deleting chains. Next: sets and maps, targeted changes.
4. **Monitoring:** tracing, `nft monitor`, live counters.
5. **Model B** (project layer).

Text mode comes before forms on purpose: it gives full power immediately, and
forms add convenience without ever limiting what can be done.

## Model B (future)

- **Project format:** structured files in git. Rule content stays native
  nftables; the format only adds variables, templates and a host inventory
  (groups, per-host variables).
- **Variables vs named sets:** where a variable is a list of addresses or
  ports, prefer an nftables named set. It is native and can be updated live.
- **Compile:** project plus host variables produce a per-host ruleset, which
  the host's nft validates.
- **Drift detection:** compare the normalized expected ruleset with the live
  one, then let the user either overwrite the host or import its changes.
- **Import:** create a project from a live host.
- **Integration:** it is just another `RulesetSource`; the apply pipeline stays
  the same.

## Future: beyond nftables on servers

The project is meant to grow into managing OpenWrt routers and other parts of
Linux networking. That makes the platform layer pluggable: the same UI over
different ways of reading and changing a host.

- **OpenWrt goes through UCI, never straight to nftables.** UCI
  (`/etc/config/firewall`) is OpenWrt's source of truth: firewall4 generates
  `inet fw4` from it (recognised already as another tool's table), and LuCI
  reads and writes only UCI. Direct nft changes would be invisible to LuCI
  and lost on the next firewall reload. nftm will edit UCI with `uci` or
  ubus, so everything it does shows up in LuCI and the other way round.
- **Full nftables power there** comes from fw4's nftables includes (UCI
  `config include` entries of type `nftables`, and `/etc/nftables.d/*.nft`),
  which LuCI also shows.
- **Safe apply there** should use OpenWrt's own apply with rollback (rpcd
  `uci apply` with a rollback timeout, then `confirm`), the mechanism LuCI
  uses, rather than nftm's systemd timer.
- **No server assumptions on hosts:** OpenWrt has procd instead of systemd,
  root login instead of sudo, dropbear instead of an OpenSSH server, and
  BusyBox instead of GNU tools.

## Open questions

- **Table comments on old systems:** they need nft 0.9.7+ and kernel
  support; check on Debian 11 and RHEL 9 before relying on them there.
- **Windows as the admin machine:** its OpenSSH has no ControlMaster.
- **Distribution:** npm package, Node single executable, distribution packages,
  or a desktop wrapper.
- **Local state:** the host inventory format and how long snapshots are kept.
- **Sandbox for users:** should the sandbox become a regular feature, and should
  it copy the interfaces of a real host (as dummy interfaces)?
