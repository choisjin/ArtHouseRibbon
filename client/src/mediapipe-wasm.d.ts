// vite.config.ts 의 별칭: MediaPipe wasm 폴더 (tv/webcam.ts 가 ?url 로 가져온다)
declare module "mediapipe-wasm/*?url" { const url: string; export default url; }
