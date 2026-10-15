# Contributing to hopdeck

Thank you for helping. Bug reports, translations and code are all welcome.

- **A security problem?** Do not open an issue: report it privately, as
  [SECURITY.md](SECURITY.md) says.
- **A bug?** Open an issue with the bug report form. Paste the error message
  as the panel shows it, under "Original message": hopdeck never hides it,
  and it usually says what went wrong.
- **A larger change, or a new feature?** Open an issue first, so we can agree
  on the approach before you write the code.

## Licence of contributions

hopdeck is under the [GNU Affero General Public License, version 3 or
later](LICENSE). What you contribute comes in under the same licence, and you
keep your copyright. There is no contributor licence agreement (CLA), so
nobody, the maintainer included, can take your code into a closed version of
hopdeck. You may add yourself to [AUTHORS](AUTHORS).

Contribute only what you have the right to give under that licence.

## Setting up

You need Node.js 24 or later and pnpm 12. The commands are in the README,
under [Development](README.md#development):

```sh
pnpm install
pnpm dev         # the panel with a sandbox host, on the first free ports from 7400 and 5173
pnpm typecheck
pnpm test
```

`pnpm dev` starts a sandbox host: a private network namespace with a demo
firewall, which never touches the real one. For changes that talk to hosts
over SSH, the [test hosts](README.md#test-hosts) are containers for each
supported system; `pnpm test:hosts` runs the tests against all of them.

## Before you send a pull request

- `pnpm typecheck` and `pnpm test` pass. CI runs them too: all of them on
  Linux, those that need no Linux on Windows, and the host tests against
  Debian 13.
- New behaviour has tests: unit tests next to the code (`*.test.ts`), and
  for what a host does, tests against the test hosts.
- [CHANGELOG.md](CHANGELOG.md) says what changes for users, under
  "Unreleased".
- Docs say what changed for those who read them: the README for users,
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how hopdeck works and why.

## How the code is written

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) holds the principles and the
decisions behind them; read its "Principles" first. In short:

- **Nothing hopdeck changes may lock the user out:** changes are checked by
  the host's own nft, shown as a diff, and rolled back unless confirmed.
- **Never break what hopdeck does not own:** tables of other tools stay
  read-only, and nothing flushes the whole ruleset.
- **Agentless:** nothing is installed on hosts.
- **Host output is untrusted:** what a host prints is shown as text, never run,
  and bounded in size.
- **Errors are shown as they are:** the panel explains an error in plain words,
  and always shows the raw message too.

And the conventions:

- Code, comments, commit messages and docs are in English. Comments say why,
  not what.
- The UI speaks English and Polish. A new text gets a key in both
  `packages/web/src/i18n/locales/en.json` and `pl.json`; `pnpm test` fails
  when a key is missing in one of them. If you do not speak Polish, add the
  English text and say so in the pull request.
- New files begin with the licence and copyright lines, as the others do:

  ```ts
  // SPDX-License-Identifier: AGPL-3.0-or-later
  // Copyright (C) 2026 Your Name
  ```

- Dependencies are kept to a minimum: the server has none beyond Node.js.
  A new one needs a good reason; see "Dependency policy" in
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- A commit message is one line saying what the change does and why it
  matters, then more lines where they help.

## Translations

A new language needs only one JSON file; see
[Translations](README.md#translations) in the README.
