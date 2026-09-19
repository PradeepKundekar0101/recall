export const API = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";

/**
 * A request the orchestrator answered, and refused.
 *
 * Carried as a type rather than a formatted string so a page can tell an
 * orchestrator that is down from one that is up and cannot serve this
 * particular thing - two failures with different fixes, which a single
 * "not reachable" would flatten into one.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The endpoint's own `error` string, where the body carried one. */
    readonly detail: string | null,
    path: string,
  ) {
    super(`${path}: ${status}${detail ? ` ${detail}` : ""}`);
    this.name = "ApiError";
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { cache: "no-store" });
  if (!response.ok) throw new ApiError(response.status, await detailOf(response), path);
  return (await response.json()) as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}

/** Every route answers a refusal with `{ error }`; anything in the way may not. */
async function detailOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: unknown }).error;
    return typeof error === "string" ? error : null;
  } catch {
    return null;
  }
}
