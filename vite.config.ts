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
      includeAssets: ["favicon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "Money Track",
        short_name: "Money",
        description: "Personal finance tracker with an AI advisor",
        // Tokens, not the pre-redesign dark-green palette these used to carry: the splash screen
        // is the first thing an installed PWA shows, and it was a different product's colours.
        // Light-first, so both match the light `--bg` the `<meta name="theme-color">` starts on.
        // (The meta tag is rewritten live by the theme toggle; the manifest value cannot be, and
        // a dark title bar over a light app is the wrong default.)
        theme_color: "#f3f5f8",
        background_color: "#f3f5f8",
        display: "standalone",
        orientation: "portrait",
        // PNGs are not optional. iOS ignores SVG icons in a manifest entirely, so an installed
        // app showed a blank tile; Android needs a separate `maskable` variant or the launcher
        // crops the mark. `any` and `maskable` must be DIFFERENT files — one image cannot satisfy
        // both (the maskable one has to waste 20% on the safe zone, which looks wrong unmasked).
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        // ⚠️ NO navigation fallback. The service worker precaches static assets and nothing else;
        // every navigation goes to the network, where the Worker decides (and falls back to the
        // SPA shell itself via `assets.not_found_handling`).
        //
        // Why not the denylist: with `navigateFallback: "index.html"` the SW answers navigations
        // from cache IN THE BROWSER, before the request reaches Cloudflare, and correctness then
        // depends on a hand-maintained list of every Worker route. `/auth` and `/demo` were
        // missing from it, which silently broke "Sign in with Google" and "Try the demo" — the
        // demo only worked right after a hard reload (which bypasses the SW) and broke again the
        // moment the SW took control. A list that must be updated in lockstep with the router,
        // in a layer curl cannot observe, is a trap; deleting the fallback deletes the class.
        //
        // Cost, stated plainly: no offline deep-linking. Acceptable — this app is useless
        // offline anyway (every screen reads live bank data through the Worker).
        navigateFallback: null,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
