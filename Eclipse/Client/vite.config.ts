import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "src/renderer/index.html"),
        console: path.resolve(__dirname, "src/renderer/console.html"),
      },
    },
  },
});
