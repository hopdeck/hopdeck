// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { ALLOW_KEYS_FILE, keyBlockers, sshdSettings, type ExecResult, type KeyLoginFacts, type KeySetupResult } from '@hopdeck/core';
import { HostError } from './errors.ts';
import { runProcess } from './process.ts';
import { shellCommand } from './shell-quote.ts';
import { configNote, sshFailure } from './ssh.ts';
import { withAskpass, type SshKeys } from './ssh-keys.ts';

export interface KeyLoginOptions {
  keys: SshKeys;
  /** Replaces ~/.ssh/config, as for SshExecutor. */
  configFile?: string | undefined;
}

// sudo's messages are localized; hopdeck reads them, so it asks for English.
const SUDO_REFUSED = /is not in the sudoers file|is not allowed to execute|may not run sudo/;
const WRONG_PASSWORD = /incorrect password|Sorry, try again|no password was provided/;

/** Finds sshd. */
const FIND_SSHD = `sshd=
for candidate in /usr/sbin/sshd /usr/local/sbin/sshd /sbin/sshd; do
	if [ -x "$candidate" ]; then sshd=$candidate; break; fi
done`;

/** This login as sshd -T -C takes it, so Match blocks apply as they do to the login itself. */
const LOGIN_SPEC = `spec=$(set -- \${SSH_CONNECTION:-}; printf 'user=%s,host=%s,addr=%s,laddr=%s,lport=%s' "$(id -un)" "\${1:-}" "\${1:-}" "\${3:-}" "\${4:-}")`;

/**
 * Adds the key on its input to the account's authorized_keys, as ssh-copy-id
 * does, and prints what hopdeck needs to know about the account and the SSH
 * server. $1 is the sudo option for sshd -T: -n (no password), or -S (the
 * password is the next line of input).
 */
const INSTALL = `set -u
umask 077
IFS= read -r key || { echo 'no key on input' >&2; exit 2; }
blob=\${key#* }
blob=\${blob%% *}
${FIND_SSHD}
${LOGIN_SPEC}
if [ -n "$sshd" ]; then server=sshd
elif command -v dropbear >/dev/null 2>&1 || [ -x /usr/sbin/dropbear ]; then server=dropbear
else server=unknown; fi
# OpenWrt's dropbear takes root's keys from /etc/dropbear only.
if [ "$server" = dropbear ] && [ "$(id -u)" = 0 ] && [ -f /etc/openwrt_release ]; then dir=/etc/dropbear; else dir=$HOME/.ssh; fi
file=$dir/authorized_keys
mkdir -p "$dir" && chmod go-w "$dir" || exit 3
if [ -f "$file" ] && grep -qF -- "$blob" "$file"; then
	added=no
else
	if [ -s "$file" ] && [ -n "$(tail -c 1 "$file")" ]; then echo >> "$file" || exit 3; fi
	printf '%s\\n' "$key" >> "$file" || exit 3
	added=yes
fi
chmod go-rwx "$file" || exit 3
if [ "$dir" = "$HOME/.ssh" ] && command -v restorecon >/dev/null 2>&1; then restorecon -R "$dir" >/dev/null 2>&1 || :; fi
echo "file $file"
echo "added $added"
echo "server $server"
echo "uid $(id -u)"
echo "home $HOME"
echo "home-listing $(ls -ldn "$HOME" 2>/dev/null)"
[ "$server" = sshd ] || exit 0
if [ "$(id -u)" = 0 ]; then out=$("$sshd" -T -C "$spec" 2>&1); else out=$(env LC_ALL=C sudo "$1" -p '' -- "$sshd" -T -C "$spec" 2>&1); fi
echo "--- sshd $?"
printf '%s\\n' "$out"
`;

/**
 * As root: writes the lines that let keys in to ALLOW_KEYS_FILE, keeping what
 * an earlier run put there, and reloads sshd if the file is valid and sshd
 * uses what it says. Otherwise it puts back what was there. $1: this login
 * for sshd -T -C, $2: the file's header, $3: the settings it sets (a|b), $4:
 * the lines, $5: how sshd -T must print them.
 */
const ALLOW = `set -u
spec=$1 header=$2 keywords=$3 lines=$4 expected=$5
file=${ALLOW_KEYS_FILE}
${FIND_SSHD}
[ -n "$sshd" ] || { echo 'sshd not found in /usr/sbin, /usr/local/sbin or /sbin' >&2; exit 3; }
echo "file $file"
if [ ! -d "\${file%/*}" ]; then echo 'applied no'; echo 'why no-directory'; exit 0; fi
kept=
if [ -f "$file" ]; then
	cp -p "$file" "$file.hopdeck-old" || exit 3
	kept=$(grep -v '^#' "$file" | grep -v -i -E "^[[:space:]]*($keywords)[[:space:]]" || :)
fi
undo() {
	if [ -f "$file.hopdeck-old" ]; then mv -f "$file.hopdeck-old" "$file"; else rm -f "$file"; fi
}
{ printf '%s\\n' "$header"; [ -z "$kept" ] || printf '%s\\n' "$kept"; printf '%s\\n' "$lines"; } > "$file.hopdeck-new" \\
	&& chmod 644 "$file.hopdeck-new" && mv -f "$file.hopdeck-new" "$file" || { rm -f "$file.hopdeck-new"; undo; exit 3; }
if ! out=$("$sshd" -t 2>&1); then undo; echo 'applied no'; echo 'why invalid'; echo '--- raw'; printf '%s\\n' "$out"; exit 0; fi
if ! out=$("$sshd" -T -C "$spec" 2>&1); then undo; echo 'applied no'; echo 'why unreadable'; echo '--- raw'; printf '%s\\n' "$out"; exit 0; fi
missing=no
while IFS= read -r line; do
	printf '%s\\n' "$out" | grep -qixF -- "$line" || missing=yes
done <<EXPECTED
$expected
EXPECTED
if [ "$missing" = yes ]; then undo; echo 'applied no'; echo 'why overridden'; echo '--- sshd'; printf '%s\\n' "$out"; exit 0; fi
if [ -d /run/systemd/system ]; then
	reloaded=$(systemctl reload sshd.service 2>&1 || systemctl reload ssh.service 2>&1)
elif command -v rc-service >/dev/null 2>&1; then
	reloaded=$(rc-service sshd reload 2>&1)
else
	pidfile=$(printf '%s\\n' "$out" | sed -n 's/^pidfile //p')
	reloaded=$(kill -HUP "$(cat "$pidfile")" 2>&1)
fi
if [ $? -ne 0 ]; then undo; echo 'applied no'; echo 'why reload-failed'; echo '--- raw'; printf '%s\\n' "$reloaded"; exit 0; fi
# sshd restarts itself on reload, and a connection that comes first may still
# meet the old one; with some systemd units, reload returns before that.
sleep 1
rm -f "$file.hopdeck-old"
echo 'applied yes'
echo '--- sshd'
printf '%s\\n' "$out"
`;

/** Runs ALLOW as root: directly, or through sudo with the password on the next line of input. */
const AS_ROOT = `set -u
script=$1; shift
${LOGIN_SPEC}
if [ "$(id -u)" = 0 ]; then exec sh -c "$script" sh "$spec" "$@"; fi
exec env LC_ALL=C sudo -S -p '' -- sh -c "$script" sh "$spec" "$@"
`;

/** "key value" lines, then after "--- name …" the rest as is. */
interface Report {
  fields: Map<string, string>;
  section?: { name: string; arg: string; text: string };
}

function parseReport(stdout: string): Report {
  const fields = new Map<string, string>();
  const lines = stdout.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const section = /^--- (\S+) ?(.*)$/.exec(line);
    if (section !== null) {
      return { fields, section: { name: section[1]!, arg: section[2]!, text: lines.slice(index + 1).join('\n').trimEnd() } };
    }
    const space = line.indexOf(' ');
    if (space > 0) fields.set(line.slice(0, space), line.slice(space + 1));
  }
  return { fields };
}

/**
 * Sets up key login on an SSH host with one password login, the way ssh-copy-id
 * does, then checks with a new connection that the key alone gets in. When it
 * does not, it reads sshd's configuration for that login to say why, and on
 * request adds the lines that let keys in: passwords go on working as before.
 * The password is used for these logins only and kept nowhere.
 */
export class KeyLogin {
  readonly #options: KeyLoginOptions;

  constructor(options: KeyLoginOptions) {
    this.#options = options;
  }

  async setUp(destination: string, file: string, password: string, options: { allow?: boolean } = {}): Promise<KeySetupResult> {
    const { keys } = this.#options;
    const { line, key } = await keys.publicKey(destination, file);
    const loaded = (await keys.list(destination)).keys.find((listed) => listed.file === file)?.loaded ?? false;

    const installed = parseReport(succeeded(await this.#withPassword(destination, password, INSTALL, ['-n'], `${line}\n`)).stdout);
    const field = (name: string) => installed.fields.get(name) ?? '';
    const server = field('server') === 'sshd' || field('server') === 'dropbear' ? (field('server') as 'sshd' | 'dropbear') : 'unknown';
    let sshd = readSshd(installed);
    const facts = (): KeyLoginFacts => ({
      root: field('uid') === '0',
      keyType: line.split(' ')[0]!,
      sshd: sshd.output,
      home: homeFacts(field('home'), field('home-listing'), Number(field('uid'))),
    });
    // Without passwordless sudo, sshd's configuration takes one more login, with sudo's password.
    const readWithPassword = async () => {
      if (server !== 'sshd' || sshd.output !== undefined || !/a password is required/.test(sshd.reason ?? '')) return;
      sshd = readSshd(parseReport(succeeded(await this.#withPassword(destination, password, INSTALL, ['-S'], `${line}\n${password}\n`)).stdout));
    };

    const result: KeySetupResult = { file: field('file'), added: field('added') === 'yes', outcome: 'refused', check: { server, blockers: [] } };
    if (options.allow) {
      await readWithPassword();
      const lines = keyBlockers(facts()).flatMap((blocker) => (blocker.allow === undefined ? [] : [blocker.allow]));
      if (lines.length > 0) {
        const { allowed, settings } = await this.#allow(destination, password, lines);
        result.allowed = allowed;
        if (settings !== undefined) sshd = { output: settings };
      }
    }

    if (key.encrypted && !loaded) {
      result.outcome = 'unverified';
    } else {
      const refusal = await this.#tryKey(destination, file, key.fingerprint, result.allowed?.applied === true);
      if (refusal === undefined) result.outcome = 'works';
      else result.refusal = refusal;
    }
    if (result.outcome === 'refused') await readWithPassword();
    result.check = { server, blockers: keyBlockers(facts()), ...(server === 'sshd' && sshd.output === undefined && { reason: sshd.reason ?? 'sshd -T printed nothing' }) };
    return result;
  }

  /** Writes the lines to ALLOW_KEYS_FILE as root and reloads sshd, if sshd takes them. */
  async #allow(destination: string, password: string, lines: string[]): Promise<{ allowed: NonNullable<KeySetupResult['allowed']>; settings?: string }> {
    const header = [
      `# Written by hopdeck on ${new Date().toISOString()} to let SSH keys log in.`,
      '# Passwords work as they did. To undo: remove this file and reload sshd.',
    ].join('\n');
    const keywords = lines.map((line) => line.split(' ')[0]!).join('|');
    const expected = lines.map((line) => {
      const space = line.indexOf(' ');
      return `${line.slice(0, space).toLowerCase()} ${line.slice(space + 1)}`;
    });
    const done = succeeded(
      await this.#withPassword(destination, password, AS_ROOT, [ALLOW, header, keywords, lines.join('\n'), expected.join('\n')], `${password}\n`),
    );
    const report = parseReport(done.stdout);
    const file = report.fields.get('file') ?? ALLOW_KEYS_FILE;
    if (report.fields.get('applied') === 'yes') return { allowed: { file, lines, applied: true }, settings: report.section?.text };
    const why = (report.fields.get('why') ?? 'unknown') as NonNullable<KeySetupResult['allowed']>['why'];
    let reason = report.section?.text ?? '';
    if (why === 'overridden' && report.section !== undefined) {
      // What sshd uses instead, for the lines it did not take.
      const settings = sshdSettings(report.section.text);
      reason = expected
        .filter((line) => !report.section!.text.split('\n').some((printed) => printed.toLowerCase() === line.toLowerCase()))
        .map((line) => `${line.split(' ')[0]} ${settings.get(line.split(' ')[0]!) ?? '(not printed)'}`)
        .join('\n');
    }
    return { allowed: { file, lines, applied: false, why, ...(reason !== '' && { reason }) } };
  }

  /**
   * Logs in with the password alone and runs `script` under sh with `args`.
   * ssh's own failures throw: a password the host refused, a host that takes
   * no passwords, or what SshExecutor reports; the script's exit code is
   * returned as is.
   */
  async #withPassword(destination: string, password: string, script: string, args: string[], stdin: string): Promise<ExecResult> {
    const { configFile, keys } = this.#options;
    const sshArgs = [
      ...(configFile === undefined ? [] : ['-F', configFile]),
      '-T',
      ...['-o', 'BatchMode=no'],
      ...['-o', 'PubkeyAuthentication=no'],
      ...['-o', 'GSSAPIAuthentication=no'],
      ...['-o', 'PasswordAuthentication=yes'],
      ...['-o', 'KbdInteractiveAuthentication=yes'],
      ...['-o', 'PreferredAuthentications=password,keyboard-interactive'],
      ...['-o', 'NumberOfPasswordPrompts=1'],
      ...['-o', 'ConnectTimeout=10'],
      ...['-o', 'ControlMaster=no'],
      ...['-o', 'ControlPath=none'],
      '--',
      destination,
      shellCommand(['sh', '-c', script, 'sh', ...args]),
    ];
    const { result } = await withAskpass(password, (askpass) => runProcess('ssh', sshArgs, { stdin, timeoutMs: 60_000, env: { ...keys.env, ...askpass } }));
    if (result.exitCode === 255) {
      const stderr = result.stderr.trim();
      const denied = /Permission denied \(([^)]*)\)/.exec(stderr);
      if (denied !== null) {
        const methods = denied[1]!.split(',');
        const takesPasswords = methods.includes('password') || methods.includes('keyboard-interactive');
        throw new HostError(takesPasswords ? 'login-password-rejected' : 'password-login-disabled', stderr);
      }
      const failure = sshFailure(stderr);
      if (failure !== undefined) throw new HostError(failure, `${stderr}${configNote(configFile)}`);
    }
    return result;
  }

  /**
   * Logs in with this key alone, in a new connection; undefined when it got in,
   * else ssh's message. With -v, ssh names the key the server accepted: another
   * key from the SSH configuration getting in proves nothing about this one.
   * Right after sshd reloaded, `reloaded`, it tries again for a while while
   * the connection fails before logging in: sshd may still be restarting.
   */
  async #tryKey(destination: string, file: string, fingerprint: string, reloaded: boolean): Promise<string | undefined> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#tryKeyOnce(destination, file, fingerprint);
      } catch (error) {
        if (!reloaded || attempt >= 20 || !(error instanceof HostError && error.code === 'ssh-connect')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  async #tryKeyOnce(destination: string, file: string, fingerprint: string): Promise<string | undefined> {
    const { configFile, keys } = this.#options;
    const args = [
      ...(configFile === undefined ? [] : ['-F', configFile]),
      '-T',
      '-v',
      ...['-o', 'BatchMode=yes'],
      ...['-o', 'ConnectTimeout=10'],
      ...['-o', 'ControlMaster=no'],
      ...['-o', 'ControlPath=none'],
      ...['-o', 'PreferredAuthentications=publickey'],
      ...['-o', 'IdentitiesOnly=yes'],
      ...['-i', file],
      '--',
      destination,
      'true',
    ];
    const tried = await runProcess('ssh', args, { timeoutMs: 30_000, env: keys.env });
    // What ssh says without -v.
    const said = tried.stderr
      .split('\n')
      .filter((line) => !/^(debug\d?:|OpenSSH_|Authenticated to |Transferred: |Bytes per second: )/.test(line))
      .join('\n')
      .trim();
    if (tried.exitCode === 0) {
      const accepted = tried.stderr.split('\n').some((line) => line.startsWith('debug1: Server accepts key:') && line.includes(fingerprint));
      return accepted ? undefined : `the host let ssh in, but not with ${file}${said === '' ? '' : `: ${said}`}`;
    }
    const failure = tried.exitCode === 255 ? sshFailure(tried.stderr) : undefined;
    if (failure !== undefined && failure !== 'ssh-auth') throw new HostError(failure, `${said}${configNote(configFile)}`);
    return said || `ssh exited with code ${tried.exitCode}`;
  }
}

/** sshd -T output, or why hopdeck could not read it. */
function readSshd(report: Report): { output?: string | undefined; reason?: string | undefined } {
  if (report.section?.name !== 'sshd') return {};
  if (report.section.arg === '0') return { output: report.section.text };
  return { reason: report.section.text || `sshd -T exited with code ${report.section.arg}` };
}

/** A script that failed throws; sudo's own failures as the errors hopdeck shows for sudo elsewhere. */
function succeeded(result: ExecResult): ExecResult {
  if (result.exitCode === 0) return result;
  const stderr = result.stderr.trim();
  if (SUDO_REFUSED.test(stderr)) throw new HostError('sudo-not-allowed', stderr);
  if (WRONG_PASSWORD.test(stderr)) throw new HostError('wrong-password', stderr);
  throw new HostError('command-failed', stderr || `the setup script exited with code ${result.exitCode}`);
}

/** The home directory's mode and owner out of `ls -ldn`. */
function homeFacts(path: string, listing: string, uid: number): KeyLoginFacts['home'] {
  const match = /^(\S{10})\S*\s+\d+\s+(\d+)\s/.exec(listing);
  if (match === null || path === '' || !Number.isInteger(uid)) return undefined;
  return { path, mode: match[1]!, owner: Number(match[2]), uid };
}
