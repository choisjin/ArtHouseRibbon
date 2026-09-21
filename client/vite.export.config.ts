import { defineConfig } from "vite";

/**
 * '내보내기' 로 주는 전시실 파일(.html) 안에 박아 넣을 자바스크립트 한 덩어리.
 * 서버(ribbon/gallery_export.py)가 이 결과를 읽어 그림·배경과 함께 HTML 한 장으로 묶는다.
 *
 *     npm run build          (client 전체 + 이 덩어리)
 *     npx vite build -c vite.export.config.ts
 */
export default defineConfig({
  build: {
    target: "es2020",
    outDir: "dist-export",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: { entry: "src/export/viewer.ts", formats: ["iife"], name: "RibbonGallery", fileName: () => "viewer.js" },
    chunkSizeWarningLimit: 1200,
  },
});
