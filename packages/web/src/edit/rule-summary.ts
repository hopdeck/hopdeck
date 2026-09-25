import type { RuleAction, RuleForm } from '@nftm/core';

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
    extra: [
      form.limit && `limit ${form.limit.rate}/${form.limit.per}`,
      form.counterName !== undefined ? `counter ${form.counterName}` : form.counter && 'counter',
      form.log && `log${form.log.prefix !== undefined ? ` "${form.log.prefix}"` : ''}`,
    ]
      .filter(Boolean)
      .join(', '),
  };
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
    default:
      return action.kind;
  }
}

function actionTone(action: RuleAction): RuleColumns['actionTone'] {
  if (action.kind === 'accept') return 'accept';
  if (action.kind === 'drop' || action.kind === 'reject') return 'drop';
  if (action.kind === 'jump' || action.kind === 'goto' || action.kind === 'return') return 'jump';
  return 'other';
}
