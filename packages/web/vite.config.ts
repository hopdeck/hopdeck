// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// pnpm dev picks both ports (packages/cli/scripts/dev.ts); these are the usual ones.
const uiPort = Number(process.env['HOPDECK_UI_PORT'] ?? 5173);
const apiPort = Number(process.env['HOPDECK_PORT'] ?? 7400);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: uiPort,
    // The API allows this origin only, so another port would be refused.
    strictPort: true,
    // changeOrigin rewrites Host so the backend's DNS-rebinding check passes.
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
  },
});
