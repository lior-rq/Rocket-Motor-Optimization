import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Builds straight into app/static, which FastAPI serves and PyInstaller
// bundles. Fixed file names: the server already sends Cache-Control:
// no-store, so hashes would only churn the committed build.
export default defineConfig({
  plugins: [react(), tailwindcss(), noDuplicateModules()],
  resolve: {
    // `@/` MUST be a Vite alias, not tsconfig `paths` alone. Left to
    // rolldown's fallback resolver, Windows spelled the same file two ways
    // (`@/store/app` vs `./store/app`) and shipped two stores.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)).replace(/\\/g, "/") },
  },
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

/** Fails the build if one file was bundled under two spellings of its path. */
function noDuplicateModules(): Plugin {
  return {
    name: "no-duplicate-modules",
    generateBundle(_, bundle) {
      const seen = new Map<string, string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of Object.keys(chunk.modules)) {
          if (id.startsWith("\0")) continue;
          const key = id.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").toLowerCase();
          const other = seen.get(key);
          if (other && other !== id) this.error(`${id} is bundled twice, also as ${other}`);
          seen.set(key, id);
        }
      }
    },
  };
}
