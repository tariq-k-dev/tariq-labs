import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    // The spike fetches from :8788 on purpose — a same-origin setup would hide
    // the entire class of bug this experiment exists to find. Do not add a proxy.
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
  },
})
