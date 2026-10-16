// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import rulesJson from '../../test/fixtures/rules.json' with { type: 'json' };
import rulesListing from '../../test/fixtures/rules.listing?raw';
import { ruleKey } from './keys.ts';
import { parseListing } from './listing.ts';
import {
  dropLogPrefix,
  dropLogRule,
  groupPacketLog,
  loggingRules,
  MAX_LOG_PREFIX,
  parsePacketLogRead,
  parsePacketMessage,
  type PacketLogEntry,
} from './packet-log.ts';
import { renderRule, ruleForm } from './rule-form.ts';
import { parseRuleset } from './ruleset.ts';

// As nf_log writes them: the prefix runs straight into IN=, and every field ends with a space.
const SSH_SYN =
  'hopdeck drop inet filter input: IN=eth0 OUT= MAC=52:54:00:12:34:56:52:54:00:65:43:21:08:00 SRC=203.0.113.7 DST=198.51.100.10 LEN=60 TOS=0x00 PREC=0x00 TTL=52 ID=54321 DF PROTO=TCP SPT=51234 DPT=22 WINDOW=64240 RES=0x00 SYN URGP=0 ';
const PING6 =
  'drop6: IN=eth0 OUT= MAC=52:54:00:12:34:56:52:54:00:65:43:21:86:dd SRC=2001:0db8:0000:0000:0000:0000:0000:0007 DST=2001:0db8:0000:0000:0000:0000:0000:0010 LEN=104 TC=0 HOPLIMIT=64 FLOWLBL=123456 PROTO=ICMPv6 TYPE=128 CODE=0 ID=4242 SEQ=1 ';
const UNREACHABLE =
  'fwd: IN=eth1 OUT=eth0 SRC=10.0.0.1 DST=10.0.0.5 LEN=88 TOS=0x00 PREC=0xC0 TTL=64 ID=1 PROTO=ICMP TYPE=3 CODE=3 [SRC=10.0.0.5 DST=10.0.0.1 LEN=60 TOS=0x00 PREC=0x00 TTL=63 ID=2 PROTO=UDP SPT=5353 DPT=53 LEN=40 ] ';

describe('parsePacketMessage', () => {
  it('reads what nf_log writes for a TCP packet', () => {
    expect(parsePacketMessage(SSH_SYN, '2026-10-16T08:00:00.000Z')).toEqual({
      time: '2026-10-16T08:00:00.000Z',
      prefix: 'hopdeck drop inet filter input: ',
      in: 'eth0',
      out: '',
      mac: '52:54:00:12:34:56:52:54:00:65:43:21:08:00',
      src: '203.0.113.7',
      dst: '198.51.100.10',
      protocol: 'TCP',
      sport: 51234,
      dport: 22,
      length: 60,
      tcpFlags: ['SYN'],
      message: SSH_SYN,
    });
  });

  it('reads IPv6, ICMP types, and leaves out the packet an ICMP error quotes', () => {
    expect(parsePacketMessage(PING6)).toMatchObject({ prefix: 'drop6: ', protocol: 'ICMPv6', icmp: { type: 128, code: 0 }, length: 104 });
    const error = parsePacketMessage(UNREACHABLE)!;
    expect(error).toMatchObject({ in: 'eth1', out: 'eth0', src: '10.0.0.1', dst: '10.0.0.5', protocol: 'ICMP', icmp: { type: 3, code: 3 }, length: 88 });
    expect(error.sport).toBeUndefined();
    expect(error.dport).toBeUndefined();
  });

  it('takes the IP length, not UDP\'s, and TCP flags only after the protocol', () => {
    const udp = parsePacketMessage('IN=eth0 OUT= SRC=192.0.2.1 DST=192.0.2.2 LEN=76 TOS=0x00 PREC=0x00 TTL=64 ID=7 DF PROTO=UDP SPT=123 DPT=123 LEN=56 ')!;
    expect(udp).toMatchObject({ prefix: '', length: 76, protocol: 'UDP', sport: 123, dport: 123, tcpFlags: [] });
    const out = parsePacketMessage(
      'IN= OUT=eth0 SRC=192.0.2.2 DST=198.51.100.1 LEN=52 TOS=0x00 PREC=0x00 TTL=64 ID=9 DF PROTO=TCP SPT=40000 DPT=443 WINDOW=501 RES=0x00 ACK PSH URGP=0 OPT (0101080A00000001 00000002) UID=1000 GID=1000 ',
    )!;
    expect(out).toMatchObject({ in: '', out: 'eth0', tcpFlags: ['ACK', 'PSH'], dport: 443 });
  });

  it('reads a prefix without a trailing space, and ARP', () => {
    expect(parsePacketMessage('DROPIN=eth0 OUT= SRC=192.0.2.1 DST=192.0.2.2 LEN=40 PROTO=TCP SPT=1 DPT=2 ')).toMatchObject({ prefix: 'DROP', in: 'eth0' });
    expect(parsePacketMessage('arp: IN=br0 OUT= ARP HTYPE=1 PTYPE=0x0800 OPCODE=1 MACSRC=52:54:00:00:00:01 IPSRC=192.0.2.1 MACDST=00:00:00:00:00:00 IPDST=192.0.2.9 ')).toMatchObject({
      protocol: 'ARP',
      src: '192.0.2.1',
      dst: '192.0.2.9',
    });
  });

  it('is no packet for other kernel messages', () => {
    expect(parsePacketMessage('e1000e 0000:00:1f.6 eth0: NIC Link is Up 1000 Mbps Full Duplex')).toBeUndefined();
  });
});

describe('parsePacketLogRead', () => {
  const journal = (micros: string, message: string | number[], cursor: string) =>
    JSON.stringify({ __CURSOR: cursor, __REALTIME_TIMESTAMP: micros, __MONOTONIC_TIMESTAMP: '1', _BOOT_ID: 'b', MESSAGE: message });

  it('reads the journal newest first, with the cursor of the newest line', () => {
    const output = [
      'zone +0200',
      'boot 1792000000',
      'source journal',
      journal('1792060802000000', SSH_SYN, 's=1;i=3'),
      journal('1792060801000000', 'e1000e: link up IN=nothing', 's=1;i=2'),
      journal('1792060800000000', UNREACHABLE, 's=1;i=1'),
      '',
    ].join('\n');
    const read = parsePacketLogRead(output);
    expect(read.source).toEqual({ kind: 'journal' });
    expect(read.entries.map((entry) => entry.time)).toEqual([new Date(1792060802000).toISOString(), new Date(1792060800000).toISOString()]);
    expect(read.cursor).toBe('s=1;i=3');
    // Read on from a cursor, the journal comes oldest first; newest first all the same.
    const after = parsePacketLogRead(['zone +0000', 'boot', 'source journal', journal('1792060900000000', UNREACHABLE, 's=1;i=4'), journal('1792060901000000', SSH_SYN, 's=1;i=5')].join('\n'));
    expect(after.entries[0]!.prefix).toBe('hopdeck drop inet filter input: ');
    expect(after.cursor).toBe('s=1;i=5');
  });

  it('reads a message journald kept as bytes, as it does when it is not UTF-8', () => {
    const bytes = [...'x: IN=eth0 OUT= SRC=192.0.2.1 DST=192.0.2.2 LEN=40 PROTO=TCP SPT=1 DPT=2 '].map((char) => char.charCodeAt(0));
    const read = parsePacketLogRead(['source journal', journal('1792060800000000', [...bytes, 0xff], 's')].join('\n'));
    expect(read.entries[0]).toMatchObject({ prefix: 'x: ', src: '192.0.2.1', message: expect.stringMatching(/�$/) });
  });

  it('dates syslog lines in the host\'s zone, logread lines with their year, and dmesg by the boot time', () => {
    const now = new Date('2026-10-16T09:00:00Z');
    const files = parsePacketLogRead(
      [
        'zone +0200',
        'boot 1792000000',
        'source file /var/log/kern.log',
        `Oct 16 10:00:00 fw1 kernel: [ 1234.567890] ${SSH_SYN}`,
        `Oct 16 10:00:01 fw1 kern.warn kernel: ${PING6}`,
        `2026-10-16T10:00:02.250000+02:00 fw1 kernel: ${UNREACHABLE}`,
        'Oct 16 10:00:03 fw1 sshd[42]: IN= OUT= is no kernel line',
      ].join('\n'),
      now,
    );
    expect(files.source).toEqual({ kind: 'file', path: '/var/log/kern.log' });
    expect(files.entries.map((entry) => [entry.time, entry.protocol])).toEqual([
      ['2026-10-16T08:00:02.250Z', 'ICMP'],
      ['2026-10-16T08:00:01.000Z', 'ICMPv6'],
      ['2026-10-16T08:00:00.000Z', 'TCP'],
    ]);

    const logread = parsePacketLogRead(['zone +0000', 'source logread', `Thu Oct 16 10:00:00 2026 kern.warn kernel: [12345.678901] reject wan in: ${SSH_SYN.slice(SSH_SYN.indexOf('IN='))}`].join('\n'), now);
    expect(logread.entries[0]).toMatchObject({ time: '2026-10-16T10:00:00.000Z', prefix: 'reject wan in: ' });

    const dmesg = parsePacketLogRead(['zone +0000', 'boot 1792000000', 'source dmesg', `[ 1234.500000] ${SSH_SYN}`].join('\n'), now);
    expect(dmesg.entries[0]!.time).toBe(new Date((1792000000 + 1234.5) * 1000).toISOString());
  });

  it('puts a December line read in January in the year before', () => {
    const read = parsePacketLogRead(['zone +0000', 'source file /var/log/messages', `Dec 31 23:59:59 fw1 kernel: ${SSH_SYN}`].join('\n'), new Date('2027-01-01T00:30:00Z'));
    expect(read.entries[0]!.time).toBe('2026-12-31T23:59:59.000Z');
  });

  it('says when there was no source, or nothing in it', () => {
    expect(parsePacketLogRead('zone +0000\nboot 1\nsource none\n')).toEqual({ source: { kind: 'none' }, entries: [] });
    expect(parsePacketLogRead('zone +0000\nboot 1\nsource journal\n').entries).toEqual([]);
  });
});

describe('groupPacketLog', () => {
  const at = (time: string, change: Partial<PacketLogEntry> = {}) => ({ ...parsePacketMessage(SSH_SYN, time)!, ...change });

  it('folds the same packet within one second into one line, whatever its source port', () => {
    const groups = groupPacketLog([
      at('2026-10-16T08:00:01.900Z', { sport: 1 }),
      at('2026-10-16T08:00:01.500Z', { sport: 2 }),
      at('2026-10-16T08:00:01.100Z', { dport: 23 }),
      at('2026-10-16T08:00:01.000Z', { sport: 3 }),
      at('2026-10-16T08:00:00.900Z'),
    ]);
    expect(groups.map((group) => group.entries.length)).toEqual([3, 1, 1]);
    expect(groups[0]!.entries.map((entry) => entry.sport)).toEqual([1, 2, 3]);
    expect(groups[1]!.entries[0]!.dport).toBe(23);
  });

  it('keeps entries without a time apart', () => {
    expect(groupPacketLog([at('x', { time: undefined }), at('x', { time: undefined })])).toHaveLength(2);
  });
});

describe('loggingRules', () => {
  const ruleset = parseRuleset(rulesJson);
  const listing = parseListing(rulesListing);

  it('finds the rules that log to the kernel log, with what they then do', () => {
    const rules = loggingRules(ruleset);
    expect(rules.get('web: ')).toEqual([expect.objectContaining({ family: 'inet', table: 't', chain: 'c', verdict: 'drop' })]);
    // The last rule of a base chain, without a verdict of its own: the policy decides.
    expect(rules.get('hopdeck drop inet t c: ')).toEqual([expect.objectContaining({ chain: 'c', verdict: 'policy drop' })]);
    // log group goes to nflog, not to the kernel log.
    expect(rules.get('x')).toBeUndefined();
    expect([...rules.keys()].sort()).toEqual(['hopdeck drop inet t c: ', 'web: ']);
  });

  it('logs dropped packets with the rule hopdeck adds, which nft prints back as the form renders it', () => {
    const prefix = dropLogPrefix('inet', 't', 'c');
    expect(prefix).toBe('hopdeck drop inet t c: ');
    const text = renderRule(dropLogRule(prefix), 'inet');
    expect(text).toBe('counter limit rate 50/second burst 100 packets log prefix "hopdeck drop inet t c: "');
    const rule = ruleset.tables[0]!.chains.find((chain) => chain.chain.name === 'c')!.rules.at(-1)!;
    const printed = listing.rules.get(ruleKey('inet', 't', rule.handle))!;
    expect(ruleForm(rule, printed)).toEqual(dropLogRule(prefix));
  });

  it('keeps the prefix within what the kernel keeps', () => {
    expect(dropLogPrefix('inet', 'filter', 'x'.repeat(200))).toBe('hopdeck drop: ');
    expect(dropLogPrefix('inet', 'f'.repeat(105), 'input')).toBe(`hopdeck drop ${'f'.repeat(105)} input: `);
    expect(dropLogPrefix('inet', 'f'.repeat(110), 'input')).toBe('hopdeck drop input: ');
    for (const table of ['f'.repeat(105), 'f'.repeat(106), 'f'.repeat(110)]) expect(dropLogPrefix('inet', table, 'input').length).toBeLessThanOrEqual(MAX_LOG_PREFIX);
  });
});
