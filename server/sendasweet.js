import express from 'express';
import path from 'node:path';

const makerSlugs = ['cocoa-and-crumb', 'butter-and-fold', 'sunday-sweet'];

// This router serves only the standalone Send a Sweet export. It never touches
// assessment sessions or falls through to the assessment SPA for unknown URLs.
export function createSendASweetRouter(directory) {
  const root = path.resolve(directory);
  const router = express.Router();
  const pages = new Map([
    ['/', 'index'],
    ...makerSlugs.map(slug => [`/makers/${slug}`, `makers/${slug}/index`]),
  ]);
  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const pathname = req.path.replace(/\/+$/, '') || '/';
    const page = pages.get(pathname);
    if (!page) return next();
    const isRsc = req.get('RSC') === '1' || Object.hasOwn(req.query, '_rsc');
    res.vary('RSC');
    res.set('Cache-Control', 'no-store');
    res.type(isRsc ? 'text/x-component' : 'html');
    res.sendFile(path.join(root, `${page}.${isRsc ? 'rsc' : 'html'}`));
  });
  router.use(express.static(root, { index: false, redirect: false }));
  router.use((_req, res) => res.status(404).type('text').send('Send a Sweet page not found.'));
  return router;
}
