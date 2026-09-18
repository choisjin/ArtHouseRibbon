import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// 개발 중에는 vite dev 서버(5173)가 화면을 주고, WS 는 리본 서버(8765)로 프록시한다.
export default defineConfig({
  resolve: {
    // MediaPipe 패키지가 wasm 파일을 exports 로 열어 두지 않아서 폴더를 직접 가리킨다 (tv/webcam.ts)
    alias: { "mediapipe-wasm": fileURLToPath(new URL("./node_modules/@mediapipe/tasks-vision/wasm", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:8765", ws: true },
      "/api": { target: "http://localhost:8765" },
    },
  },
  build: { target: "es2022", chunkSizeWarningLimit: 900 },  // three.js 가 한 덩어리로 700KB 쯤
});
