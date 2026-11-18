import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createOAuth } from '../../src/server/sources/oauth.ts';
import { decryptKey } from '../../src/server/sources/crypto.ts';
let calls = 0, verifier;
const mock = createServer(async (req, res) => { calls++; res.setHeader('Content-Type', 'application/json'); let body = ''; for await (const c of req)
    body += c; if (req.url === '/oauth/token') {
    verifier = new URLSearchParams(body).get('code_verifier');
    res.end(JSON.stringify({ access_token: 'fake-access-sentinel', refresh_token: 'fake-refresh-sentinel', expires_in: 3600 }));
}
else
    res.end(JSON.stringify({ email: 'demo@example.test' })); });
await new Promise(r => mock.listen(0, '127.0.0.1', r));
try {
    let now = 1000000;
    const env = {}, oauth = createOAuth({ secret: () => 'demo secret', apiBase: () => `http://127.0.0.1:${mock.address().port}`, now: () => now, env });
    assert.throws(() => oauth.start('a', 'u', 'google_sheets', 'read'), /Not set up/);
    await assert.rejects(() => oauth.token('a', 'excel', undefined), /Not set up/);
    assert.equal(calls, 0);
    Object.assign(env, { GOOGLE_OAUTH_CLIENT_ID: 'fake-id', GOOGLE_OAUTH_CLIENT_SECRET: 'fake-secret', MICROSOFT_OAUTH_CLIENT_ID: 'fake-id', MICROSOFT_OAUTH_CLIENT_SECRET: 'fake-secret' });
    const start = () => new URL(oauth.start('a', 'u', 'google_sheets', 'readwrite'));
    let url = start();
    assert.equal(Buffer.from(url.searchParams.get('state'), 'base64url').length, 32);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    const result = await oauth.callback('google_sheets', url.searchParams.get('state'), 'fake-code');
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), url.searchParams.get('code_challenge'));
    assert.equal(result.agencyId, 'a');
    assert.equal(result.userId, 'u');
    assert.equal(decryptKey(result.record.refreshToken, 'demo secret', 'a'), 'fake-refresh-sentinel');
    assert.equal(oauth.email('a', result.record), 'demo@example.test');
    assert.notEqual(result.record.accountEmail, 'demo@example.test');
    const at = calls;
    await assert.rejects(() => oauth.callback('google_sheets', url.searchParams.get('state'), 'again'));
    assert.equal(calls, at);
    url = start();
    await assert.rejects(() => oauth.callback('excel', url.searchParams.get('state'), 'bad'));
    await assert.rejects(() => oauth.callback('google_sheets', url.searchParams.get('state'), 'again'));
    assert.equal(calls, at);
    url = start();
    now += 600001;
    await assert.rejects(() => oauth.callback('google_sheets', url.searchParams.get('state'), 'expired'));
    await assert.rejects(() => oauth.callback('google_sheets', '', 'missing'));
    assert.equal(calls, at);
    const ms = new URL(oauth.start('a', 'u', 'excel', 'read'));
    assert.match(ms.searchParams.get('scope'), /Files.Read.All/);
    assert.doesNotMatch(ms.searchParams.get('scope'), /Files.ReadWrite/);
    console.log('OAuth one-time state, expiry, provider binding, PKCE and zero-call setup guard passed');
}
finally {
    await new Promise(r => mock.close(r));
}
