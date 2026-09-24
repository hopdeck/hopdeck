import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // changeOrigin rewrites Host so the backend's DNS-rebinding check passes.
    proxy: { '/api': { target: 'http://127.0.0.1:7400', changeOrigin: true } },
  },
});
