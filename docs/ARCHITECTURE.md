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
<quoted argv>`. ssh joins its arguments into one command line for the remote
login shell, so every argument is single-quoted. The login shell must be
POSIX-compatible (sh, bash, dash, zsh, ksh, ash); fish and csh are not
supported.

**SSH authentication.** Keys or ssh-agent only; no SSH passwords. `BatchMode`
rules out interactive prompts. An unknown host key makes the connection fail:
the panel then shows the key's fingerprint, and adds it to `known_hosts` only
after the user confirms. Keys are never accepted automatically.

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

- nftm edits only tables it manages. Everything else stays visible (including
  in the packet path view) but read-only.
- Owners are guessed (`tableOwner` in core) and the UI always shows the
  evidence: the iptables-nft marker nft prints, xt expressions, iptables chain
  names, or a known tool's table name (firewalld, fail2ban, libvirt, ...).
- Tables written by iptables-nft contain `xt` expressions that nft cannot
  recreate. They are always read-only.
- There are two ways to change a managed table:
  - **Replace the whole table** in one transaction. Simple, but it resets
    counters and dynamic set elements. This is the default for text mode.
  - **Targeted changes by rule handle.** Keeps counters and set contents. Used
    by the structured editors.

## Applying changes

1. **Snapshot.** Run `nft -j list ruleset` and keep the result locally as
   history.
2. **Build** a transaction that touches managed tables only.
3. **Validate** it with `nft -c` on the host.
4. **Show the normalized diff**; the user approves.
5. **Arm the rollback.** Upload a rollback file to `/var/lib/nftm/`. It restores
   *only the managed tables*, so changes that other tools made in the meantime
   survive. Then start a timer on the host:
   `systemd-run --on-active=60s --unit=nftm-rollback-<id> nft -f <file>`.
   Without systemd, fall back to `setsid sh -c 'sleep 60; nft -f <file>'`.
6. **Apply** atomically with `nft -f`, as one transaction.
7. **Verify with a fresh SSH connection** that bypasses ControlMaster
   (`-o ControlPath=none`). An existing connection usually survives thanks to
   `ct state established` even when new connections are blocked, so it would
   report a false "works".
8. **Confirm.** The user confirms and nftm stops the timer. If the tab closes
   or the connection drops, the host rolls back by itself.
9. **Persist.** Write the managed tables to `/etc/nftm/*.nft`. The first time,
   and only with the user's consent, add `include "/etc/nftm/*.nft"` to the
   distribution's main config (`/etc/nftables.conf` on Debian,
   `/etc/sysconfig/nftables.conf` on RHEL).

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
- **Rule editor:** structured forms for known expressions and raw editing for
  the rest. The text mode uses CodeMirror 6 with an nft grammar, and errors
  from `nft -c` are mapped to lines.
- **Diff view** before every apply.
- **Set and map editor** that adds and removes elements live, without
  reloading the ruleset.
- **Packet tracing:** `meta nftrace set 1` plus `nft monitor trace`, drawn as
  the path through the rules.
- **Live data:** counters and events from `nft monitor`.

## Milestones

1. **Read-only** (done, 2026-09-24). Sandbox, local and SSH executors, host
   facts and privilege detection, tree and text views, packet path diagram.
   Still missing: confirming unknown SSH host keys in the panel, and a test
   against a real SSH host.
2. **Text-mode editing** of managed tables, with diff, safe apply with
   rollback, and persistence. From here nftm can do everything nftables can.
3. **Structured rule forms** and live set/map element editing. This is where
   "easier" starts.
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

## Open questions

- **Managed-table marker:** how to mark a table as managed. A table comment
  (if all supported nft versions allow it) or a registry file on the host
  (`/etc/nftm/`)?
- **Windows as the admin machine:** its OpenSSH has no ControlMaster.
- **Distribution:** npm package, Node single executable, distribution packages,
  or a desktop wrapper.
- **Local state:** the host inventory format and how long snapshots are kept.
- **Sandbox for users:** should the sandbox become a regular feature, and should
  it copy the interfaces of a real host (as dummy interfaces)?
