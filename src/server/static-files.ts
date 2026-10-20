import express from 'express';
import path from 'path';

/**
 * Serves the built app (dist/) with cache headers that let every deploy reach
 * phones.
 *
 * Why: Cloud Run gives every file the same date (1980-01-01), and Express's
 * default file tag (ETag) is only size + date. Two builds whose sw.js or
 * index.html happen to have the same size then look "not modified" (304), and
 * phones keep the old app for good: the Update button says "newest version",
 * and after clearing site data the stale index.html asks for JS that no
 * longer exists (white screen). Seen Oct 20 going from #39 to #40.
 *
 *  - /assets: the content hash is in each file name, so a new build means new
 *    names. Cached for a year (immutable). A name that isn't in this build is
 *    a plain 404, never index.html (HTML served as JavaScript = white screen).
 *  - Everything else (sw.js, index.html, manifest, icons) keeps its name in
 *    every build: no ETag, no Last-Modified, Cache-Control: no-cache, so the
 *    browser always gets the current file.
 */
export function mountStaticFiles(app: express.Express, distPath: string): void {
  const noStaleTags = { etag: false, lastModified: false };
  app.use(
    '/assets',
    express.static(path.join(distPath, 'assets'), { immutable: true, maxAge: '1y' })
  );
  app.use('/assets', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).type('text/plain').send('Not found');
  });
  app.use(
    express.static(distPath, {
      ...noStaleTags,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    })
  );
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distPath, 'index.html'), noStaleTags);
  });
}
