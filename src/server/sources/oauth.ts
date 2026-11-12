import { randomBytes, createHash } from 'node:crypto';
import { sourceJson } from './http.ts';
import { encryptKey, decryptKey } from './crypto.ts';
export type OAuthProvider = 'google_sheets' | 'excel';
export type OAuthRecord = {
    refreshToken: string;
    accountEmail: string;
    access: 'read' | 'readwrite';
};
export const isOAuthProvider = (p: string): p is OAuthProvider => p === 'google_sheets' || p === 'excel';
export function oauthNotSetUp() { return Object.assign(Error('Not set up yet'), { status: 409, notSetUp: true }); }
export function createOAuth(deps: {
    secret(): string;
    apiBase(p: OAuthProvider): string | undefined;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
}) {
    const now = deps.now || Date.now, env = deps.env || process.env;
    const states = new Map<string, {
        agencyId: string;
        userId: string;
        provider: OAuthProvider;
        access: 'read' | 'readwrite';
        verifier: string;
        expires: number;
        generation: number;
    }>();
    const generations = new Map<string, number>();
    const tokens = new Map<string, {
        accessToken: string;
        expiresAt: number;
    }>(), flights = new Map<string, Promise<any>>();
    const key = (a: string, p: OAuthProvider) => `${a}:${p}`;
    function config(p: OAuthProvider) { const prefix = p === 'excel' ? 'MICROSOFT' : 'GOOGLE'; return { id: env[`${prefix}_OAUTH_CLIENT_ID`], secret: env[`${prefix}_OAUTH_CLIENT_SECRET`] }; }
    const setUp = (p: OAuthProvider) => !!(config(p).id && config(p).secret);
    const requireSetUp = (p: OAuthProvider) => { if (!setUp(p))
        throw oauthNotSetUp(); };
    const endpoint = (p: OAuthProvider, type: 'authorize' | 'token') => deps.apiBase(p) ? `${deps.apiBase(p)}/oauth/${type}` : p === 'excel' ? `https://login.microsoftonline.com/common/oauth2/v2.0/${type}` : type === 'authorize' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://oauth2.googleapis.com/token';
    const redirect = (p: OAuthProvider) => `${(env.OAUTH_REDIRECT_BASE || 'http://localhost:3000').replace(/\/$/, '')}/api/sources/oauth/${p}/callback`;
    function start(agencyId: string, userId: string, provider: OAuthProvider, access: 'read' | 'readwrite') {
        requireSetUp(provider);
        for (const [s, v] of states)
            if (v.expires <= now())
                states.delete(s);
        const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
        states.set(state, { agencyId, userId, provider, access, verifier, expires: now() + 600000, generation: generations.get(agencyId) || 0 });
        const url = new URL(endpoint(provider, 'authorize'));
        const scope = provider === 'google_sheets' ? 'https://www.googleapis.com/auth/drive.file openid email' : `offline_access User.Read ${access === 'readwrite' ? 'Files.ReadWrite.All' : 'Files.Read.All'}`;
        const params = { client_id: config(provider).id!, redirect_uri: redirect(provider), response_type: 'code', scope, state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), ...(provider === 'google_sheets' ? { access_type: 'offline', prompt: 'consent' } : {}) };
        url.search = new URLSearchParams(params).toString();
        return url.toString();
    }
    async function exchange(p: OAuthProvider, body: Record<string, string>) {
        requireSetUp(p);
        return sourceJson(endpoint(p, 'token'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...body, client_id: config(p).id!, client_secret: config(p).secret! }).toString() });
    }
    function remember(a: string, p: OAuthProvider, response: any) {
        if (typeof response.access_token !== 'string')
            throw Error('Invalid OAuth response');
        const token = { accessToken: response.access_token, expiresAt: now() + Math.max(1, Number(response.expires_in) || 3600) * 1000 };
        tokens.set(key(a, p), token);
        return token;
    }
    async function callback(provider: OAuthProvider, state: string, code: string) {
        const s = states.get(state);
        states.delete(state);
        if (!s || s.provider !== provider || s.expires <= now() || !code)
            throw Error('Invalid sign-in state');
        requireSetUp(provider);
        const response = await exchange(provider, { grant_type: 'authorization_code', code, redirect_uri: redirect(provider), code_verifier: s.verifier });
        if (typeof response.refresh_token !== 'string')
            throw Error('Missing refresh token');
        if (typeof response.access_token !== 'string')
            throw Error('Invalid OAuth response');
        const token = { accessToken: response.access_token as string, expiresAt: now() + Math.max(1, Number(response.expires_in) || 3600) * 1000 };
        const profile = await sourceJson(deps.apiBase(provider) ? `${deps.apiBase(provider)}/oauth/userinfo` : provider === 'excel' ? 'https://graph.microsoft.com/v1.0/me' : 'https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.accessToken}` } });
        const email = profile.email || profile.mail || profile.userPrincipalName;
        if (typeof email !== 'string' || email.length > 320)
            throw Error('Invalid account');
        if ((generations.get(s.agencyId) || 0) !== s.generation)
            throw Error('Sign-in cancelled');
        return { ...s, credential: token, record: { refreshToken: encryptKey(response.refresh_token, deps.secret(), s.agencyId), accountEmail: encryptKey(email, deps.secret(), s.agencyId), access: s.access } as OAuthRecord };
    }
    async function token(agencyId: string, provider: OAuthProvider, record: OAuthRecord | undefined, force = false): Promise<{
        accessToken: string;
        expiresAt: number;
    }> {
        requireSetUp(provider);
        if (!record)
            throw Object.assign(Error('Sign in required'), { status: 409 });
        const id = key(agencyId, provider), known = tokens.get(id);
        if (!force && known && known.expiresAt > now() + 30000)
            return known;
        if (flights.has(id))
            return flights.get(id)!;
        const job = exchange(provider, { grant_type: 'refresh_token', refresh_token: decryptKey(record.refreshToken, deps.secret(), agencyId) }).then(r => remember(agencyId, provider, r)).finally(() => flights.delete(id));
        flights.set(id, job);
        return job;
    }
    return { start, callback, token, setUp, requireSetUp, valid: (a: string, generation: number) => (generations.get(a) || 0) === generation, accept(result: Awaited<ReturnType<typeof callback>>) { tokens.set(key(result.agencyId, result.provider), result.credential); }, clear(a: string) { generations.set(a, (generations.get(a) || 0) + 1); for (const p of ['google_sheets', 'excel'] as const)
            tokens.delete(key(a, p)); for (const [k, s] of states)
            if (s.agencyId === a)
                states.delete(k); }, email: (a: string, r?: OAuthRecord) => r ? decryptKey(r.accountEmail, deps.secret(), a) : undefined };
}
