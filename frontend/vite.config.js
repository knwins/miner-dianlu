import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    /**
     * tapeout.net 的 JSON 接口不返回任何 CORS 头
     * （实测连 Access-Control-Allow-Origin 都没有），
     * 浏览器直连必然被拦，表现为 net::ERR_FAILED。
     *
     * dev server 代理一层，把跨域变成同源。
     * 正式部署时应改为服务端拉取后转发给前端，或自建数据源。
     */
    proxy: {
      "/tt-api": {
        target: "https://tapeout.net",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/tt-api/, ""),
      },
    },
  },
});
