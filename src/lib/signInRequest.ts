export const SIGN_IN_TIMEOUT_TEXT = 'Signing in is taking too long. Check your connection and try again.';

/** Bound the whole sign-in response, including its body, and cancel network work. */
export async function withSignInTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 25000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      request(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(SIGN_IN_TIMEOUT_TEXT));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export function signInRequest(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
  timeoutMs = 25000,
): Promise<{ res: Response; data: any }> {
  return withSignInTimeout(async (signal) => {
    const res = await fetcher(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
    const data = await res.clone().json();
    return { res, data };
  }, timeoutMs);
}
