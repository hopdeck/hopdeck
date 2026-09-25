/**
 * Lines of the edited definition that nft complained about. nft names lines of
 * change.nft, which starts with two lines of its own ("table X {}" and
 * "delete table X") before the definition.
 */
export function definitionErrorLines(message: string, preamble = 2): number[] {
  const lines = [...message.matchAll(/change\.nft:(\d+):/g)].map((match) => Number(match[1]) - preamble);
  return [...new Set(lines.filter((line) => line >= 1))];
}
