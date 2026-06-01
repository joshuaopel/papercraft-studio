import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Project Pages serve from /<repo-name>/. Override with VITE_BASE for forks.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/papercraft-studio/',
  plugins: [react()],
});
