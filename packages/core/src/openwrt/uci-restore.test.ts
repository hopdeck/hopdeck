// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import firewallJson from '../../test/fixtures/openwrt/firewall-25.12.json' with { type: 'json' };
import { addUciChange, previewUci } from './uci-edit.ts';
import { uciRestoreChanges } from './uci-restore.ts';
import { parseUciGet, type UciChange, type UciConfig } from './uci.ts';

const base = parseUciGet('firewall', JSON.stringify(firewallJson));

/** A configuration as its content: what UCI names anonymously stays unnamed. */
const content = (config: UciConfig) => config.sections.map((section) => ({ type: section.type, name: section.anonymous ? null : section.name, options: section.options }));
const edited = (...changes: UciChange[]) => previewUci(base, changes.reduce<UciChange[]>((list, change) => addUciChange(base, list, change), []));

describe('uciRestoreChanges', () => {
  it('needs nothing to restore what is there', () => {
    expect(uciRestoreChanges(base, base)).toEqual([]);
  });

  it('puts back an option, a removed rule and a moved one as edits, not everything anew', () => {
    const ping = base.sections.find((section) => section.options['name'] === 'Allow-Ping')!;
    const igmp = base.sections.find((section) => section.options['name'] === 'Allow-IGMP')!;
    const now = edited(
      { kind: 'set', section: ping.name, values: { target: 'DROP' } },
      { kind: 'delete', section: igmp.name },
      { kind: 'add', type: 'rule', ref: 'new-1', values: { name: 'Extra', target: 'ACCEPT' } },
    );
    const changes = uciRestoreChanges(now, base);
    expect(changes.filter((change) => change.kind === 'set')).toEqual([{ kind: 'set', section: ping.name, values: { target: 'ACCEPT' } }]);
    expect(changes.filter((change) => change.kind === 'delete')).toEqual([{ kind: 'delete', section: 'new-1' }]);
    expect(changes.filter((change) => change.kind === 'add')).toEqual([{ kind: 'add', type: 'rule', ref: 'new-r1', values: igmp.options }]);
    expect(content(previewUci(now, changes))).toEqual(content(base));
  });

  it('keeps named sections by their name, and the order of the version', () => {
    const named: UciConfig = {
      name: 'firewall',
      sections: [
        { name: 'hopdeck_a', type: 'include', anonymous: false, index: 0, options: { path: '/etc/hopdeck/fw4/a.2.nft' } },
        { name: 'cfg01', type: 'rule', anonymous: true, index: 1, options: { name: 'One' } },
        { name: 'cfg02', type: 'rule', anonymous: true, index: 2, options: { name: 'Two' } },
      ],
    };
    const later: UciConfig = {
      name: 'firewall',
      sections: [
        { name: 'cfg01', type: 'rule', anonymous: true, index: 0, options: { name: 'Two' } },
        { name: 'cfg02', type: 'rule', anonymous: true, index: 1, options: { name: 'One', enabled: '0' } },
        { name: 'hopdeck_a', type: 'include', anonymous: false, index: 2, options: { path: '/etc/hopdeck/fw4/a.3.nft' } },
      ],
    };
    const changes = uciRestoreChanges(later, named);
    expect(changes).toContainEqual({ kind: 'set', section: 'hopdeck_a', values: { path: '/etc/hopdeck/fw4/a.2.nft' } });
    expect(changes).toContainEqual({ kind: 'unset', section: 'cfg02', options: ['enabled'] });
    expect(changes.at(-1)).toEqual({ kind: 'order', sections: ['hopdeck_a', 'cfg02', 'cfg01'] });
    expect(content(previewUci(later, changes))).toEqual(content(named));
  });
});
