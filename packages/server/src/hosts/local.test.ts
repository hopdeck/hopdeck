import { describe, expect, it } from 'vitest';
import { LocalExecutor } from './local.ts';

describe('LocalExecutor', () => {
  const local = new LocalExecutor();

  it('runs programs without a shell', async () => {
    const result = await local.exec(['printf', '%s|%s', '$HOME', 'a b']);
    expect(result).toEqual({ exitCode: 0, stdout: '$HOME|a b', stderr: '' });
  });

  it('passes standard input and reports exit codes', async () => {
    expect((await local.exec(['cat'], { stdin: 'table inet t {}\n' })).stdout).toBe('table inet t {}\n');
    expect((await local.exec(['sh', '-c', 'echo oops >&2; exit 3'])).exitCode).toBe(3);
  });

  it('rejects when the program cannot run or takes too long', async () => {
    await expect(local.exec(['/nonexistent/nft'])).rejects.toThrow(/ENOENT/);
    await expect(new LocalExecutor({ timeoutMs: 100 }).exec(['sleep', '5'])).rejects.toThrow(/timed out/);
    await expect(local.exec([])).rejects.toThrow(/empty command/);
  });
});
