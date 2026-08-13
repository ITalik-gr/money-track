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
        // Share INTO the app: a photo of a receipt, or text ("кава 85") for the AI parse box.
        //
        // ⚠️ POST + multipart is the ONLY form that can accept files, and such a share is
        // delivered to the service worker's fetch handler rather than to the server — which is
        // why `src/sw.ts` is hand-written (§PUSH, 2026-08-08). The SW parks the file and
        // redirects to `/add?shared=receipt`, where the page picks it up.
        //
        // Text is listed alongside `files` in the same target: a share sheet offers ONE entry per
        // app, and having "Money Track" appear only for images would make sharing a text snippet
        // silently impossible.
        share_target: {
          action: "/share-receipt",
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            title: "title",
            text: "text",
            url: "url",
            // ONE share target per app, so both kinds of file arrive at the same action and the
            // service worker decides which field it got. A second `share_target` entry is not a
            // thing the manifest supports — the second one is simply ignored.
            files: [
              { name: "photo", accept: ["image/*"] },
              // Android matches by MIME and often reports a CSV as text/plain or as an Excel type
              // depending on which app exported it, so the accept list is deliberately wide. The
              // parser rejects anything it cannot read, and the preview shows what it understood
              // before a single row is written.
              {
                name: "statement",
                accept: [".csv", "text/csv", "text/comma-separated-values", "text/plain",
                  "application/csv", "application/vnd.ms-excel"],
              },
            ],
          },
        },
      },
      // `injectManifest`, not `generateSW` (2026-08-08). A generated worker cannot carry a `push`
      // handler or a POST share target, and both were deferred for exactly that reason. The
      // trade is that the SW is now ours to get right — see the warning at the top of `src/sw.ts`
      // about the navigation fallback that must never come back.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        // Precache the shell and the build's assets — nothing else. Everything dynamic goes to
        // the network, which is where the Worker decides what a URL means.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
      },
    }),
  ],
});
