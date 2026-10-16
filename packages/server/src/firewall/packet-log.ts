// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { PACKET_LOG_COMMAND, PACKET_LOG_LINES, parsePacketLogRead, type PacketLogView } from '@hopdeck/core';
import { HostError } from '../hosts/errors.ts';
import { runAsRoot, type NftAccess } from '../hosts/privilege.ts';

/**
 * Reads the packets log statements wrote to the host's kernel log: the newest,
 * or with `after` (a journal cursor) those since. Reading the kernel log
 * takes root on most systems; where sudo allows nft only, or not at all, the
 * login user reads what it may, which the view says.
 */
export async function readPacketLog(access: NftAccess, after: string | undefined): Promise<PacketLogView> {
  const argv = ['sh', '-c', PACKET_LOG_COMMAND, 'sh', String(PACKET_LOG_LINES), after ?? ''];
  let asUser = false;
  let result;
  try {
    result = await runAsRoot(access, argv);
  } catch (error) {
    if (!(error instanceof HostError) || (error.code !== 'sudo-not-allowed' && error.code !== 'no-privileges')) throw error;
    asUser = true;
    result = await access.executor.exec(argv);
  }
  const read = parsePacketLogRead(result.stdout);
  const stderr = result.stderr.trim();
  // A cursor from before a reboot or a rotation of the journal leads nowhere: start again from the newest.
  if (after !== undefined && read.entries.length === 0 && /cursor/i.test(stderr)) return readPacketLog(access, undefined);
  return {
    ...read,
    complete: after === undefined,
    readAt: new Date().toISOString(),
    ...(stderr !== '' && { stderr }),
    ...(asUser && { asUser }),
  };
}
