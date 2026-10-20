/**
 * Static files: two builds with EQUAL file sizes must still update.
 *
 * Proves: Cloud Run dates every file 1980-01-01, and a size+date file tag
 * cannot tell two builds apart. With mountStaticFiles, after a deploy where
 * sw.js and index.html keep their exact sizes, a phone that still holds the
 * old copy and asks "changed?" (If-None-Match / If-Modified-Since) gets the
 * NEW file (200), never 304. sw.js, index.html, the manifest and the SPA
 * fallback carry no ETag / Last-Modified and say no-cache; hashed /assets are
 * immutable for a year; an old build's /assets file is a 404, not index.html
 * (HTML as JavaScript = white screen). A control run shows Express's default
 * static serving answers 304 in the same situation (the Oct 20 bug).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const OLD_DATE = new Date('1980-01-01T00:00:01Z');

function writeBuild(dir, { jsName, marker, rev }) {
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  // index.html and sw.js: same length in both builds, different bytes
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><meta name="build" content="${marker}"><script type="module" src="/assets/${jsName}"></script><div id="root"></div>`);
  fs.writeFileSync(path.join(dir, 'sw.js'), `self.__WB_MANIFEST=[{"revision":"${rev}","url":"index.html"}];`);
  fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), `{"name":"Shutfey","b":"${marker}"}`);
  fs.writeFileSync(path.join(dir, 'assets', jsName), `console.log("${marker}");`);
  for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'assets/' + jsName, 'assets', '.']) {
    fs.utimesSync(path.join(dir, f), OLD_DATE, OLD_DATE);
  }
}

function request(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

async function serve(mount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-cache-'));
  writeBuild(path.join(root, 'A'), { jsName: 'index-AAAAAAAA.js', marker: 'build-A', rev: '0123456789abcdef0123456789abcdef' });
  writeBuild(path.join(root, 'B'), { jsName: 'index-BBBBBBBB.js', marker: 'build-B', rev: 'fedcba9876543210fedcba9876543210' });
  for (const f of ['index.html', 'sw.js']) {
    assert(fs.statSync(path.join(root, 'A', f)).size === fs.statSync(path.join(root, 'B', f)).size, `test setup: ${f} sizes differ`);
  }
  const live = path.join(root, 'dist');
  fs.symlinkSync(path.join(root, 'A'), live);
  const app = express();
  mount(app, live);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  const deployB = () => { fs.unlinkSync(live); fs.symlinkSync(path.join(root, 'B'), live); };
  const close = () => { server.close(); fs.rmSync(root, { recursive: true, force: true }); };
  return { port, deployB, close };
}

// Ask with the validators the old copy came with (what a phone sends).
async function staleAsk(port, p, before) {
  const h = {};
  if (before.headers.etag) h['If-None-Match'] = before.headers.etag;
  if (before.headers['last-modified']) h['If-Modified-Since'] = before.headers['last-modified'];
  // Even with no validators, send the 1980-style ones a phone may still hold from the old server.
  if (!h['If-None-Match']) h['If-None-Match'] = 'W/"0-49773873e8"';
  if (!h['If-Modified-Since']) h['If-Modified-Since'] = OLD_DATE.toUTCString();
  return request(port, p, h);
}

export default {
  name: 'static files: equal-size builds still update (no stale 304, /assets 404)',
  whatItProves: 'after a deploy with identical file sizes and 1980 dates, sw.js, index.html, the manifest and deep links come back fresh (200, no ETag/Last-Modified, no-cache); hashed /assets are immutable; an old build\'s asset is a 404, not HTML; control: Express default answers 304',
  async run() {
    const { mountStaticFiles } = await import('../../src/server/static-files.ts');

    // Control: the old setup (express.static defaults) gives 304 = the bug.
    {
      const c = await serve((app, dist) => {
        app.use((req, res, next) => express.static(fs.realpathSync(dist))(req, res, next));
        app.get('*', (req, res) => res.sendFile(path.join(fs.realpathSync(dist), 'index.html')));
      });
      try {
        const before = await request(c.port, '/sw.js');
        c.deployB();
        const after = await staleAsk(c.port, '/sw.js', before);
        assert(after.status === 304, `control: expected the old setup to answer 304, got ${after.status}`);
        const missing = await request(c.port, '/assets/index-AAAAAAAA.js');
        assert(missing.status === 200 && /<!doctype html>/i.test(missing.body), 'control: expected the old setup to answer an old asset with index.html');
      } finally { c.close(); }
    }

    const s = await serve(mountStaticFiles);
    try {
      const before = {};
      for (const p of ['/sw.js', '/', '/index.html', '/manifest.webmanifest', '/venues/abc']) before[p] = await request(s.port, p);
      for (const p of Object.keys(before)) {
        const h = before[p].headers;
        assert(!h.etag, `${p}: has an ETag (${h.etag})`);
        assert(!h['last-modified'], `${p}: has Last-Modified (${h['last-modified']})`);
        assert(/no-cache/.test(h['cache-control'] || ''), `${p}: Cache-Control is "${h['cache-control']}", expected no-cache`);
      }
      const a = await request(s.port, '/assets/index-AAAAAAAA.js');
      assert(a.status === 200 && /immutable/.test(a.headers['cache-control']) && /max-age=31536000/.test(a.headers['cache-control']), `/assets: Cache-Control "${a.headers['cache-control']}"`);

      s.deployB();
      const sw = await staleAsk(s.port, '/sw.js', before['/sw.js']);
      assert(sw.status === 200 && sw.body.includes('fedcba98'), `sw.js after deploy: status ${sw.status}, new bytes ${sw.body.includes('fedcba98')}`);
      for (const p of ['/', '/index.html', '/venues/abc']) {
        const r = await staleAsk(s.port, p, before[p]);
        assert(r.status === 200 && r.body.includes('build-B'), `${p} after deploy: status ${r.status}, new build ${r.body.includes('build-B')}`);
      }
      const m = await staleAsk(s.port, '/manifest.webmanifest', before['/manifest.webmanifest']);
      assert(m.status === 200 && m.body.includes('build-B'), `manifest after deploy: status ${m.status}`);

      const old = await request(s.port, '/assets/index-AAAAAAAA.js');
      assert(old.status === 404, `old asset: status ${old.status}, expected 404`);
      assert(!/<html|<!doctype/i.test(old.body), 'old asset: body is HTML');
      assert(!/javascript|html/.test(old.headers['content-type'] || ''), `old asset: content-type ${old.headers['content-type']}`);
      const nb = await request(s.port, '/assets/index-BBBBBBBB.js');
      assert(nb.status === 200 && nb.body.includes('build-B'), 'new asset not served');
    } finally { s.close(); }
  },
};
