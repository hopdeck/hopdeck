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
| Managed hosts | Debian 11+ (nft 0.9.8), RHEL 9+ | Admin machine: Linux; macOS likely works; Windows later |
| License | GPL-3.0-or-later | |

## Components

```
 browser ── packages/web (React)
    │  HTTP (+ WebSocket later), 127.0.0.1 only, token
 nftm backend ── packages/server, started by packages/cli
    │  Executor: local (sudo/pkexec) or system ssh
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

- The SSH executor runs `ssh -o BatchMode=yes -o ControlMaster=auto
  -o ControlPath=... -o ControlPersist=... HOST -- <quoted argv>`. ssh joins
  its arguments into one remote command line, so every argument is quoted for
  the remote shell.
- `BatchMode` means no interactive prompts. Host keys must already be known and
  authentication goes through keys or the agent. Prompts are an open question.
- Privileges: log in as a normal user and run `sudo -n nft ...`. A sudoers rule
  can limit this to `nft` and the rollback helper. `nft -f` as root is still
  effectively root, so this reduces mistakes; it is not a sandbox.
- On connect, nftm collects the host's facts: nft and kernel versions, systemd
  presence, distribution and its persistence file, whether sudo works, and
  which tables belong to other tools.

## Reading, validating, converting

- Read: `nft -j list ruleset`, then `parseRuleset` from core.
- Validate: `nft -c -f -` on the host.
- Convert text to JSON and normalize: load the ruleset into a throwaway network
  namespace and list it back (`unshare -rn` works without root when
  unprivileged user namespaces are enabled). This is needed for diffs: the
  kernel rewrites rules (`10.0.0.1/8` becomes `10.0.0.0/8`, port lists become
  anonymous sets), so comparing the text as written does not work.
  [`scripts/nft-json-fixture.sh`](../scripts/nft-json-fixture.sh) uses the same
  technique for test fixtures.
- Limitation: the namespace has only `lo`. Constructs bound to real interfaces
  (flowtables, netdev chains, `iif "eth0"`) need dummy interfaces with the same
  names created there first.

## Ownership and coexistence

- nftm edits only tables it manages. Everything else stays visible (including
  in the packet path view) but read-only.
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

1. **Read-only.** Local and SSH executors, host facts, tree and text views,
   packet path diagram.
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
- **Interactive prompts:** unknown host keys, SSH passwords, sudo passwords.
  Bridge `SSH_ASKPASS` / `SUDO_ASKPASS` to the UI?
- **Windows as the admin machine:** its OpenSSH has no ControlMaster.
- **Distribution:** npm package, Node single executable, distribution packages,
  or a desktop wrapper.
- **Local state:** the host inventory format and how long snapshots are kept.
