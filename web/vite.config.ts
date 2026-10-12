import react from '@vitejs/plugin-react';
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { basename, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * pdf.js's own data files, served from THIS app's origin (Milestone 5 part 1).
 *
 * pdf.js cannot read every PDF from the bytes alone. A PDF whose CJK font is not embedded
 * needs a character map to turn its codes into text — without one the line is dropped,
 * silently — and a scan compressed as JBIG2 or JPEG 2000 needs a decoder to be rendered at
 * all. Those ship inside the pdfjs-dist package; they are copied next to the build and
 * fetched on demand, a few kilobytes at a time, only by a PDF that needs one. Nothing is
 * loaded from a CDN: a broker's client documents are being read, and the reader does not
 * phone anyone.
 */
const PDFJS_DIR = join(repoRoot, 'node_modules', 'pdfjs-dist');
const PDFJS_ASSETS = ['cmaps', 'wasm', 'iccs', 'standard_fonts'] as const;

/**
 * Everything in those folders EXCEPT pdf.js's scripting sandbox (quickjs-eval). That engine
 * exists to run the JavaScript embedded in a PDF form; this app never runs a document's
 * script, so the engine is not shipped at all.
 */
function wanted(file: string): boolean {
  return !basename(file).startsWith('quickjs');
}

function pdfjsAssets(): Plugin[] {
  return [
    {
      name: 'pdfjs-assets:build',
      apply: 'build',
      closeBundle() {
        for (const dir of PDFJS_ASSETS) {
          cpSync(join(PDFJS_DIR, dir), join(root, 'dist', 'pdfjs', dir), {
            recursive: true,
            filter: wanted,
          });
        }
      },
    },
    {
      // The dev server has no dist/: serve the same files straight from the package.
      name: 'pdfjs-assets:serve',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use('/pdfjs', (request, response, next) => {
          const requested = normalize(decodeURIComponent((request.url ?? '').split('?')[0] ?? ''));
          const [, top] = requested.split(sep);
          const file = join(PDFJS_DIR, requested);
          const allowed =
            (PDFJS_ASSETS as readonly string[]).includes(top ?? '') &&
            file.startsWith(PDFJS_DIR + sep) &&
            wanted(file) &&
            existsSync(file) &&
            statSync(file).isFile();
          if (!allowed) {
            next();
            return;
          }
          createReadStream(file).pipe(response);
        });
      },
    },
  ];
}

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
  plugins: [react(), ...pdfjsAssets()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  preview: { port: 4173, strictPort: true },
  server: { port: 5173, strictPort: true },
});
