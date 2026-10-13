import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { assertAcceptanceApiRouting, resolveApiBaseUrl } from './src/lib/api-routing'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiBaseUrl = resolveApiBaseUrl(mode, env.VITE_API_BASE_URL);

  if (mode === "acceptance") {
    assertAcceptanceApiRouting(mode, apiBaseUrl, "http://127.0.0.1:5174");
  }

  return {
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
  };
});
