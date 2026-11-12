// Keep provider errors and credentials out of responses and logs.
export async function sourceFetch(url: string, init: RequestInit = {}, fetchImpl = fetch, timeoutMs = 15000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
        // Buffer inside the deadline: a server may stall after sending headers.
        const bytes = await response.arrayBuffer();
        return new Response(response.status === 204 || response.status === 304 ? null : bytes, { status: response.status, headers: response.headers });
    }
    catch {
        throw Error('Source request failed');
    }
    finally {
        clearTimeout(timer);
    }
}
export async function sourceJson(url: string, init: RequestInit = {}, fetchImpl = fetch): Promise<any> {
    const response = await sourceFetch(url, init, fetchImpl);
    if (!response.ok)
        throw Object.assign(Error('Source request failed'), { status: response.status });
    if (response.status === 204)
        return {};
    try {
        return await response.json();
    }
    catch {
        throw Error('Source returned invalid JSON');
    }
}
