import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const base = process.env.PAGES_BASE_PATH ?? "/PWA-POS-System/";
if (!/^\/(?:[A-Za-z0-9_.-]+\/)*$/.test(base))
  throw new Error("Invalid Pages base path");
const revision = process.env.RELEASE_REVISION ?? "local";
const rows = readFileSync("specs/demo-products.csv", "utf8")
  .trim()
  .split(/\r?\n/);
const products = rows.slice(1).map((row) => {
  const [, sku, name, category, price, , units, tax, currency, synthetic] =
    row.split(",");
  if (
    !sku ||
    !name ||
    !category ||
    !/^\d+$/.test(price) ||
    !/^\d+$/.test(units) ||
    tax !== "0" ||
    currency !== "SGD" ||
    synthetic !== "true"
  )
    throw new Error("Pages requires the reviewed synthetic fixture");
  return { sku, name, category, price: Number(price), units: Number(units) };
});
if (
  products.length !== 12 ||
  new Set(products.map((p) => p.sku)).size !== products.length
)
  throw new Error("Invalid synthetic product identities");
const publicRoot = resolve("apps/web/public");
const files = [
  "icon-192.png",
  "icon-512.png",
  ...readdirSync(resolve(publicRoot, "products")).map(
    (name) => "products/" + name,
  ),
];
export default defineConfig({
  root: resolve("apps/pages"),
  base,
  publicDir: false,
  define: { __DEMO_PRODUCTS__: JSON.stringify(products) },
  plugins: [
    react(),
    {
      name: "counter-static-demo",
      generateBundle(_, bundle) {
        for (const name of files)
          this.emitFile({
            type: "asset",
            fileName: name,
            source: readFileSync(resolve(publicRoot, name)),
          });
        this.emitFile({
          type: "asset",
          fileName: "manifest.webmanifest",
          source: JSON.stringify({
            id: "./",
            name: "Counter POS Static Demo",
            short_name: "Counter Demo",
            description:
              "Browser-only synthetic POS simulation. No real payments.",
            start_url: "./",
            scope: "./",
            display: "standalone",
            theme_color: "#152D35",
            background_color: "#F3F6F5",
            icons: [
              { src: "icon-192.png", sizes: "192x192", type: "image/png" },
              { src: "icon-512.png", sizes: "512x512", type: "image/png" },
            ],
          }),
        });
        this.emitFile({
          type: "asset",
          fileName: "release.json",
          source: JSON.stringify({ revision, mode: "static-demo", base }),
        });
        this.emitFile({ type: "asset", fileName: ".nojekyll", source: "" });
        const assets = [
          ...new Set([
            base,
            base + "manifest.webmanifest",
            ...Object.keys(bundle).map((name) => base + name),
            ...files.map((name) => base + name),
          ]),
        ];
        const prefix =
          "counter-static-" +
          createHash("sha256").update(base).digest("hex").slice(0, 12) +
          "-";
        const version = createHash("sha256")
          .update(JSON.stringify(bundle) + revision)
          .digest("hex")
          .slice(0, 16);
        this.emitFile({
          type: "asset",
          fileName: "sw.js",
          source: [
            "const PREFIX=" +
              JSON.stringify(prefix) +
              ",CACHE=PREFIX+" +
              JSON.stringify(version) +
              ",ASSETS=" +
              JSON.stringify(assets) +
              ",BASE=" +
              JSON.stringify(base) +
              ";",
            "self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));",
            "self.addEventListener('activate',e=>e.waitUntil((async()=>{for(const k of await caches.keys())if(k.startsWith(PREFIX)&&k!==CACHE)await caches.delete(k);await self.clients.claim();})()));",
            "self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||!u.pathname.startsWith(BASE))return;if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).then(r=>r.ok?r:caches.open(CACHE).then(c=>c.match(BASE))).catch(()=>caches.open(CACHE).then(c=>c.match(BASE))));return;}if(ASSETS.includes(u.pathname))e.respondWith(caches.open(CACHE).then(async c=>(await c.match(u.pathname))||fetch(e.request)));});",
          ].join("\n"),
        });
      },
    },
  ],
  build: { outDir: resolve("dist/pages-demo"), emptyOutDir: true },
});
