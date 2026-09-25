import { describe, expect, it } from 'vitest';
import { isManaged, nftName, replaceTableScript, withManagedComment } from './changes.ts';
import { diffLines, hasChanges } from './diff.ts';

const table = 'table inet filter {\n\tchain input {\n\t\ttype filter hook input priority filter; policy drop;\n\t}\n}\n';

describe('managed marker', () => {
  it('adds the marker after the opening line', () => {
    expect(withManagedComment(table)).toBe(
      'table inet filter {\n\tcomment "managed by nftm"\n\tchain input {\n\t\ttype filter hook input priority filter; policy drop;\n\t}\n}\n',
    );
  });

  it("keeps the user's own comment after the marker, and does not add it twice", () => {
    const commented = 'table inet filter {\n\tcomment "office firewall"\n}\n';
    const adopted = withManagedComment(commented);
    expect(adopted).toBe('table inet filter {\n\tcomment "managed by nftm: office firewall"\n}\n');
    expect(withManagedComment(adopted)).toBe(adopted);
  });

  it('recognises managed tables', () => {
    expect(isManaged({ comment: 'managed by nftm' })).toBe(true);
    expect(isManaged({ comment: 'managed by nftm: office firewall' })).toBe(true);
    expect(isManaged({ comment: 'not managed by nftm' })).toBe(false);
    expect(isManaged({})).toBe(false);
  });
});

describe('replaceTableScript', () => {
  it('replaces a table in one transaction, whether or not it exists', () => {
    expect(replaceTableScript('inet', 'filter', table)).toBe(`table inet filter {}\ndelete table inet filter\n${table}`);
    expect(replaceTableScript('ip', 'my table', undefined)).toBe('table ip "my table" {}\ndelete table ip "my table"\n');
    expect(nftName('f2b-table')).toBe('f2b-table');
  });
});

describe('diffLines', () => {
  it('aligns a local edit', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'a\nb\nX\nd\ne\n';
    expect(diffLines(before, after)).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'same', text: 'b' },
      { kind: 'add', text: 'X' },
      { kind: 'remove', text: 'c' },
      { kind: 'same', text: 'd' },
      { kind: 'add', text: 'e' },
    ]);
  });

  it('shows one added line for adopting', () => {
    const diff = diffLines(table, withManagedComment(table));
    expect(diff.filter((line) => line.kind !== 'same')).toEqual([{ kind: 'add', text: '\tcomment "managed by nftm"' }]);
    expect(hasChanges(diffLines(table, table))).toBe(false);
  });

  it('handles creating and deleting a whole table', () => {
    expect(diffLines('', 'x\ny\n')).toEqual([
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' },
    ]);
    expect(diffLines('x\n', '')).toEqual([{ kind: 'remove', text: 'x' }]);
  });
});
