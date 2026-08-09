import { defineConfig } from 'vite'

// The dev-only /musescore static plugin was removed in the Warble rework —
// it served MusicXML test fixtures to the score-loading UI, which no longer
// exists. Likewise /score, /transcribe and /session are no longer proxied:
// those backend routes still exist but nothing in the frontend calls them.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to FastAPI backend during development
      '/health': 'http://127.0.0.1:8000',
      '/audio': 'http://127.0.0.1:8000',
      '/playback': 'http://127.0.0.1:8000',
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
      },
    },
  },
})
