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
        // Long-press the installed icon (Android) / right-click the dock icon (desktop). The
        // three things worth reaching without going through the dashboard first — writing an
        // expense above all, since that is the one action with a time cost if it is awkward.
        shortcuts: [
          { name: "Add expense", short_name: "Add", url: "/add", icons: [{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
          { name: "Statistics", short_name: "Stats", url: "/stats", icons: [{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
          { name: "Ask the advisor", short_name: "Advisor", url: "/chat", icons: [{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
        ],
        // Share text INTO the app — it lands in the AI parse box on /add ("кава 85").
        //
        // ⚠️ GET on purpose. A share target that accepts FILES (a receipt photo — the obvious
        // next want) must be `method: "POST"`, and a POST share target is delivered to the
        // service worker's fetch handler, which means leaving `generateSW` for `injectManifest`
        // and hand-writing the SW. That is the same trade already deferred for Web-Push, and
        // this SW is deliberately minimal after `navigateFallback` broke /demo and /auth twice.
        // A GET target is a plain navigation and needs none of it.
        share_target: {
          action: "/add",
          method: "GET",
          params: { title: "title", text: "text", url: "url" },
        },
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
