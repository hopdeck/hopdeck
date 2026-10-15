// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embedded, inExecutable, webFilesIn, webFilesInExecutable } from './web-files.ts';

describe('webFilesIn', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hopdeck-web-files-'));
    await mkdir(join(root, 'ui/assets'), { recursive: true });
    await writeFile(join(root, 'ui/index.html'), '<!doctype html>');
    await writeFile(join(root, 'ui/assets/app.js'), 'app');
    await writeFile(join(root, 'secret'), 'secret');
  });

  afterAll(() => rm(root, { recursive: true, force: true }));

  it('reads files under the directory, and nothing else', async () => {
    const web = webFilesIn(join(root, 'ui'));
    expect((await web.read('assets/app.js'))?.toString()).toBe('app');
    expect(await web.read('assets')).toBeUndefined();
    expect(await web.read('missing.js')).toBeUndefined();
    expect(await web.read('../secret')).toBeUndefined();
    expect(await web.read(join(root, 'secret'))).toBeUndefined();
  });
});

describe('outside the executable', () => {
  it('has no embedded files, so hopdeck reads them from the source tree', async () => {
    expect(inExecutable()).toBe(false);
    expect(embedded('sandbox-demo.nft')).toBeUndefined();
    expect(await webFilesInExecutable().read('index.html')).toBeUndefined();
  });
});
