import { describe, expect, it } from 'vitest';
import { groupTrace, parseTraceLine, summarize, traceFilterProblem, traceTable } from './trace.ts';

// `nft -a monitor trace` (nftables 1.1.3): a TCP SYN to port 9 over lo, dropped by a rule, and one to port 10, dropped by the policy.
const LINES = `trace id 52924af7 inet hopdeck_trace_t2 out packet: oif "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 ip dscp cs0 ip ecn not-ect ip ttl 64 ip id 23602 ip protocol tcp ip length 60 tcp sport 59846 tcp dport 9 tcp flags == syn tcp window 65495
trace id 52924af7 inet hopdeck_trace_t2 out rule tcp dport { 9, 10 } limit rate 10/second burst 5 packets meta nftrace set 1 # handle 6 (verdict continue)
trace id 52924af7 inet hopdeck_trace_t2 out policy accept
trace id 26dee5ea inet hopdeck_trace_t2 pre packet: iif "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 ip dscp cs0 ip ecn not-ect ip ttl 64 ip id 23602 ip protocol tcp ip length 60 tcp sport 59846 tcp dport 9 tcp flags == syn tcp window 65495
trace id 26dee5ea inet hopdeck_trace_t2 pre rule tcp dport { 9, 10 } limit rate 10/second burst 5 packets meta nftrace set 1 # handle 4 (verdict continue)
trace id 26dee5ea inet hopdeck_trace_t2 pre policy accept
trace id 26dee5ea inet f input packet: iif "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 ip dscp cs0 ip ecn not-ect ip ttl 64 ip id 23602 ip protocol tcp ip length 60 tcp sport 59846 tcp dport 9 tcp flags == syn tcp window 65495
trace id 26dee5ea inet f input rule iif "lo" jump lo_in # handle 3 (verdict jump lo_in)
trace id 26dee5ea inet f input rule tcp dport 9 drop comment "discard port" # handle 4 (verdict drop)
trace id c22930c8 inet f input packet: iif "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 ip protocol tcp tcp sport 59024 tcp dport 10 tcp flags == syn
trace id c22930c8 inet f input rule iif "lo" jump lo_in # handle 3 (verdict jump lo_in)
trace id c22930c8 inet f input policy drop
trace id 8e8ff03d inet f lo_in rule icmp type echo-request counter packets 0 bytes 0 accept # handle 7 (verdict accept)
Error: Could not receive trace: Operation not permitted`.split('\n');

describe('parseTraceLine', () => {
  it('reads packets, rules with their handles and verdicts, and policies', () => {
    expect(parseTraceLine(LINES[8]!)).toMatchObject({
      id: '26dee5ea',
      family: 'inet',
      table: 'f',
      chain: 'input',
      kind: 'rule',
      rule: 'tcp dport 9 drop comment "discard port"',
      handle: 4,
      verdict: 'drop',
    });
    expect(parseTraceLine(LINES[7]!)).toMatchObject({ kind: 'rule', handle: 3, verdict: 'jump lo_in' });
    expect(parseTraceLine(LINES[11]!)).toMatchObject({ kind: 'policy', chain: 'input', verdict: 'drop' });
    expect(parseTraceLine(LINES[3]!)?.packet).toMatch(/^iif "lo" ip saddr 127\.0\.0\.1/);
    expect(parseTraceLine(LINES.at(-1)!)).toBeUndefined();
  });
});

describe('groupTrace', () => {
  it('groups lines per packet and finds what decided', () => {
    const packets = groupTrace(LINES);
    expect(packets.map((packet) => [packet.id, packet.direction, packet.verdict, packet.decidedBy?.kind])).toEqual([
      // No chain of the firewall at output: nothing held it back.
      ['52924af7', 'out', 'accept', undefined],
      ['26dee5ea', 'in', 'drop', 'rule'],
      ['c22930c8', undefined, 'drop', 'policy'],
      ['8e8ff03d', undefined, 'accept', 'rule'],
    ]);
    // hopdeck's own tracing table is left out of the steps.
    expect(packets[1]!.steps.map((step) => `${step.chain} ${step.kind}`)).toEqual(['input packet', 'input rule', 'input rule']);
  });

  it('starts a new packet where hopdeck\'s chain reports one, even when the kernel reuses the trace id', () => {
    // A ping to lo and its reply, both given the id 3c0118c9 (nftables 1.1.3, kernel 6.12).
    const reused = `trace id 3c0118c9 inet hopdeck_trace_t9 pre packet: iif "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 ip id 13597 ip protocol icmp icmp type echo-request
trace id 3c0118c9 inet hopdeck_trace_t9 pre rule meta l4proto icmp limit rate 10/second burst 5 packets meta nftrace set 1 # handle 3 (verdict continue)
trace id 3c0118c9 inet hopdeck_trace_t9 pre policy accept
trace id 3c0118c9 inet filter input packet: iif "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 ip id 13597 ip protocol icmp icmp type echo-request
trace id 3c0118c9 inet filter input rule iif "lo" accept # handle 11 (verdict accept)
trace id 3c0118c9 inet hopdeck_trace_t9 pre packet: iif "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 ip id 13598 ip protocol icmp icmp type echo-reply
trace id 3c0118c9 inet hopdeck_trace_t9 pre rule meta l4proto icmp limit rate 10/second burst 5 packets meta nftrace set 1 # handle 3 (verdict continue)
trace id 3c0118c9 inet hopdeck_trace_t9 pre policy accept
trace id 3c0118c9 inet filter input packet: iif "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 ip id 13598 ip protocol icmp icmp type echo-reply
trace id 3c0118c9 inet filter input rule ct state established,related accept # handle 9 (verdict accept)`.split('\n');
    const packets = groupTrace(reused);
    expect(packets.map((packet) => [packet.key, packet.summary.icmpType, packet.summary.ipId, packet.steps.length, packet.decidedBy?.rule])).toEqual([
      ['3c0118c9#0', 'echo-request', '13597', 2, 'iif "lo" accept'],
      ['3c0118c9#1', 'echo-reply', '13598', 2, 'ct state established,related accept'],
    ]);
  });

  it('sums up a packet', () => {
    expect(summarize(parseTraceLine(LINES[3]!)!.packet!)).toEqual({
      ipId: '23602',
      iif: 'lo',
      saddr: '127.0.0.1',
      daddr: '127.0.0.1',
      protocol: 'tcp',
      sport: '59846',
      dport: '9',
      tcpFlags: 'syn',
      length: '60',
    });
  });
});

describe('trace filters', () => {
  it('refuses values that could be more than a value', () => {
    expect(traceFilterProblem({ protocol: 'tcp', dport: '22, 80-90', saddr: '10.0.0.0/24' })).toBeUndefined();
    expect(traceFilterProblem({ protocol: 'tcp', dport: '22 drop' })).toMatch(/not a value/);
    expect(traceFilterProblem({ protocol: 'tcp', dport: '22;flush ruleset' })).toMatch(/not a value/);
    expect(traceFilterProblem({ dport: '22' })).toMatch(/ports need/);
    expect(traceFilterProblem({ saddr: '10.0.0.1', daddr: 'fe80::1' })).toMatch(/both/);
    expect(traceFilterProblem({ protocol: 'tcp; drop' })).toMatch(/unknown protocol/);
  });

  it('builds a table that only marks packets', () => {
    expect(traceTable('hopdeck_trace_ab12', { protocol: 'tcp', dport: '22', saddr: '10.0.0.5' }, 10)).toBe(
      [
        'table inet hopdeck_trace_ab12 {',
        '\tchain pre {',
        '\t\ttype filter hook prerouting priority -350; policy accept;',
        '\t\tip saddr 10.0.0.5 tcp dport 22 limit rate 10/second meta nftrace set 1',
        '\t}',
        '\tchain out {',
        '\t\ttype filter hook output priority -350; policy accept;',
        '\t\tip saddr 10.0.0.5 tcp dport 22 limit rate 10/second meta nftrace set 1',
        '\t}',
        '}',
        '',
      ].join('\n'),
    );
    const arriving = traceTable('hopdeck_trace_ab12', { protocol: 'icmp', iif: 'eth0' }, 5);
    expect(arriving).toContain('\t\tiifname "eth0" meta l4proto icmp limit rate 5/second meta nftrace set 1');
    expect(arriving).toContain('\tchain out {\n\t\ttype filter hook output priority -350; policy accept;\n\t}');
    expect(traceTable('hopdeck_trace_ab12', {}, 10)).toContain('\t\tlimit rate 10/second meta nftrace set 1');
  });
});
