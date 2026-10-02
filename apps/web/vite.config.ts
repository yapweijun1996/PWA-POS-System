import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";
export default defineConfig({
  root: resolve("apps/web"),
  plugins: [
    react(),
    {
      name: "counter-offline-shell",
      generateBundle(_, bundle) {
        const assets = Object.keys(bundle).filter((k) => k !== "sw.js");
        const version = createHash("sha256")
          .update(JSON.stringify(bundle))
          .digest("hex")
          .slice(0, 16);
        this.emitFile({
          type: "asset",
          fileName: "sw.js",
          source: `const CACHE='counter-shell-${version}';
const ASSETS=${JSON.stringify(["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", ...readdirSync("apps/web/public/products").map((k) => "/products/" + k), ...assets.map((k) => "/" + k)])};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE')self.skipWaiting();});
self.addEventListener('activate',event=>event.waitUntil((async()=>{const keys=(await caches.keys()).filter(k=>k.startsWith('counter-shell-'));for(const key of keys.slice(0,-2))await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/health/'))return;
if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.open(CACHE).then(c=>c.match('/'))));return;}
if(ASSETS.includes(url.pathname))event.respondWith(caches.open(CACHE).then(async c=>(await c.match(url.pathname))||fetch(event.request)));
});`,
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
    },
  },
  build: { outDir: resolve("dist/web"), emptyOutDir: true },
  define: { __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? "local-v1") },
});
