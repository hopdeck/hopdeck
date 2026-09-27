# hopdeck architecture

Status: draft, agreed on 2026-09-24. Update it when a decision changes.

hopdeck is a local panel for running networks. It manages the local machine
and remote hosts over SSH. Its first module, and so far the only one, is a GUI
for nftables that can do everything nftables can do, only easier; more network
tools, such as a topology view, come later.

## Principles

1. **Lossless.** The data model is the libnftables JSON format
   (libnftables-json(5)). Constructs hopdeck understands get structured editors;
   everything else is shown as nft text or raw JSON and passed through
   untouched. A plain text editor is always available as the escape hatch.
2. **The host's own `nft` parses and validates.** hopdeck contains no nft grammar.
   Each host decides what is valid for its nft and kernel version.
3. **Never break what hopdeck does not own.** No `flush ruleset`. Tables of other
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
| Name | hopdeck (decided 2026-09-27; formerly nftm) | The tool grows beyond the firewall, so the name is about networks, not nftables. Free on npm and GitHub, and no network tool of that name exists. Tables adopted as nftm keep their old marker until their next change, see [Ownership and coexistence](#ownership-and-coexistence). |
| Form factor | Local web panel in the browser | Rich UI ecosystem: graph layout, code editors, diff views. A desktop wrapper can come later. |
| Language | TypeScript everywhere | One model shared by the server, the UI and the CLI |
| Runtime | Node.js 24 LTS | Runs `.ts` directly (type stripping), so the server and the CLI need no build step |
| Package manager | pnpm 12 | Safe dependency defaults, see [Dependency policy](#dependency-policy) |
| UI | React + Vite | Ecosystem for the complex editors listed in [UI plan](#ui-plan) |
| Transport | System OpenSSH (`ssh` binary) | Honours `~/.ssh/config`, ProxyJump, ssh-agent, FIDO keys, known_hosts |
| Source of truth | Live host first (model A), project files later (model B) | Same pipeline; see [Model B](#model-b-future) |
| Privileges | Root login, or sudo: passwordless, or a password typed in the panel | See [Talking to hosts](#talking-to-hosts) |
| polkit | Not used (decided 2026-09-25) | Plain `pkexec` asks for the password on every nft call. Doing it properly needs a root-owned helper and a polkit action installed on the machine, and the lighter alternative (one pkexec per session) hands the panel an unrestricted root channel. It would help only the local host in a graphical session; sudo covers every case. |
| UI languages | English and Polish | One JSON file per language; adding one needs no code changes |
| Styling | Plain CSS with design tokens, light and dark theme, system fonts; the look of a network tool: dense, hairlines instead of cards, 2 px corners, no shadows, monospace for data, one signal colour (amber) | No UI framework to trust or update; the CSP blocks external fonts anyway. Dense and plain like Wireshark or htop, not a generic dashboard |
| Managed hosts | Debian 11+ (nft 0.9.8), RHEL 9+ | Admin machine: Linux; macOS likely works; Windows later |
| License | GPL-3.0-or-later | |

## Components

```
 browser ── packages/web (React)
    │  HTTP (+ WebSocket later), 127.0.0.1 only, token
 hopdeck backend ── packages/server, started by packages/cli
    │  Executor: local, system ssh, or sandbox namespace
 managed host ── nft, sh, systemd-run
```

| Package | Role |
|---|---|
| `packages/core` | No I/O; runs in Node and in the browser. libnftables JSON types, ruleset parsing and grouping; later normalization, diff, ownership rules, transaction building. Defines the `Executor` and `RulesetSource` interfaces. |
| `packages/server` | HTTP API, access control, executors, host inventory, snapshots, the apply pipeline, audit log |
| `packages/web` | The UI |
| `packages/cli` | The `hopdeck` command. Starts the panel; later also `diff`, `apply` and `rollback` for scripting. |

**Modules.** Each network tool is a module with a `firewall/`-style
directory in core, server and web; the firewall (nftables) is the first. What
every module needs stays outside them: hosts, executors, privileges and
staging files (`server/src/hosts`), the API shapes and the line diff (core),
and the host view, whose tab bar groups tabs by module. A module that spans
hosts, like a topology view, gets its own place beside the host list.

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
<quoted argv>`. Each hopdeck host gets its own ControlPath, a hash of the exact
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
server presents, hopdeck runs ssh with every authentication method off and a
throwaway known_hosts in `accept-new` mode: the key is recorded during key
exchange and nothing is sent to the unverified server. Unlike `ssh-keyscan`,
this honours ProxyJump. On confirmation the server is asked again, and the key
is written only if its fingerprint is still the one the user saw. A changed
key is replaced only on explicit request, through `ssh-keygen -R` (which keeps
`FILE.old`); keys in system-wide files are left to root.

**Privileges.** nft needs root. On connect hopdeck checks, in order:

1. `id -u` is 0 (root login, or the sandbox): run nft directly.
2. `sudo -n <nft> --version` succeeds: prefix commands with `sudo -n --`.
3. sudo wants a password: the panel asks for it once per host and session.
   hopdeck keeps it in backend memory only, never on disk, and sends it with
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

**Host facts.** On connect, hopdeck also collects: nft and kernel versions,
systemd presence, distribution and its persistence file, and which tables
belong to other tools.

## Sandbox host

`unshare -rn` creates a user and network namespace without root, on
distributions that allow unprivileged user namespaces (Debian 11+ does). A
keep-alive process holds the namespace open, and each command enters it with
`nsenter --preserve-credentials`. Inside, hopdeck is root with its own empty
nftables ruleset. The real firewall is never touched.

- **Development and tests:** every feature can be exercised against a real
  `nft` without root and without the risk of a lockout.
- **Later, for users:** a place to try a ruleset before applying it anywhere.

The keep-alive process reads its standard input from hopdeck. When hopdeck exits,
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

- hopdeck edits only tables it manages: ones it created, or ones the user
  **adopted** with an explicit action. Everything else stays visible
  (including in the packet path view) but read-only.
- **Marker:** a managed table carries `comment "managed by hopdeck"`, visible in
  a plain `nft list ruleset` and independent of which admin machine connects.
  nft cannot add a comment to an existing table: `nft add table ... {
  comment ... }` exits 0 and silently changes nothing (nft 1.1.3). Adopting
  therefore rewrites the table in one transaction (`table X {}`, `delete
  table X`, then the table as listed plus the comment), which keeps counter
  values and dynamic set elements with their expiry. It goes through the same
  pipeline as any change: diff, validation, automatic rollback. Tables of
  other tools cannot be adopted. `managed by nftm`, the marker from before
  the rename, still counts; for the same reason it stays until the table's
  next change, which writes the current one.
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
- There are three ways to change a managed table:
  - **Replace the whole table** in one transaction, when more than rules
    changes.
    Lines the editor did not touch go back exactly as nft printed them, so
    unchanged rules keep their counter values (`counter packets N bytes M`);
    edited rules start counting from zero. The editor also sends the table as
    it first showed it (`base`), and the server takes every set, map or other
    object the user left alone from the host as it is at planning time, so
    elements that expired while the editor was open stay gone.
  - **Elements in place**: `delete element` and `create element` for one set
    or map, from its Elements dialog, like a MikroTik address list. The rest
    of the table is not touched. The rollback flushes the set and adds back
    the elements as nft listed them, with timeouts, expiry, counters and
    comments. Between review and apply only the set's declaration must stay
    the same, since elements come and go on their own.
  - **Rule by rule** (`ruleCommands` in core): when an edited table differs
    from the host's only in rules (chains, their type and policy, sets, maps,
    objects and the table's comment all the same, counter values aside), the
    change is planned as commands on those rules by handle: `replace rule`
    where a rule changed in its place, `delete rule`, `insert rule` before the
    next unchanged rule and `add rule` at the end. The rules left alone keep
    their handles, counters and limit state. nft checks the whole definition
    first, so its messages still name lines the editor shows, then the
    commands; if only the commands fail (the table changed a moment ago), the
    table is replaced whole after all. At apply the handles must still be
    those of the plan. The rollback puts back the whole table, as for a
    replacement. The review says which way a table is changed, and shows the
    commands.

## Applying changes

Implemented in [`packages/server/src/firewall/deploy.ts`](../packages/server/src/firewall/deploy.ts).
A change is a list of table operations: adopt, replace (or create), delete.

1. **Plan.** Ownership rules decide what may change (see above). Each table
   is read with `nft list table` (the rollback is built from that, so
   counter values and set elements come back too). A replacement must be a
   single, indented block for the named table, without `include`. The change
   and the way back are written as `table X {}; delete table X; ...` scripts
   into a private directory on the host (`mktemp -d`, mode 0700), and **both**
   are checked with `nft -c`: hopdeck applies nothing it could not undo. The UI
   shows the diff, nft's verdict and how the change is protected.
2. **Apply.** First, the tables are compared with the plan, ignoring counter
   values, quota usage and expiry countdowns; if someone changed them
   meanwhile, hopdeck stops. Then the **watchdog** is armed: a small POSIX script
   that, unless a `confirmed` file appears within the deadline (60 s by
   default), restores the tables from the rollback script. It runs as a
   transient systemd unit when root may start one, otherwise as a process
   detached with `setsid` (hosts without systemd, the sandbox), or as the
   login user calling `sudo -n nft` when sudo allows only nft. If none is
   possible, hopdeck refuses to apply. The change is applied with `nft -f` in one
   transaction.
3. **Check.** For SSH hosts, a new connection that shares nothing with the
   existing one runs `true`. An existing connection usually survives a rule
   that blocks every new one (thanks to `ct state established`), so it would
   report a false "works". If the new connection fails, hopdeck undoes the change
   at once through the existing connection. Afterwards hopdeck checks whether the
   watchdog already fired (a check can outlast a short deadline) and reports
   what really happened.
4. **Confirm or roll back.** Keeping the change creates `confirmed`; the
   watchdog then removes the directory. "Roll back now" restores the tables
   through nft. Without a decision the host rolls back by itself, and hopdeck
   reads the watchdog's record to report it. Directories older than a day are
   cleaned up by the next deployment.
5. **Persist** ([`persist.ts`](../packages/server/src/firewall/persist.ts)). A
   kept change is saved for boot at once: each managed table goes to
   `/etc/hopdeck/firewall/<family>-<name>.nft` (counters at zero, expiring elements with
   their full timeout), written as root through a staged file and a rename;
   a deleted table's file is removed. Tables changed with Manual override that
   hopdeck does not manage are not saved: their owner decides what loads at boot.
   The file loaded at boot is read from the nftables service's command line
   (`systemctl show -p ExecStart`), else found at its usual path. With the
   user's consent, hopdeck adds `include "/etc/hopdeck/firewall/*.nft"` at its end, keeping a
   dated copy, and checks the whole file with `nft -c`, putting the copy back
   if nft rejects it. Because the include comes last, hopdeck's copy of a table
   replaces a definition earlier in the file; the UI says when a table is
   defined there too, since deleting it in hopdeck does not remove it from there.
   Saving needs root: with sudo for nft only, the UI explains why it cannot.
   Tested with a real restart of the Debian test host.

Every step is logged as a JSON line in `changes.log` next to `hosts.json`,
and on the host with `logger -t hopdeck`. A kept change also becomes a version
in the host's [history](#history).

## History

Each host keeps the history of the tables hopdeck manages
([`history.ts`](../packages/server/src/firewall/history.ts)), so every admin who
connects sees the same one, from whichever computer.

- **Versions.** A version is the managed tables at one moment, as nft lists
  them with counters at zero and without expiry, one `.nft` file each, plus a
  `meta.json`: when, what kind, who, which deployment, and what the change
  touched (including tables changed with Manual override, which have no file).
  Kinds:
  - *change*: made with hopdeck and kept; written right after the boot files;
  - *outside*: the managed tables differ from the newest version, so something
    else changed them;
  - *baseline*: the managed tables as hopdeck first found them.

  A restore is a change that names the version it put back. Versions are never
  rewritten.
- **On disk.** `<stateDir>/firewall/history/000042/` (see [Platforms](#platforms)),
  i.e. `/var/lib/hopdeck/firewall/history` on Linux: root's, mode 700, readable
  on the host with `ls` and `diff -r`. Files get there through the same checked
  copy as boot files. `mkdir` claims a version's number, so two panels writing
  at once get different ones, and `meta.json` is written last: a directory
  without it is incomplete and not shown.
- **Outside changes** are noticed whenever hopdeck looks at the ruleset anyway:
  reading it, live polling, planning a change. It compares a fingerprint of the
  managed tables' content with the newest version's: without handles (a table
  loaded again, e.g. at boot, gets new ones), counters, quota use, expiry and
  set elements (sets fill themselves). A difference becomes an outside version,
  noticed by whoever's hopdeck looked. Limits: changes between two looks merge
  into one; one undone before a look leaves no trace; element changes alone go
  unnoticed; who made it is unknown. While hopdeck itself changes the host
  (applying, awaiting confirmation) it records nothing, but another admin's
  hopdeck may record that pending change as an outside one. Recording
  everything would need something running on the host all the time, an agent.
- **Author:** `user@computer` of whoever ran hopdeck, as that hopdeck reports
  it; then what the host saw: the login, the SSH connection's address and port
  (`SSH_CONNECTION`), and sshd's log line for that connection ("Accepted
  publickey for root from 10.0.0.5 port 51234 ssh2: ED25519 SHA256:…"), from the
  journal or `/var/log/auth.log` / `/var/log/secure`, looked up once per
  connection. A login user who can edit their shell's startup files could change
  `SSH_CONNECTION`, and so which log line is found; the history is as
  trustworthy as root on the host.
- **Size limit** in `/etc/hopdeck/settings.json` on the host
  (`history.maxBytes`: 10 MiB by default, 1 MiB to 10 GiB), so every admin
  shares it; the host's Settings tab edits it. After each write the oldest
  versions go while `du` counts more than the limit, but the newest 10 always
  stay.
- **Restoring** builds ordinary changes (replace the tables that differ, delete
  managed tables the version lacks) that go through the usual review, apply
  and rollback; one table can be put back alone.
- **No history** where root is out of reach (sudo for nft only), on read-only
  platforms, and on hosts without managed tables and without a history yet:
  looking at a host does not start one. The sandbox keeps its history in its
  temporary directory.

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
- **Browser console:** the panel warns there, in the UI language, not to
  paste anything: pasted code runs with the panel's token (self-XSS scams).
- **Weak tokens:** a `HOPDECK_TOKEN` shorter than 32 characters draws a warning.

## Files on managed hosts

Deployments and traces keep files on the host (nft input, the watchdog
script, logs) that root reads and runs, so whoever can change them acts as
root ([`staging.ts`](../packages/server/src/hosts/staging.ts)).

- **Root login, passwordless sudo:** the login user can become root anyway;
  the files live in a private directory of theirs (`mktemp -d`, mode 700).
- **sudo for nft only:** root never runs their files; the watchdog runs as
  the user and calls `sudo nft`.
- **sudo with a password:** the password is what keeps the login user from
  root, so any process of theirs must not be able to swap `watchdog.sh` or
  `change.nft` between hopdeck writing and root using them. The directory
  belongs to root (mode 700), and every file gets in through a copy root
  makes and checks against the SHA-256 hopdeck computed; a swapped file fails
  the check and nothing is used. Boot files in `/etc/hopdeck/firewall` are
  written the same way.
- Commands take their arguments as argv, never through a local shell; over
  SSH each argument is quoted. Values that go into nft input (table
  definitions, elements, trace filters) are checked first: one table block
  whose braces stay open until its last line (a brace or ";" mid-line would
  otherwise let the rest act on other tables), no `include` anywhere outside
  strings (nft reads one after ";" inside a chain and prints the file in its
  error), one element, values only. A table changed rule by rule passes the
  same check whole first, and a rule with ";" outside a string is changed with
  the whole table instead, since on a command line ";" starts another command.
- What a host prints is capped at 256 MiB per stream; a command over the cap,
  or over its time, is killed and its pipes closed, so a program it started
  cannot keep writing.

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
  - **Visual**, inspired by MikroTik but not limited to it: a grid per chain
    (action, protocol, addresses, ports, interfaces, connection state, packet
    matches, limits, other statements, comment, counter), reordering, copying
    and deleting rules, the base chain policy, and a dialog with tabs to edit
    one rule with a live preview of its nft text. Besides the basics the form
    covers TCP flags (set, clear, any of), packet length and type, marks
    (match and set), reverse path filtering, rate limits (within or over, in
    packets or bytes, with burst), limits per source address kept in a
    dynamic set, connection counts, quotas, nflog groups, notrack and verdict
    maps (vmap). Sets and maps are declared, changed and deleted in the same
    editor.
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
    same review; it is created with the hopdeck marker, so hopdeck manages it from
    the start.
- **Diff view** before every apply.
- **Set and map editor** that adds and removes elements live, without
  reloading the ruleset.
- **Packet tracing** (done): the Trace tab marks packets that match a
  filter (protocol, addresses, ports, input interface) and shows each one's
  way through the chains and rules and what decided, with links to the rules.
  - A temporary table `inet hopdeck_trace_<random>` does the marking: chains at
    prerouting and output with priority -350 (before all others), policy
    accept, one rule `<filter> limit rate N/second meta nftrace set 1`. It
    never changes what happens to a packet. Filter fields take values only,
    so they cannot smuggle in a statement.
  - A watchdog on the host, started the way the deployment watchdog is and
    before the table exists, runs `nft -a monitor trace` into a file, and
    when time is up, the panel asks it to stop or the monitor ends, removes
    the table. The panel reads new lines every second.
  - nft 1.1 prints traces as text even with `-j`, so `core/trace.ts` parses
    the lines; `-a` gives rule handles.
  - The sandbox brings up `lo` and can send test traffic, so tracing can be
    tried there.
- **Live data** (done): while the rules are in view, the panel reads the
  host every 2, 5 or 15 seconds (or not at all), pausing while the browser
  tab is hidden. One `nft -j list ruleset` per look, reduced on the server to
  counter values and one fingerprint per table: a hash of the table's JSON
  without counter values, quota use, expiry and set elements, which change on
  their own; hopdeck's tracing tables are left out. Rules show their live counts
  and packets and bytes per second, and rules with traffic are highlighted.
  A table whose fingerprint differs from the one read raises "the rules on
  the host changed", naming the tables, with a refresh; the editor warns that
  saving would undo that change. hopdeck's own deployments in flight do not
  count. Comparing fingerprints needs no long-running `nft monitor` process
  as root on the host.

## Milestones

1. **Read-only** (done, 2026-09-24). Sandbox, local and SSH executors, host
   facts and privilege detection, tree and text views, packet path diagram.
   Tested against a real Debian 13 host over SSH (`dev/test-host`), including
   confirming unknown and changed host keys in the panel.
2. **Text-mode editing** of managed tables, with diff, safe apply with
   rollback, and persistence (done, 2026-09-25). From here hopdeck can do
   everything nftables can: safe apply with the watchdog, adopting and
   deleting tables, Manual override, persistence across reboots, the text
   editor.
3. **Structured rule forms** and live set/map element editing. This is where
   "easier" starts. Done so far: the visual rules grid and the rule dialog,
   creating tables (empty, or from a host firewall template), adding or
   deleting chains, sets and maps, editing set and map elements in place, and
   changing rules one by one (done, 2026-09-27).
4. **Monitoring** (done, 2026-09-26): packet tracing, live counters and
   noticing changes made on the host by others.
5. **History** (done, 2026-09-27): versions kept on each host with author,
   outside changes and restore; host settings; the platform layer.
6. **Model B** (project layer).

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

## Platforms

What differs between kinds of hosts is in one place,
[`platform.ts`](../packages/core/src/platform.ts), picked from the host's facts
(`/etc/os-release`, and `/etc/openwrt_release`, which OpenWrt derivatives keep
too):

| | Linux | OpenWrt |
|---|---|---|
| Configuration (`configDir`) | `/etc/hopdeck` | `/etc/hopdeck` |
| Records such as history (`stateDir`) | `/var/lib/hopdeck` | `/etc/hopdeck/state`: `/var` is in RAM there |
| Firewall | changed through nft | shown only, until changes go through UCI |

Both directories belong to root with mode 700. Each module keeps its files in
a subdirectory of its own, such as `/etc/hopdeck/firewall` for the tables that
load at boot, so settings of the host and of other modules can sit beside
them. On OpenWrt the server refuses to plan firewall changes or save tables
(`platform-read-only`), and the UI shows the firewall without edit actions and
says why; tracing still works, since its temporary table changes no verdict.

## Future: beyond nftables on servers

The project is meant to grow into managing OpenWrt routers and other parts of
Linux networking. That makes the platform layer pluggable: the same UI over
different ways of reading and changing a host.

- **OpenWrt goes through UCI, never straight to nftables.** UCI
  (`/etc/config/firewall`) is OpenWrt's source of truth: firewall4 generates
  `inet fw4` from it (recognised already as another tool's table), and LuCI
  reads and writes only UCI. Direct nft changes would be invisible to LuCI
  and lost on the next firewall reload. hopdeck will edit UCI with `uci` or
  ubus, so everything it does shows up in LuCI and the other way round.
- **Full nftables power there** comes from fw4's nftables includes (UCI
  `config include` entries of type `nftables`, and `/etc/nftables.d/*.nft`),
  which LuCI also shows.
- **Safe apply there** should use OpenWrt's own apply with rollback (rpcd
  `uci apply` with a rollback timeout, then `confirm`), the mechanism LuCI
  uses, rather than hopdeck's systemd timer.
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
