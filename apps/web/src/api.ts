let csrf = "";
export function setCsrf(token: string) {
  csrf = token;
}
export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public retryAfter = 0,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/v1" + path, {
      method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new ApiError(
      "SERVICE_UNAVAILABLE",
      0,
      "Server unavailable. Your saved documents remain on this device.",
    );
  }
  if (!response.ok) {
    const p = await response.json().catch(() => ({
      code: "SERVICE_UNAVAILABLE",
      message: "Service unavailable",
    }));
    throw new ApiError(
      p.code,
      response.status,
      p.message,
      Number(response.headers.get("Retry-After") ?? 0),
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export async function probe() {
  try {
    return (
      await fetch("/health/ready", {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      })
    ).ok;
  } catch {
    return false;
  }
}
