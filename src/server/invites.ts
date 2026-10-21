/**
 * Item 10 (plan v4 D1): who may link / hold recovery codes. ONE helper:
 * acceptance (10i c), recovery-code issuance at first multi (C5, 10i) and
 * POST /api/auth/recovery-codes (10f) all call it.
 *
 * 'self-registered' and 'invite-new' are evidence of CREDENTIAL CONTROL (the
 * person chose the password with no admin knowing it), not of email
 * ownership (D3). 'admin', 'agency-reset', absent (legacy) and anything else
 * are never linkable and can never obtain or replace recovery codes.
 */
export function credentialMayLink(origin: unknown): boolean {
  return origin === 'self-registered' || origin === 'invite-new';
}
