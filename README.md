# nftm

A GUI for nftables that can do everything nftables can do, only easier. It
runs as a local web panel and manages the local machine and remote hosts over
SSH, with no agent on the hosts.

**Status:** early development. Nothing touches a firewall yet.

Planned:

- Structured editors for rules, sets and maps, plus a full text mode. Nothing
  nftables supports is out of reach.
- Validation by the host's own `nft`, a diff before every change, atomic
  apply, and automatic rollback unless you confirm.
- Coexistence with Docker, firewalld, fail2ban and others: nftm edits only the
  tables it manages.
- A packet path view (hooks and priorities across all tables) and packet
  tracing.

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

`nftm --sandbox` (used by `pnpm dev`) adds a sandbox host: a private network
namespace with a demo firewall. It needs no root and never touches the real
firewall, so everything can be tried safely.

`scripts/nft-json-fixture.sh FILE.nft` prints the JSON that nft produces for a
ruleset, using a throwaway network namespace. The host ruleset is not touched.

## Translations

The UI is available in English and Polish. Texts live in
`packages/web/src/i18n/locales/<language>.json` (i18next JSON v4 format). To
add a language:

1. Copy `en.json` to e.g. `de.json` and translate the values.
2. Run `pnpm test`. It lists missing keys, including the plural forms your
   language needs.

No code changes are needed: every file in that directory becomes a language.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
