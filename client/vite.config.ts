import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const host = process.env.HOST ?? "127.0.0.1";
const clientPort = Number(process.env.CLIENT_PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? 3001);

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    host,
    port: clientPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
