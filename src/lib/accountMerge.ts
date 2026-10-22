// 10M part 2 client: merge two accounts into one (Don, Oct 22 2026).
// Two ways in, one outcome. A = the main account: its email and password stay.
// B = the other account: its agencies move to A and its login stops working.
//  - "merge-into" (signed in as B): type A's email + password, and B's own password.
//  - "bring-in"   (signed in as A): type B's email + password.
// The answer carries a fresh token for A; the app stores it and stays signed in.
//
// Plain fetch with the stored session, never apiFetch: after a merge every older
// session of A and B ends, so a 401 here can mean "it went through". The screen
// then says which email to sign in with instead of silently signing out.

export type MergeMode = 'merge-into' | 'bring-in';

export interface MergeInput {
  email: string;
  password: string;
  currentPassword?: string;
}

export interface MergeResult {
  ok: boolean;
  status: number; // 0 = no answer (network)
  data: any;
}

export const MERGE_ROUTE: Record<MergeMode, string> = {
  'merge-into': '/api/account/merge-into',
  'bring-in': '/api/account/bring-in',
};

export function normEmail(v: string): string {
  return String(v || '').trim().toLowerCase();
}

/** Which email stops working and which one to use from now on. */
export function mergeRoles(mode: MergeMode, signedInEmail: string, typedEmail: string): { stops: string; keeps: string } {
  const me = String(signedInEmail || '').trim();
  const typed = String(typedEmail || '').trim();
  return mode === 'merge-into' ? { stops: me, keeps: typed } : { stops: typed, keeps: me };
}

/** op-<base36 time>-<10 base36 chars>: matches the server's /^[A-Za-z0-9_-]{8,100}$/. */
export function newMergeOperationId(): string {
  let r = '';
  try {
    const a = new Uint8Array(10);
    crypto.getRandomValues(a);
    r = Array.from(a, (b) => (b % 36).toString(36)).join('');
  } catch {
    r = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  }
  return `op-${Date.now().toString(36)}-${r}`;
}

export function mergeBody(mode: MergeMode, input: MergeInput, operationId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    email: String(input.email || '').trim(),
    password: input.password, // typed passwords go exactly as typed
    confirm: true,
    operationId,
  };
  if (mode === 'merge-into') body.currentPassword = input.currentPassword || '';
  return body;
}

export async function mergeAccounts(mode: MergeMode, input: MergeInput, operationId: string, sessionToken: string | null): Promise<MergeResult> {
  try {
    const res = await fetch(MERGE_ROUTE[mode], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) },
      cache: 'no-store',
      body: JSON.stringify(mergeBody(mode, input, operationId)),
    });
    let data: any = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data: data || {} };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

/** A success answer the app can sign in with. */
export function isMergeSuccess(r: MergeResult): boolean {
  return r.ok && !!r.data && r.data.merged === true && typeof r.data.token === 'string' && !!r.data.token && !!r.data.user;
}

/** The answer did not arrive, or the session ended: the merge may have gone through. */
export function isMergeUnknown(r: MergeResult): boolean {
  return r.status === 0 || r.status === 401 || (r.ok && !isMergeSuccess(r));
}

/** Plain words for a refusal. Nothing was changed when the server refuses. */
export function mergeErrorText(mode: MergeMode, r: MergeResult): string {
  const code = r.data && typeof r.data.code === 'string' ? r.data.code : '';
  const server = r.data && typeof r.data.error === 'string' && r.data.error.trim() ? r.data.error.trim() : '';
  switch (code) {
    case 'MERGE_LOGIN_FAILED':
      return mode === 'merge-into'
        ? "The main account's email or password is incorrect."
        : "The other account's email or password is incorrect.";
    case 'MERGE_CURRENT_PASSWORD_WRONG':
      return 'Your password is incorrect.';
    case 'MERGE_SAME_ACCOUNT':
      return "That's the account you're signed in with.";
    case 'KIOSK_SCOPE':
      return "Accounts can't be merged on a kiosk.";
    case 'MERGE_INVALID':
      return 'Please fill in every field.';
    default:
      break;
  }
  if (server) return server;
  if (r.status === 429) return 'Too many tries. Please wait a few minutes and try again.';
  return "The accounts couldn't be merged. Nothing was changed. Please try again.";
}
