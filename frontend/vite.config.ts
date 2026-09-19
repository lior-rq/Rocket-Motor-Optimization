import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Builds straight into app/static, which FastAPI serves and PyInstaller
// bundles. Fixed file names: the server already sends Cache-Control:
// no-store, so hashes would only churn the committed build.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../app/static",
    emptyOutDir: true,
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
        // Plotly and three each in their own file, so an edit to the app
        // does not rewrite four megabytes of vendor code in the commit.
        manualChunks(id: string) {
          if (id.includes("plotly.js")) return "plotly";
          if (id.includes("node_modules/three/") || id.includes("@react-three")) return "three";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8420" },
  },
});
