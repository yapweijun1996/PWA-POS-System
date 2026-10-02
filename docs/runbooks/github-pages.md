# GitHub Pages static demonstration

The public demonstration is a separate browser-only build at https://yapweijun1996.github.io/PWA-POS-System/. Products come from the reviewed synthetic fixture. Cart, simulated cash receipts and sample stock are stored under the scoped counter-static-v1 localStorage key; this is isolated from the full application's IndexedDB database. It has no login, real payment, refund authorization or server synchronization. Do not enter customer information or use it as a shop ledger.

Reset demo explicitly resets only this simulation's data. It retains up to 100 sample receipts. Browser storage clearing, multiple tabs and edits to synthetic fixtures do not have the full application's transaction/recovery guarantees. A cached shell can load after the first successful online visit; install behavior and physical phone lifecycle still require device acceptance.

## Build and verify

Use Node 24 from the repository root:

    npm ci
    npm run build:pages
    npx playwright install chromium
    npm run test:pages
    npx vite preview --config apps/pages/vite.config.ts --host 127.0.0.1 --port 3002 --strictPort

Open http://127.0.0.1:3002/PWA-POS-System/. PAGES_BASE_PATH defaults to /PWA-POS-System/ and supports the root path or a validated repository prefix. HTML, product art, icons, manifest and service-worker scope all use that prefix. Cache names include the scope identity; another application on the same origin is not cleared. The standalone demo bundle excludes the full application entry point and makes no API calls.

The browser checks verify a 1400 basket, 2000 tender and 600 change; stock deduction; the same saved records after a real worker-served offline reload; absence of API requests; mobile search/payment validation, explicit reset and horizontal overflow. Results are docs/qa/pages-results.json. The production build output remains dist/web.

## Automatic deployment

Repository Pages is configured for GitHub Actions (build_type: workflow). The CI workflow runs on pushes, pull requests and manual dispatch. The validation job checks the complete production suite and the static demonstration. Only main can proceed to the Pages build/deployment jobs. A failed or cancelled validation cannot deploy.

configure-pages supplies the base path; RELEASE_REVISION is the workflow's exact Git SHA. upload-pages-artifact uploads only dist/pages-demo. The deployment job has Pages/OIDC permissions and uses the github-pages environment. No database URL, signing key, dump, source repository tree or production server is published.

After a successful deployment, request the site and release.json and require the latter's revision to match deployed main. GitHub caches may briefly serve the preceding release. A green build alone is not proof the public site is live; inspect the deployment result and actual page.

To update, commit changes, merge/push to main and let verification/deployment finish. Manual re-deployment can dispatch verify on main. For rollback, review a forward revert commit rather than force-pushing history; verification and deployment run again. Real production hosting continues to use the separate Docker/HTTPS deployment contract.

References: [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [Pages REST API](https://docs.github.com/en/rest/pages/pages).
