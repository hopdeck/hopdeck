// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { describe, expect, it } from 'vitest';
import { ruleCommands } from './rule-commands.ts';

// As `nft -a list table` prints it.
const annotated = `table inet t { # handle 1
	set allowed { # handle 2
		type ipv4_addr
		elements = { 10.0.0.1 }
	}
	chain input { # handle 3
		type filter hook input priority filter; policy drop;
		ct state established,related accept # handle 4
		tcp dport 22 counter packets 12 bytes 800 accept # handle 5
		tcp dport 80 accept # handle 6
	}
	chain other { # handle 7
	}
}
`;

// The same table as an editor sends it back, then changed.
const definition = (input: string[], other: string[] = [], policy = 'drop', elements = '10.0.0.1') => `table inet t {
	set allowed {
		type ipv4_addr
		elements = { ${elements} }
	}
	chain input {
		type filter hook input priority filter; policy ${policy};
${input.map((rule) => `\t\t${rule}\n`).join('')}	}
	chain other {
${other.map((rule) => `\t\t${rule}\n`).join('')}	}
}
`;

const RULES = ['ct state established,related accept', 'tcp dport 22 counter packets 12 bytes 800 accept', 'tcp dport 80 accept'];

describe('ruleCommands', () => {
  it('does nothing when only counter values differ', () => {
    const rules = [RULES[0]!, 'tcp dport 22 counter packets 99 bytes 9000 accept', RULES[2]!];
    expect(ruleCommands('inet', 't', annotated, definition(rules))).toEqual({ script: '', added: 0, removed: 0, replaced: 0 });
  });

  it('changes a rule where it stands, keeping its handle', () => {
    const commands = ruleCommands('inet', 't', annotated, definition([RULES[0]!, RULES[1]!, 'tcp dport 443 accept']));
    expect(commands).toEqual({ script: 'replace rule inet t input handle 6 tcp dport 443 accept\n', added: 0, removed: 0, replaced: 1 });
  });

  it('inserts before the next unchanged rule, and appends after the last one, in order', () => {
    const rules = [RULES[0]!, 'ip saddr @allowed accept', 'ip saddr 10.9.9.9 drop', RULES[1]!, RULES[2]!, 'tcp dport 8080 accept'];
    expect(ruleCommands('inet', 't', annotated, definition(rules, ['counter']))?.script).toBe(
      [
        'insert rule inet t input position 5 ip saddr @allowed accept',
        'insert rule inet t input position 5 ip saddr 10.9.9.9 drop',
        'add rule inet t input tcp dport 8080 accept',
        'add rule inet t other counter',
        '',
      ].join('\n'),
    );
  });

  it('deletes by handle, and moves a rule as a delete and an insert that keeps its counter', () => {
    expect(ruleCommands('inet', 't', annotated, definition([RULES[0]!, RULES[2]!]))).toEqual({
      script: 'delete rule inet t input handle 5\n',
      added: 0,
      removed: 1,
      replaced: 0,
    });
    const moved = ruleCommands('inet', 't', annotated, definition([RULES[1]!, RULES[0]!, RULES[2]!]));
    expect(moved?.script.split('\n').filter(Boolean).sort()).toEqual([
      'delete rule inet t input handle 5',
      'insert rule inet t input position 4 tcp dport 22 counter packets 12 bytes 800 accept',
    ]);
  });

  it('leaves anything but rules to a replacement of the whole table', () => {
    expect(ruleCommands('inet', 't', annotated, definition(RULES, [], 'accept'))).toBeUndefined();
    expect(ruleCommands('inet', 't', annotated, definition(RULES, [], 'drop', '10.0.0.1, 10.0.0.2'))).toBeUndefined();
    expect(ruleCommands('inet', 't', annotated, definition(RULES).replace('\tchain other {\n\t}\n', ''))).toBeUndefined();
    expect(ruleCommands('inet', 't', annotated, definition(RULES).replace('table inet t {\n', 'table inet t {\n\tcomment "managed by hopdeck"\n'))).toBeUndefined();
    expect(ruleCommands('inet', 'missing', annotated, definition(RULES))).toBeUndefined();
  });
});
