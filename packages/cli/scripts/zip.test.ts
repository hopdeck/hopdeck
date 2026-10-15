// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unzipEntry, zip } from './zip.ts';

const entries = [
  { name: 'hopdeck-1.0.0-win-x64/README.md', data: Buffer.from('# hopdeck\n') },
  { name: 'hopdeck-1.0.0-win-x64/hopdeck.exe', data: Buffer.alloc(100_000, 'MZ'), executable: true },
  { name: 'hopdeck-1.0.0-win-x64/zażółć.txt', data: Buffer.from('') },
];
const time = new Date('2026-09-28T01:02:04Z');

describe('zip', () => {
  it('reads back what it writes, and writes the same bytes each time', () => {
    const archive = zip(entries, time);
    for (const entry of entries) expect(unzipEntry(archive, entry.name).equals(entry.data)).toBe(true);
    expect(zip(entries, time).equals(archive)).toBe(true);
    expect(() => unzipEntry(archive, 'missing')).toThrow(/not in the zip/);
  });

  it('writes a zip other tools read, with the time and mode it was given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hopdeck-zip-'));
    try {
      await writeFile(join(dir, 'test.zip'), zip(entries, time));
      const listed = execFileSync('python3', [
        '-c',
        'import sys, zipfile\nfor i in zipfile.ZipFile(sys.argv[1]).infolist(): print(i.filename, i.file_size, i.date_time, oct(i.external_attr >> 16))',
        join(dir, 'test.zip'),
      ], { encoding: 'utf8' });
      expect(listed).toBe(
        [
          "hopdeck-1.0.0-win-x64/README.md 10 (2026, 9, 28, 1, 2, 4) 0o100644",
          "hopdeck-1.0.0-win-x64/hopdeck.exe 100000 (2026, 9, 28, 1, 2, 4) 0o100755",
          "hopdeck-1.0.0-win-x64/zażółć.txt 0 (2026, 9, 28, 1, 2, 4) 0o100644",
          '',
        ].join('\n'),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads a file from a zip another tool made', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hopdeck-zip-'));
    try {
      await writeFile(join(dir, 'LICENSE'), 'Node.js is licensed for use as follows:\n'.repeat(50));
      execFileSync('python3', ['-c', 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z: z.write(sys.argv[2], "node/LICENSE")', join(dir, 'other.zip'), join(dir, 'LICENSE')]);
      expect(unzipEntry(await readFile(join(dir, 'other.zip')), 'node/LICENSE').toString()).toBe(await readFile(join(dir, 'LICENSE'), 'utf8'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
