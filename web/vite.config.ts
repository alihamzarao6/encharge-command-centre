import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The browser app. Static output in web/dist; nothing here runs on a server.
 *
 * Only `VITE_`-prefixed variables reach the bundle (Vite's rule) and only two are read:
 * VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY — the same URL and public key any visitor
 * could see in the network panel. The service role key, the Anthropic key and the voice
 * prompt have no VITE_ name and no import path from here; scripts/check-bundle.ts greps the
 * built output for all three on every build.
 */
export default defineConfig({
  root,
  // The repo-root .env supplies VITE_* for local builds, so there is one .env, not two.
  envDir: repoRoot,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  preview: { port: 4173, strictPort: true },
  server: { port: 5173, strictPort: true },
});
