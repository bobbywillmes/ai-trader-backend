import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: mode === "acceptance" ? 5174 : 5173,
    proxy: {
      "/api": {
        target: mode === "acceptance" ? "http://127.0.0.1:3304" : "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
}));
