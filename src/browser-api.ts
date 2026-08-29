export class ApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<T>;
}

export async function responseError(response: Response) {
  const value = await response.json().catch(() => ({})) as { message?: string; error?: string };
  return new ApiError(value.message ?? "Something went wrong", value.error ?? "REQUEST_FAILED", response.status);
}
