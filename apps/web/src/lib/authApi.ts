import type { User } from "@t3tools/contracts";

function resolveApiBase(): string {
  if (typeof window === "undefined") return "";
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (envWsUrl && envWsUrl.length > 0) {
    try {
      const wsUrl = new URL(envWsUrl);
      const protocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
      return `${protocol}//${wsUrl.host}`;
    } catch {
      // fall through
    }
  }
  return window.location.origin;
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const base = resolveApiBase();
  const res = await fetch(`${base}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? body.message ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export const authApi = {
  setupRequired: () => fetchJson<{ required: boolean }>("/api/auth/setup-required"),

  setup: (input: { username: string; displayName: string; password: string }) =>
    fetchJson<{ user: User }>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  login: (input: { username: string; password: string }) =>
    fetchJson<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  logout: () => fetchJson<Record<string, never>>("/api/auth/logout", { method: "POST" }),

  me: () => fetchJson<{ user: User }>("/api/auth/me"),

  listUsers: () => fetchJson<{ users: User[] }>("/api/auth/users"),

  createUser: (input: { username: string; displayName: string; password: string; role?: string }) =>
    fetchJson<{ user: User }>("/api/auth/users", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  deleteUser: (userId: string) =>
    fetchJson<Record<string, never>>(`/api/auth/users/${userId}`, {
      method: "DELETE",
    }),
};
