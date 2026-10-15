// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { getAsset, isSea } from 'node:sea';

/** The built web UI, file by file. */
export interface WebFiles {
  /** A file by its path under the UI's root, e.g. "index.html"; undefined when there is none. */
  read(path: string): Promise<Buffer | undefined>;
}

/** The UI in a directory, as `vite build` leaves it. Paths never leave the directory. */
export function webFilesIn(directory: string): WebFiles {
  const root = resolve(directory);
  return {
    async read(path) {
      const file = resolve(root, path);
      if (!file.startsWith(root + sep)) return undefined;
      const found = await stat(file).catch(() => undefined);
      return found?.isFile() === true ? readFile(file) : undefined;
    },
  };
}

/** Where the UI's files are among the assets of hopdeck built as one executable. */
export const SEA_WEB_PREFIX = 'web/';

/** The UI built into this executable, see scripts/build-sea.ts in the cli package. */
export function webFilesInExecutable(): WebFiles {
  return {
    async read(path) {
      return embedded(`${SEA_WEB_PREFIX}${path}`);
    },
  };
}

/** Whether this is hopdeck built as one executable (a Node.js single executable application). */
export function inExecutable(): boolean {
  return isSea();
}

/** An asset built into the executable, or undefined, also outside one. */
export function embedded(key: string): Buffer | undefined {
  if (!isSea()) return undefined;
  try {
    return Buffer.from(getAsset(key));
  } catch {
    // getAsset throws for a key that is not there.
    return undefined;
  }
}
