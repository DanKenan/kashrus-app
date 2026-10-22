// 10M part 1: add a new agency to an account the person already has.
// This is a PUBLIC credential check (the sign-up page): it never sends the stored
// session token and never goes through apiFetch, so a wrong password (401) shows
// the server's words and can't sign out a session that is already on this device.
export interface RegisterExistingBody {
  agencyName: string;
  shortCode?: string;
  region?: string;
  contactPhone?: string;
  initialVenueName: string;
  initialVenueCategory: string;
  email: string;
  password: string;
  operationId: string;
}

export interface RegisterExistingResult {
  ok: boolean;
  status: number;
  data: any;
}

export async function registerIntoExistingAccount(body: RegisterExistingBody): Promise<RegisterExistingResult> {
  const res = await fetch('/api/agencies/register-existing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data: data || {} };
}
