import { defineConfig } from 'vite';

// crossOriginIsolated enables SharedArrayBuffer, which the engine uses for
// zero-copy, low-jitter playhead reporting from the AudioWorklet. The app
// degrades gracefully to postMessage transport when these headers are absent.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { port: 5173, headers: isolationHeaders },
  preview: { port: 4173, headers: isolationHeaders },
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
});
