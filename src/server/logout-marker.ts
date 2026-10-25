/** Only a single, well-formed logout request id can name a marker cookie. */
export function logoutMarkerClearHeader(id: unknown, secure: boolean): string | null {
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return null;
  return `shutfey_lo_${id}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict${secure ? '; Secure' : ''}`;
}
