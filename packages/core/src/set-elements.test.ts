import { describe, expect, it } from 'vitest';
import { elementChangeScript, elementParts, elementProblem, parseSetBlock, restoreElementsScript, splitList } from './set-elements.ts';

// Blocks as nft 1.1 lists them, one indent removed (Listing.blocks).
const TIMEOUTS = [
  'set tl {',
  '\ttype ipv4_addr',
  '\ttimeout 1h',
  '\telements = { 1.2.3.4 timeout 10m expires 9m59s996ms comment "bad, bot",',
  '\t\t     5.6.7.8 expires 59m59s996ms comment "x" }',
  '}',
].join('\n');
const MAP = [
  'map m {',
  '\ttype inet_service : verdict',
  '\tflags timeout',
  '\telements = { 22 timeout 1h expires 59m59s996ms comment "ssh" : jump x,',
  '\t\t     80 : drop }',
  '}',
].join('\n');

describe('parseSetBlock', () => {
  it('splits a set into its declaration and elements, across wrapped lines', () => {
    expect(parseSetBlock(TIMEOUTS)).toEqual({
      kind: 'set',
      name: 'tl',
      declaration: ['type ipv4_addr', 'timeout 1h'],
      elements: ['1.2.3.4 timeout 10m expires 9m59s996ms comment "bad, bot"', '5.6.7.8 expires 59m59s996ms comment "x"'],
    });
  });

  it('reads maps, empty sets and concatenations', () => {
    expect(parseSetBlock(MAP)?.elements).toEqual(['22 timeout 1h expires 59m59s996ms comment "ssh" : jump x', '80 : drop']);
    expect(parseSetBlock('set blocklist {\n\ttype ipv4_addr\n\tflags timeout\n}')).toEqual({
      kind: 'set',
      name: 'blocklist',
      declaration: ['type ipv4_addr', 'flags timeout'],
      elements: [],
    });
    expect(parseSetBlock('set cc {\n\ttype ipv4_addr . inet_service\n\telements = { 1.2.3.4 . 22,\n\t\t     5.6.7.8 . 80 }\n}')?.elements).toEqual([
      '1.2.3.4 . 22',
      '5.6.7.8 . 80',
    ]);
    expect(parseSetBlock('flowtable f {\n\thook ingress priority filter\n}')).toBeUndefined();
  });
});

describe('elementParts', () => {
  it('takes an element apart', () => {
    expect(elementParts('1.2.3.4 timeout 10m expires 9m59s996ms comment "bad, bot"', false)).toEqual({
      key: '1.2.3.4',
      timeout: '10m',
      expires: '9m59s996ms',
      comment: 'bad, bot',
    });
    expect(elementParts('1.1.1.1 counter packets 5 bytes 300', false)).toEqual({ key: '1.1.1.1', counter: { packets: 5, bytes: 300 } });
    expect(elementParts('22 timeout 1h expires 59m comment "ssh" : jump x', true)).toEqual({
      key: '22',
      value: 'jump x',
      timeout: '1h',
      expires: '59m',
      comment: 'ssh',
    });
    expect(elementParts('192.168.1.1-192.168.1.9', false)).toEqual({ key: '192.168.1.1-192.168.1.9' });
    expect(elementParts('1.2.3.4 . 22', false)).toEqual({ key: '1.2.3.4 . 22' });
  });
});

describe('element scripts', () => {
  it('remove first, then create, so an element can be replaced', () => {
    expect(elementChangeScript('inet', 'filter', 'blocklist', ['1.2.3.4 timeout 1h', '5.6.7.8'], ['9.9.9.9'])).toBe(
      'delete element inet filter blocklist { 9.9.9.9 }\ncreate element inet filter blocklist { 1.2.3.4 timeout 1h, 5.6.7.8 }\n',
    );
  });

  it('restore the elements exactly as they were', () => {
    expect(restoreElementsScript('inet', 'filter', 'map', 'port_policy', ['22 : jump ssh_in', '8080 : drop'])).toBe(
      'flush map inet filter port_policy\nadd element inet filter port_policy { 22 : jump ssh_in, 8080 : drop }\n',
    );
    expect(restoreElementsScript('ip', 'nat', 'set', 's', [])).toBe('flush set ip nat s\n');
  });
});

describe('elementProblem', () => {
  it('lets through one element and nothing more', () => {
    expect(elementProblem('10.0.0.0/24')).toBeUndefined();
    expect(elementProblem('1.2.3.4 timeout 1h comment "a; #b"')).toBeUndefined();
    expect(elementProblem('1.2.3.4 }\nflush ruleset')).toBeDefined();
    expect(elementProblem('1.2.3.4 } ; flush ruleset ; add element x y z {')).toBeDefined();
    expect(elementProblem('1.2.3.4, 5.6.7.8')).toBeDefined();
    expect(elementProblem('1.2.3.4 }')).toBeDefined();
    expect(elementProblem('"eth0')).toBeDefined();
    expect(splitList(' a, "b, c" ,{ d, e } ')).toEqual(['a', '"b, c"', '{ d, e }']);
  });
});
