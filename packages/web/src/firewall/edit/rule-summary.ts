// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { renderLimit, type Limit, type RuleAction, type RuleForm, type TcpFlags } from '@hopdeck/core';

/** A rule in the columns of the rules grid, as short nft-like text. */
export interface RuleColumns {
  action: string;
  actionTone: 'accept' | 'drop' | 'jump' | 'other';
  protocol: string;
  source: string;
  destination: string;
  sourcePort: string;
  destinationPort: string;
  input: string;
  output: string;
  state: string;
  /** TCP flags, length, packet type, mark, reverse path. */
  packet: string;
  /** Rate limits, connection count, quota. */
  limits: string;
  extra: string;
}

export function ruleColumns(form: RuleForm): RuleColumns {
  const not = (match: { value: string; negate: boolean } | undefined) => (match === undefined ? '' : `${match.negate ? '!' : ''}${match.value}`);
  return {
    action: actionText(form.action),
    actionTone: actionTone(form.action),
    protocol: form.protocol ?? '',
    source: not(form.srcAddress),
    destination: not(form.dstAddress),
    sourcePort: not(form.srcPort),
    destinationPort: not(form.dstPort) || (form.icmpType ?? ''),
    input: not(form.inInterface),
    output: not(form.outInterface),
    state: (form.ctState ?? []).join(', '),
    packet: [
      form.tcpFlags && flagsText(form.tcpFlags),
      form.length && `length ${form.length.op === '==' ? '' : `${form.length.op} `}${form.length.value}`,
      form.pktType && `${form.pktType.negate ? '!' : ''}${form.pktType.value}`,
      form.mark && `${form.mark.source} mark ${form.mark.op === '==' ? '' : `${form.mark.op} `}${form.mark.value}`,
      form.rpfilter && 'rpfilter',
    ]
      .filter(Boolean)
      .join(', '),
    limits: [
      form.limit && limitText(form.limit),
      form.keyedLimit && `${form.keyedLimit.key}: ${limitText(form.keyedLimit.limit)}`,
      form.connLimit && `ct count ${form.connLimit.over ? 'over ' : ''}${form.connLimit.count}`,
      form.quota && `quota ${form.quota.over ? 'over ' : ''}${form.quota.amount} ${form.quota.unit}`,
    ]
      .filter(Boolean)
      .join(', '),
    extra: [
      form.counterName !== undefined ? `counter ${form.counterName}` : form.counter && 'counter',
      form.log && `log${form.log.prefix !== undefined ? ` "${form.log.prefix}"` : ''}${form.log.group !== undefined ? ` group ${form.log.group}` : ''}`,
      form.markSet && `${form.markSet.target} mark set ${form.markSet.value}`,
      form.notrack && 'notrack',
    ]
      .filter(Boolean)
      .join(', '),
  };
}

/** "syn !ack", or "syn|ack" when one of them is enough. */
function flagsText({ set, unset, any }: TcpFlags): string {
  if (any) return `flags ${set.join('|')}`;
  return `flags ${[...set, ...unset.map((flag) => `!${flag}`)].join(' ')}`;
}

function limitText(limit: Limit): string {
  return renderLimit(limit).replace(/^limit rate /, '').replace(/ burst .*/, '');
}

function actionText(action: RuleAction): string {
  switch (action.kind) {
    case 'none':
      return '';
    case 'reject':
      return action.with === undefined ? 'reject' : `reject (${action.with})`;
    case 'jump':
    case 'goto':
      return `${action.kind} ${action.target}`;
    case 'snat':
    case 'dnat':
      return `${action.kind} ${action.to}`;
    case 'redirect':
      return `redirect :${action.port}`;
    case 'vmap':
      return `vmap ${action.map.startsWith('@') ? action.map : '{…}'}`;
    default:
      return action.kind;
  }
}

function actionTone(action: RuleAction): RuleColumns['actionTone'] {
  if (action.kind === 'accept') return 'accept';
  if (action.kind === 'drop' || action.kind === 'reject') return 'drop';
  if (action.kind === 'jump' || action.kind === 'goto' || action.kind === 'return' || action.kind === 'vmap') return 'jump';
  return 'other';
}
