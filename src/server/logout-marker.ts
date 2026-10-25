// Keep acknowledgments beyond the client's 600-second unknown-request window.
export const LOGOUT_ACK_MAX_AGE_S = 660;

/** Only a single, well-formed logout request id can name an acknowledgment cookie. */
export function logoutAckSetCookie(id: unknown, secure: boolean): string | null {
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return null;
  return `shutfey_lo_${id}=1; Path=/; Max-Age=${LOGOUT_ACK_MAX_AGE_S}; SameSite=Strict${secure ? '; Secure' : ''}`;
}
