# Security policy

hopdeck holds root-level access to the hosts it manages, so reports of
security problems are welcome and taken seriously.

## Reporting a vulnerability

Report it privately through GitHub: on the repository's **Security** tab,
choose **Report a vulnerability**. Please do not open a public issue, pull
request or discussion about it.

A useful report says:

- the version (`hopdeck --version`) and the machine it runs on (Linux or
  Windows);
- the managed host's system, if a host is involved;
- what an attacker needs (a website the admin visits, an account on the admin's
  machine or on a managed host, a place on the network between them), what they
  get, and how to reproduce it.

## What happens next

hopdeck is maintained by one person, so this is best effort:

- an answer within 7 days, and an assessment within 14;
- a fix in a new release, as soon as its severity calls for;
- a GitHub security advisory published with the fix, crediting you unless you
  would rather not be named.

Please keep the problem to yourself until the fix is released, or for 90 days
after your report, whichever comes first.

Only the latest release gets security fixes.

## Scope

The threat model is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), under
"Principles" and "Local panel security". In scope, for example:

- reaching the panel's API without its token: another local user, a website open
  in the same browser, DNS rebinding;
- a managed host, or someone between it and the admin, attacking the admin's
  machine, browser or terminal through what it sends, or using hopdeck to reach
  other hosts;
- commands or nft input smuggled in through what the panel takes (names, set
  elements, trace filters), beyond what the user sees and confirms;
- what hopdeck leaves on a host letting an account that is not root become root;
- the sudo password, a key's passphrase or an account's password written to
  disk, logs or command lines, or sent to a host that was not meant to get it;
- a release archive that was not built from the repository's source.

Out of scope:

- an attacker who already has the panel's token, runs as the same user as
  hopdeck, or is root on the admin's machine;
- changes the panel's user makes on purpose: the panel is for administrators,
  and can change any firewall rule their access allows;
- the test hosts in `dev/test-host`, whose known passwords are on purpose and
  which listen on 127.0.0.1 only.
