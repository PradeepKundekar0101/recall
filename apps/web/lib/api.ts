export const API = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
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
