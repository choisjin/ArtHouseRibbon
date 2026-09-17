import { defineConfig } from "vite";

// 개발 중에는 vite dev 서버(5173)가 화면을 주고, WS 는 리본 서버(8765)로 프록시한다.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:8765", ws: true },
      "/api": { target: "http://localhost:8765" },
    },
  },
  build: { target: "es2022", chunkSizeWarningLimit: 900 },  // three.js 가 한 덩어리로 700KB 쯤
});
