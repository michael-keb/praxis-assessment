import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

// Routes whose last segment is an order id or a magic-link token. The export
// ships one shell page per route (under `_/`); the browser reads the real id
// from the URL, so any value maps to that shell.
const dynamicRoutes = ['/orders/', '/s/order/', '/r/schedule/', '/r/message/', '/m/order/'];

// This router serves only the standalone Send a Sweet export. It never touches
// assessment sessions or falls through to the assessment SPA for unknown URLs.
export function createSendASweetRouter(directory) {
  const root = path.resolve(directory);
  const router = express.Router();
  const exists = new Map();
  const pageExists = (rel) => {
    if (!exists.has(rel)) exists.set(rel, fs.existsSync(path.join(root, `${rel}.html`)));
    return exists.get(rel);
  };
  const resolvePage = (pathname) => {
    const exact = pathname === '/' ? 'index' : `${pathname.slice(1)}/index`;
    if (pageExists(exact)) return exact;
    for (const prefix of dynamicRoutes) {
      if (!pathname.startsWith(prefix)) continue;
      const rest = pathname.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      const shell = `${prefix.slice(1)}_/index`;
      if (pageExists(shell)) return shell;
    }
    return null;
  };
  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const pathname = req.path.replace(/\/+$/, '') || '/';
    const page = resolvePage(pathname);
    if (!page) return next();
    const isRsc = req.get('RSC') === '1' || Object.hasOwn(req.query, '_rsc');
    res.vary('RSC');
    res.set('Cache-Control', 'no-store');
    res.type(isRsc ? 'text/x-component' : 'html');
    res.sendFile(path.join(root, `${page}.${isRsc ? 'rsc' : 'html'}`));
  });
  router.use(express.static(root, { index: false, redirect: false }));
  // Catch-all for anything unmatched above: an unknown URL, or a dynamic route
  // (e.g. /r/schedule/) whose tail was empty or had extra segments and so was
  // rejected by resolvePage. Real page/asset misses among these are common —
  // links in texts get truncated routinely — so browser navigations get the
  // branded page instead of a bare server string. Asset requests (a path
  // whose last segment has a file extension, e.g. .js/.css/.png/.svg/.json)
  // and RSC navigation fetches keep the old plain-text 404: we don't ship a
  // styled asset 404, and the client's RSC fetch expects a component payload,
  // not HTML.
  router.use((req, res) => {
    const isAsset = /\.[^/]+$/.test(req.path);
    const isRsc = req.get('RSC') === '1' || Object.hasOwn(req.query, '_rsc');
    const wantsHtml =
      (req.method === 'GET' || req.method === 'HEAD') && !isAsset && !isRsc && req.accepts('html');
    if (wantsHtml && pageExists('missing/index')) {
      res.status(404);
      res.set('Cache-Control', 'no-store');
      res.type('html');
      return res.sendFile(path.join(root, 'missing/index.html'));
    }
    res.status(404).type('text').send('Send a Sweet page not found.');
  });
  return router;
}
