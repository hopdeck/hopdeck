// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import firewallJson from '../../test/fixtures/openwrt/firewall-25.12.json' with { type: 'json' };
import { parseUciGet, type UciChange } from './uci.ts';
import { addUciChange, movedSections, nextRef, previewUci, sectionChanges, typeOrder } from './uci-edit.ts';

const base = parseUciGet('firewall', JSON.stringify(firewallJson));
const lan = base.sections.find((section) => section.options['name'] === 'lan')!;
const ping = base.sections.find((section) => section.options['name'] === 'Allow-Ping')!;
const collect = (...changes: UciChange[]) => changes.reduce<UciChange[]>((list, change) => addUciChange(base, list, change), []);

describe('addUciChange', () => {
  it('makes one change of several edits of a section', () => {
    expect(collect({ kind: 'set', section: lan.name, values: { input: 'REJECT' } }, { kind: 'set', section: lan.name, values: { log: '1' } })).toEqual([
      { kind: 'set', section: lan.name, values: { input: 'REJECT', log: '1' } },
    ]);
  });

  it('drops an edit back to what the router has', () => {
    expect(collect({ kind: 'set', section: lan.name, values: { input: 'REJECT' } }, { kind: 'set', section: lan.name, values: { input: 'ACCEPT' } })).toEqual([]);
    expect(collect({ kind: 'set', section: lan.name, values: { input: 'ACCEPT' } })).toEqual([]);
  });

  it('removes only what the router has, and forgets a set of what is removed', () => {
    expect(collect({ kind: 'set', section: lan.name, values: { log: '1' } }, { kind: 'unset', section: lan.name, options: ['log'] })).toEqual([]);
    expect(collect({ kind: 'unset', section: lan.name, options: ['input', 'mtu_fix'] })).toEqual([{ kind: 'unset', section: lan.name, options: ['input'] }]);
    expect(collect({ kind: 'unset', section: lan.name, options: ['input'] }, { kind: 'set', section: lan.name, values: { input: 'DROP' } })).toEqual([
      { kind: 'set', section: lan.name, values: { input: 'DROP' } },
    ]);
  });

  it('edits a section added before review in its add, and a removal undoes the add', () => {
    const added = collect(
      { kind: 'add', type: 'rule', ref: 'new-1', values: { name: 'web', target: 'ACCEPT' } },
      { kind: 'set', section: 'new-1', values: { dest_port: '80' } },
      { kind: 'unset', section: 'new-1', options: ['target'] },
    );
    expect(added).toEqual([{ kind: 'add', type: 'rule', ref: 'new-1', values: { name: 'web', dest_port: '80' } }]);
    expect(addUciChange(base, added, { kind: 'delete', section: 'new-1' })).toEqual([]);
  });

  it('removes a section with its pending edits, and keeps the order last, without it', () => {
    const changes = collect(
      { kind: 'set', section: ping.name, values: { enabled: '0' } },
      { kind: 'order', sections: [ping.name, lan.name] },
      { kind: 'add', type: 'rule', ref: 'new-1', values: { name: 'x' } },
      { kind: 'delete', section: ping.name },
    );
    expect(changes).toEqual([
      { kind: 'add', type: 'rule', ref: 'new-1', values: { name: 'x' } },
      { kind: 'delete', section: ping.name },
      { kind: 'order', sections: [lan.name] },
    ]);
  });
});

describe('previewUci', () => {
  it('shows the configuration with the changes, new sections last', () => {
    const preview = previewUci(
      base,
      collect(
        { kind: 'set', section: lan.name, values: { input: 'REJECT' } },
        { kind: 'delete', section: ping.name },
        { kind: 'add', type: 'redirect', ref: 'new-1', values: { name: 'web' } },
      ),
    );
    expect(preview.sections.find((section) => section.name === lan.name)?.options['input']).toBe('REJECT');
    expect(preview.sections.some((section) => section.name === ping.name)).toBe(false);
    expect(preview.sections.at(-1)).toMatchObject({ name: 'new-1', type: 'redirect', anonymous: true, index: preview.sections.length - 1 });
    // The router's configuration is left as it was.
    expect(lan.options['input']).toBe('ACCEPT');
  });

  it('moves sections as rpcd does: those named first, the rest after in their order', () => {
    const rules = base.sections.filter((section) => section.type === 'rule').map((section) => section.name);
    const order = typeOrder(base, 'rule', [rules[2]!, rules[0]!, ...rules.slice(1, 2), ...rules.slice(3)]);
    const preview = previewUci(base, [order]);
    // Only the rules trade places; defaults, zones and the forwarding stay where they were.
    expect(preview.sections.map((section) => section.type)).toEqual(base.sections.map((section) => section.type));
    expect(preview.sections.filter((section) => section.type === 'rule').map((section) => section.options['name']).slice(0, 3)).toEqual([
      'Allow-IGMP',
      'Allow-DHCP-Renew',
      'Allow-Ping',
    ]);
  });
});

describe('sectionChanges', () => {
  it('adds a new section with what is set', () => {
    expect(sectionChanges(undefined, 'zone', { name: 'guest', masq: undefined, input: 'REJECT' }, 'new-2')).toEqual([
      { kind: 'add', type: 'zone', ref: 'new-2', values: { name: 'guest', input: 'REJECT' } },
    ]);
  });

  it('sets what differs and removes what goes, leaving other options alone', () => {
    expect(sectionChanges(lan, 'zone', { input: 'ACCEPT', forward: 'REJECT', log: undefined, masq: '1' }, 'unused')).toEqual([
      { kind: 'set', section: lan.name, values: { forward: 'REJECT', masq: '1' } },
    ]);
    expect(sectionChanges(lan, 'zone', { output: undefined }, 'unused')).toEqual([{ kind: 'unset', section: lan.name, options: ['output'] }]);
  });
});

describe('nextRef', () => {
  it('gives the first free name', () => {
    expect(nextRef([])).toBe('new-1');
    expect(nextRef([{ kind: 'add', type: 'rule', ref: 'new-1', values: {} }, { kind: 'add', type: 'rule', ref: 'new-3', values: {} }])).toBe('new-2');
  });
});

describe('movedSections', () => {
  it('names the one dragged, not those it passed', () => {
    expect(movedSections(['a', 'b', 'c', 'd', 'e'], ['e', 'a', 'b', 'c', 'd'])).toEqual(new Set(['e']));
    expect(movedSections(['a', 'b', 'c', 'd'], ['b', 'c', 'a', 'd'])).toEqual(new Set(['a']));
    expect(movedSections(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual(new Set());
  });

  it('leaves out sections new or gone', () => {
    expect(movedSections(['a', 'b', 'c'], ['new-1', 'c', 'a'])).toEqual(new Set(['c']));
  });
});
