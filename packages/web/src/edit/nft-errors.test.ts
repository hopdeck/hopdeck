import { describe, expect, it } from 'vitest';
import { definitionErrorLines } from './nft-errors.ts';

describe('definitionErrorLines', () => {
  it("maps nft's change.nft lines to lines of the definition", () => {
    const message = [
      '/tmp/nftm.Ab12/change.nft:7:24-28: Error: syntax error, unexpected string',
      '\t\ttcp dport 22 acept',
      '                   ^^^^^',
      '/tmp/nftm.Ab12/change.nft:7:1-3: Error: something else',
      '/tmp/nftm.Ab12/change.nft:12:5-9: Error: unknown chain',
    ].join('\n');
    expect(definitionErrorLines(message)).toEqual([5, 10]);
    expect(definitionErrorLines('Error: Could not process rule: No such file or directory')).toEqual([]);
  });
});
