import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        // Recharts + d3 — важкі й потрібні лише на графіках; окремий чанк, щоб не
        // роздувати головний бандл і кешувати незалежно (техборг: бандл ~800КБ).
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/](recharts|d3-|victory-|internmap)/.test(id)) return "charts";
          // react + redux + router разом — вони взаємозалежні, окремі чанки дають цикл.
          if (/[\\/](react|react-dom|react-router|scheduler|@remix-run|@reduxjs|react-redux|redux|immer|reselect)[\\/]/.test(id)) return "react-vendor";
        },
      },
    },
  },
  plugins: [
    react(),
    cloudflare(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Money Track",
        short_name: "Money",
        description: "Персональний фінансовий трекер",
        theme_color: "#16211D",
        background_color: "#EEF1EF",
        display: "standalone",
        orientation: "portrait",
        icons: [
          { src: "favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
      workbox: {
        // API is never cached; only the app shell + static assets.
        navigateFallbackDenylist: [/^\/api/, /^\/webhook/, /^\/ingest/],
      },
    }),
  ],
});
