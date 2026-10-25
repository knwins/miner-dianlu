import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 官方电路市价来自链上电路市场的活跃卖单。
 *
 * 官方站点**不发** access-control-allow-origin，浏览器直连会被 CORS 拦下，
 * 所以这里加一个同源代理 `/tt-api` → https://tapeout.net。
 * 前端只认相对路径 `/tt-api/market.json`，开发与预览服同一写法，不需要区分环境。
 */
const TTOUT_PROXY = {
  "/tt-api": {
    target: "https://tapeout.net",
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/tt-api/, ""),
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    /** 同时监听 IPv4/IPv6：只绑 127.0.0.1 时 localhost 解析到 ::1 会连不上 */
    host: true,
    port: 5173,
    strictPort: true,
    proxy: TTOUT_PROXY,
  },
  preview: {
    host: true,
    port: 4173,
    proxy: TTOUT_PROXY,
  },
});
