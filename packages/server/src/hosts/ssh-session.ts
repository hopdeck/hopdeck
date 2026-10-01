// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ExecOptions, ExecResult, Executor } from '@hopdeck/core';
import { HostError } from './errors.ts';
import { DEFAULT_TIMEOUT_MS, MAX_OUTPUT_BYTES } from './process.ts';
import { shellCommand } from './shell-quote.ts';
import { configNote, isValidDestination, sshFailure } from './ssh.ts';

/**
 * Whether SSH hosts are reached through one long session each instead of
 * ssh's ControlMaster: on Windows, whose OpenSSH has no ControlMaster, and
 * wherever HOPDECK_SSH_SESSIONS=1 asks for it (the tests do, on Linux).
 */
export function sshSessionsWanted(): boolean {
  return process.platform === 'win32' || process.env['HOPDECK_SSH_SESSIONS'] === '1';
}

/** How the first line the host prints once the session is ready begins; before it may come what login scripts print. */
const READY = 'hopdeck-session 1 ';

/**
 * What the host runs for the session, in its sh: a private directory, an
 * encoder for what commands print, then awk, which reads the requests. awk
 * and nothing else reads the session's input: sh's read goes byte by byte,
 * and BusyBox's head -c reads past its count. $1 is the awk program.
 *
 * Commands may print any byte, NUL too (hopdeck separates files with it),
 * which awk cannot carry, so their output goes back encoded: base64, or hex
 * with hexdump (OpenWrt has no base64) or od. The umask stays the login's:
 * commands inherit it, and the files they make must come out as without a
 * session; mktemp makes the directory private (0700) whatever the umask.
 */
const BOOT = String.raw`command -v awk >/dev/null 2>&1 || { echo 'hopdeck needs awk on the host' >&2; exit 71; }
D=$(mktemp -d) || { echo 'mktemp -d failed on the host' >&2; exit 70; }
export D
trap 'rm -rf "$D"' EXIT
trap 'exit 129' HUP
trap 'exit 143' TERM
if command -v base64 >/dev/null 2>&1 && [ "${'$'}{HOPDECK_SESSION_HEX:-}" != 1 ]; then
	echo 'exec base64' > "$D/enc"; E=base64
elif command -v hexdump >/dev/null 2>&1; then
	cat > "$D/enc" <<'ENC'
exec hexdump -v -e '32/1 "%02x" "\n"'
ENC
	E=hex
elif command -v od >/dev/null 2>&1; then
	echo 'exec od -An -v -tx1' > "$D/enc"; E=hex
else
	echo 'hopdeck needs base64, hexdump or od on the host' >&2; exit 72
fi
echo "${READY}$E"
# mawk (Debian's awk) waits for a full buffer of input before it reads a line, unless told not to.
case $(awk -W version 2>&1 </dev/null) in
*mawk*) set -- -W interactive "$1" ;;
esac
LC_ALL=C awk "$@"
`;

/**
 * The requests, one at a time. A request is "R id cmd-eol in-eol", then the
 * command's lines and a line ".", then the input's lines and a line ".".
 * Every line of data starts with "|", so none can pass for a ".". An eol of
 * 1 says the text ended with a line break. Commands and their input are text
 * (no NUL). The command goes to a file in the private directory; its input
 * goes to it through a pipe, never to disk, as it may be a sudo password. It
 * runs in the home directory, as a command given to ssh does; cat takes what
 * it leaves of its input, so awk never writes into a closed pipe. The answer
 * is "D id exit-code", stdout encoded, ".", stderr encoded, ".".
 */
const AWK = String.raw`
BEGIN {
  RUN = "cd \"$HOME\" 2>/dev/null; sh \"$D/cmd\" > \"$D/out\" 2> \"$D/err\"; echo $? > \"$D/code\"; cat > /dev/null; sh \"$D/enc\" < \"$D/out\" > \"$D/out.e\"; sh \"$D/enc\" < \"$D/err\" > \"$D/err.e\""
}
state == 0 {
  if ($1 == "R") { id = $2; eol[1] = $3; eol[2] = $4; part = 1; held = 0; file = ENVIRON["D"] "/cmd"; printf "" > file; state = 1 }
  next
}
{
  if ($0 == ".") {
    nl = eol[part] == "1" ? "\n" : ""
    if (part == 1) {
      if (held) printf "%s%s", last, nl > file
      close(file)
      part = 2
      held = 0
      printf "" | RUN
      next
    }
    if (held) printf "%s%s", last, nl | RUN
    close(RUN)
    held = 0
    state = 0
    answer()
    next
  }
  if (held) {
    if (part == 1) print last > file
    else print last | RUN
  }
  last = substr($0, 2)
  held = 1
}
function answer(   d, code) {
  d = ENVIRON["D"]
  getline code < (d "/code"); close(d "/code")
  printf "D %s %s\n", id, code
  send(d "/out.e")
  send(d "/err.e")
  fflush()
}
function send(path,   line) {
  while ((getline line < path) > 0) print line
  close(path)
  print "."
}
`;

export interface SessionExecutorOptions {
  /** As for SshExecutor. */
  destination: string;
  configFile?: string | undefined;
  identityFile?: string | undefined;
  env?: Readonly<Record<string, string>> | undefined;
  /** Defaults to "ssh" from PATH. */
  sshPath?: string;
  /** For one command, from when the host starts it. */
  timeoutMs?: number;
  /** The session ends after this long without a command, as a ControlMaster connection does. */
  idleMs?: number;
}

/**
 * Runs commands on an SSH host through one long ssh session, for where ssh
 * has no ControlMaster (Windows): one login, then commands in milliseconds.
 * It is still the system's ssh, so ~/.ssh/config, ProxyJump, the agent, FIDO
 * keys and known_hosts work as in a terminal. Commands run one after another;
 * the long-running ones hopdeck starts on hosts detach themselves.
 */
export class SessionExecutor implements Executor {
  readonly host: string;
  readonly #options: SessionExecutorOptions;
  #session: Session | undefined;

  constructor(options: SessionExecutorOptions) {
    if (!isValidDestination(options.destination)) {
      throw new Error(`invalid SSH destination: ${JSON.stringify(options.destination)}`);
    }
    this.host = options.destination;
    this.#options = options;
  }

  exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (argv.length === 0) return Promise.reject(new Error('empty command'));
    const command = shellCommand(argv);
    const stdin = options.stdin ?? '';
    if (command.includes('\0') || stdin.includes('\0')) {
      return Promise.reject(new HostError('command-failed', 'a NUL byte cannot go through an SSH session'));
    }
    if (this.#session === undefined || !this.#session.open) this.#session = new Session(this.#options);
    return this.#session.run(command, stdin);
  }

  /** Ends the session, if one is open. */
  close(): void {
    this.#session?.end();
  }
}

interface Pending {
  id: number;
  resolve(result: ExecResult): void;
  reject(error: Error): void;
}

/** One ssh process and the requests in it. */
class Session {
  open = true;
  readonly #options: SessionExecutorOptions;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #queue: Pending[] = [];
  #next = 1;
  #ready = false;
  /** How the host encodes what commands print; known once the session is ready. */
  #encoding: 'base64' | 'hex' = 'base64';
  #rest = Buffer.alloc(0);
  #stderr = '';
  /** What login scripts printed before the session began, for when it fails to. */
  #preamble: string[] = [];
  #failure: Error | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  /** The answer being read: its header, then stdout's encoded lines, then stderr's. */
  #answer: { exitCode: number; lines: [string[], string[]]; part: 0 | 1; bytes: number } | undefined;

  constructor(options: SessionExecutorOptions) {
    this.#options = options;
    const args = [
      ...(options.configFile === undefined ? [] : ['-F', options.configFile]),
      ...(options.identityFile === undefined ? [] : ['-i', options.identityFile]),
      '-T',
      ...['-o', 'BatchMode=yes'],
      ...['-o', 'ConnectTimeout=10'],
      ...['-o', 'ControlMaster=no'],
      ...['-o', 'ControlPath=none'],
      // A dead network is noticed, instead of commands waiting for their timeout.
      ...['-o', 'ServerAliveInterval=15'],
      '--',
      options.destination,
      shellCommand(['sh', '-c', BOOT, 'sh', AWK]),
    ];
    this.#child = spawn(options.sshPath ?? 'ssh', args, {
      stdio: 'pipe',
      ...(options.env !== undefined && { env: { ...process.env, ...options.env } }),
    });
    this.#child.stdout.on('data', (chunk: Buffer) => this.#read(chunk));
    this.#child.stderr.on('data', (chunk: Buffer) => {
      // Enough to say why a session failed; ssh says little more.
      if (this.#stderr.length < 65_536) this.#stderr += chunk.toString('utf8');
    });
    this.#child.stdin.on('error', () => {});
    this.#child.once('error', (error) => this.#fail(new HostError('spawn-failed', `${options.sshPath ?? 'ssh'}: ${error.message}`)));
    this.#child.once('close', (code) => this.#closed(code));
  }

  run(command: string, stdin: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      if (!this.open) {
        reject(this.#failure ?? new HostError('ssh-connect', 'the SSH session has ended'));
        return;
      }
      const id = this.#next++;
      this.#queue.push({ id, resolve, reject });
      clearTimeout(this.#idle);
      const command_ = frame(command);
      const input = frame(stdin);
      this.#child.stdin.write(`R ${id} ${command_.eol} ${input.eol}\n${command_.lines}.\n${input.lines}.\n`);
      if (this.#queue.length === 1) this.#startTimer();
    });
  }

  /** Lets the host finish what it runs, then ends the session. */
  end(): void {
    this.open = false;
    clearTimeout(this.#idle);
    this.#child.stdin.end();
  }

  #startTimer(): void {
    clearTimeout(this.#timer);
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#timer = setTimeout(() => {
      this.#fail(new HostError('timeout', `${this.#options.destination}: a command timed out after ${timeoutMs} ms, so its SSH session was ended`));
    }, timeoutMs);
  }

  #read(chunk: Buffer): void {
    let data = this.#rest.length === 0 ? chunk : Buffer.concat([this.#rest, chunk]);
    for (let end = data.indexOf(0x0a); end !== -1; end = data.indexOf(0x0a)) {
      // UTF-8 never has a line break inside a character, so lines decode on their own.
      this.#line(data.subarray(0, end).toString('utf8'));
      data = data.subarray(end + 1);
      if (!this.open && this.#failure !== undefined) return;
    }
    this.#rest = Buffer.from(data);
  }

  #line(line: string): void {
    if (!this.#ready) {
      if (line === `${READY}base64` || line === `${READY}hex`) {
        this.#ready = true;
        this.#encoding = line.slice(READY.length) as 'base64' | 'hex';
      } else if (this.#preamble.length < 20) {
        this.#preamble.push(line);
      }
      return;
    }
    const answer = this.#answer;
    if (answer === undefined) {
      const header = /^D (\d+) (\d+)$/.exec(line);
      const pending = this.#queue[0];
      if (header === null || pending === undefined || Number(header[1]) !== pending.id) {
        this.#fail(new HostError('command-failed', `${this.#options.destination}: the SSH session answered out of turn: ${JSON.stringify(line.slice(0, 200))}`));
        return;
      }
      this.#answer = { exitCode: Number(header[2]), lines: [[], []], part: 0, bytes: 0 };
      return;
    }
    if (line === '.') {
      if (answer.part === 0) {
        answer.part = 1;
        return;
      }
      this.#answer = undefined;
      // base64 in lines, or hex digits with spaces where hexdump fills a short last line.
      const text = (part: 0 | 1) =>
        this.#encoding === 'base64'
          ? Buffer.from(answer.lines[part].join(''), 'base64').toString('utf8')
          : Buffer.from(answer.lines[part].join('').replace(/\s+/g, ''), 'hex').toString('utf8');
      this.#queue.shift()!.resolve({ exitCode: answer.exitCode, stdout: text(0), stderr: text(1) });
      if (this.#queue.length > 0) {
        this.#startTimer();
      } else {
        clearTimeout(this.#timer);
        this.#idle = setTimeout(() => this.end(), this.#options.idleMs ?? 60_000);
        // An idle session is no reason for hopdeck to keep running.
        this.#idle.unref();
      }
      return;
    }
    answer.bytes += line.length;
    // Encoded, the output is up to about twice as long (hex) as the bytes it holds.
    if (answer.bytes > MAX_OUTPUT_BYTES * 2.5) {
      this.#fail(new HostError('command-failed', `${this.#options.destination}: a command printed more than ${MAX_OUTPUT_BYTES} bytes, so its SSH session was ended`));
      return;
    }
    answer.lines[answer.part].push(line);
  }

  /** Ends the session at once: the first request gets `error`, the ones after it that the session ended. */
  #fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.open = false;
    clearTimeout(this.#timer);
    clearTimeout(this.#idle);
    this.#child.kill('SIGKILL');
    this.#child.stdout.destroy();
    this.#child.stderr.destroy();
    this.#rejectAll(error);
  }

  #closed(code: number | null): void {
    this.open = false;
    clearTimeout(this.#timer);
    clearTimeout(this.#idle);
    if (this.#failure !== undefined || this.#queue.length === 0) return;
    const stderr = this.#stderr.trim();
    let error: HostError;
    if (!this.#ready) {
      // It never began: ssh could not log in, or the host lacks what the session needs.
      const failure = code === 255 ? (sshFailure(stderr) ?? 'ssh-connect') : 'command-failed';
      const printed = this.#preamble.length > 0 ? `\n${this.#preamble.join('\n')}` : '';
      error = new HostError(failure, `${stderr || `ssh exited with code ${code}`}${printed}${failure.startsWith('ssh-') ? configNote(this.#options.configFile) : ''}`);
    } else {
      error = new HostError('ssh-connect', stderr || `the SSH session to ${this.#options.destination} ended (ssh exited with code ${code})`);
    }
    this.#failure = error;
    this.#rejectAll(error);
  }

  #rejectAll(error: Error): void {
    const [first, ...rest] = this.#queue.splice(0);
    first?.reject(error);
    for (const pending of rest) pending.reject(error instanceof HostError ? new HostError(error.code, error.detail) : error);
  }
}

/** Text as request lines: each line after "|", and whether it ended with a line break. */
function frame(text: string): { lines: string; eol: 0 | 1 } {
  if (text === '') return { lines: '', eol: 0 };
  const eol = text.endsWith('\n') ? 1 : 0;
  const body = eol === 1 ? text.slice(0, -1) : text;
  return { lines: body.split('\n').map((line) => `|${line}\n`).join(''), eol };
}
