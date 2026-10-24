import { defineConfig } from 'vite'

// No React plugin on purpose: esbuild's automatic JSX transform handles React 19,
// so the dev server and build need one less dependency. The cost is no Fast Refresh.
//
// The data origin is deliberately a different origin from the app (see the skill's
// "never proxy the bucket" pitfall): a same-origin proxy would hide the CORS and
// preflight class of bug this product exists to demonstrate.
export default defineConfig({
  server: {
    port: 5273,
    host: '127.0.0.1',
  },
  esbuild: {
    jsx: 'automatic',
  },
  build: {
    target: 'es2022',
    // The Parquet reader must never land in the entry bundle. Query chunks are
    // reported by name at build time; check them with `pnpm build`.
    chunkSizeWarningLimit: 900,
  },
})
