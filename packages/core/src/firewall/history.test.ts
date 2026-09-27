import { describe, expect, it } from 'vitest';
import { historyFingerprints, parseHostSettings, restoreChanges, tableFileName, type HistoryVersionDetail } from './history.ts';
import { tableKey } from './keys.ts';

describe('parseHostSettings', () => {
  it('takes the defaults for anything missing, broken or out of range', () => {
    expect(parseHostSettings(undefined)).toEqual({ history: { maxBytes: 10 * 1024 * 1024 } });
    expect(parseHostSettings('{"history":{"maxBytes":5242880}}')).toEqual({ history: { maxBytes: 5242880 } });
    expect(parseHostSettings('{"history":{"maxBytes":12}}').history.maxBytes).toBe(10 * 1024 * 1024);
    expect(parseHostSettings('not json').history.maxBytes).toBe(10 * 1024 * 1024);
  });
});

describe('historyFingerprints', () => {
  const ruleset = (comment?: string) => ({
    nftables: [
      { table: { family: 'inet', name: 'mine', handle: 1, ...(comment && { comment }) } },
      { table: { family: 'inet', name: 'docker', handle: 2 } },
    ],
  });

  it('covers managed tables only, the old marker included', () => {
    expect(Object.keys(historyFingerprints(ruleset('managed by hopdeck')))).toEqual([tableKey('inet', 'mine')]);
    expect(Object.keys(historyFingerprints(ruleset('managed by nftm')))).toEqual([tableKey('inet', 'mine')]);
    expect(historyFingerprints(ruleset())).toEqual({});
  });
});

describe('restoreChanges', () => {
  const detail: HistoryVersionDetail = {
    version: { id: 4, time: '', kind: 'change', author: { user: 'a', computer: 'b', login: 'root' }, changes: [], tables: [] },
    tables: [
      { family: 'inet', name: 'same', text: 'table inet same {\n\tcounter c {\n\t\tpackets 0 bytes 0\n\t}\n}\n' },
      { family: 'inet', name: 'edited', text: 'table inet edited {\n\tcomment "managed by hopdeck"\n}\n' },
      { family: 'inet', name: 'deleted', text: 'table inet deleted {\n}\n' },
    ],
  };
  const listing = [
    'table inet same {\n\tcounter c {\n\t\tpackets 12 bytes 800\n\t}\n}',
    'table inet edited {\n\tcomment "managed by hopdeck"\n\tchain c {\n\t}\n}',
    'table inet added {\n\tcomment "managed by hopdeck"\n}',
    '',
  ].join('\n');
  const managed = [
    { family: 'inet' as const, name: 'same' },
    { family: 'inet' as const, name: 'edited' },
    { family: 'inet' as const, name: 'added' },
  ];

  it('replaces what differs, recreates what is gone and deletes what came later; counters alone are no difference', () => {
    expect(restoreChanges(detail, listing, managed)).toEqual([
      { kind: 'replace', family: 'inet', table: 'edited', definition: detail.tables[1]!.text },
      { kind: 'replace', family: 'inet', table: 'deleted', definition: detail.tables[2]!.text },
      { kind: 'delete', family: 'inet', table: 'added' },
    ]);
  });

  it('can put back a single table', () => {
    expect(restoreChanges(detail, listing, managed, { family: 'inet', name: 'added' })).toEqual([{ kind: 'delete', family: 'inet', table: 'added' }]);
    expect(restoreChanges(detail, listing, managed, { family: 'inet', name: 'same' })).toEqual([]);
  });
});

describe('tableFileName', () => {
  it('escapes what does not belong in a file name', () => {
    expect(tableFileName('ip', 'a b/c')).toBe('ip-a%20b%2fc.nft');
    expect(tableFileName('../x' as 'ip', 'y')).toBe('..%2fx-y.nft');
  });
});
