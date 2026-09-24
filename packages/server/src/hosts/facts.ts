import type { Executor } from '@nftm/core';
import { HostError } from './errors.ts';

export interface HostFacts {
  uid: number;
  hostname: string;
  kernel: string;
  os: { id: string; version: string; name: string } | undefined;
  systemd: boolean;
  /** `path` is absolute: /usr/sbin is often missing from a normal user's PATH. */
  nft: { path: string; version: string } | undefined;
}

// One round trip collects everything; `nft --version` needs no root. Output is
// "key=value" lines. os-release is meant to be sourced by shells.
const FACTS_SCRIPT = `
echo "uid=$(id -u)"
echo "hostname=$(cat /proc/sys/kernel/hostname 2>/dev/null)"
echo "kernel=$(uname -r)"
if [ -r /etc/os-release ]; then
  (. /etc/os-release; echo "os_id=$ID"; echo "os_version=$VERSION_ID"; echo "os_name=$PRETTY_NAME")
fi
if [ -d /run/systemd/system ]; then echo "systemd=yes"; else echo "systemd=no"; fi
for p in "$(command -v nft 2>/dev/null)" /usr/sbin/nft /sbin/nft /usr/local/sbin/nft; do
  if [ -n "$p" ] && [ -x "$p" ]; then
    echo "nft=$p"
    echo "nft_version=$("$p" --version 2>/dev/null)"
    break
  fi
done
`;

export async function collectFacts(executor: Executor): Promise<HostFacts> {
  const result = await executor.exec(['sh', '-c', FACTS_SCRIPT]);
  if (result.exitCode !== 0) throw new HostError('command-failed', result.stderr.trim());
  return parseFacts(result.stdout);
}

export function parseFacts(output: string): HostFacts {
  const values = new Map<string, string>();
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const get = (key: string) => values.get(key) ?? '';

  const uid = Number.parseInt(get('uid'), 10);
  if (Number.isNaN(uid)) throw new HostError('command-failed', `unexpected output: ${output.slice(0, 200)}`);

  const nftPath = get('nft');
  return {
    uid,
    hostname: get('hostname'),
    kernel: get('kernel'),
    os: values.has('os_id') ? { id: get('os_id'), version: get('os_version'), name: get('os_name') } : undefined,
    systemd: get('systemd') === 'yes',
    // "nftables v1.1.3 (Commodore Bullmoose #4)"
    nft: nftPath ? { path: nftPath, version: /v(\d+(?:\.\d+)+)/.exec(get('nft_version'))?.[1] ?? '' } : undefined,
  };
}
