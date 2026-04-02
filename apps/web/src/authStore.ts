import type { User } from "@t3tools/contracts";
import { create } from "zustand";
import { authApi } from "./lib/authApi";

export type AuthPhase = "loading" | "setup-required" | "login" | "authenticated";

interface AuthState {
  phase: AuthPhase;
  user: User | null;
  error: string | null;
  checkAuth: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  setup: (username: string, displayName: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  phase: "loading",
  user: null,
  error: null,

  checkAuth: async () => {
    try {
      const { required } = await authApi.setupRequired();
      if (required) {
        set({ phase: "setup-required", user: null });
        return;
      }

      const { user } = await authApi.me();
      set({ phase: "authenticated", user, error: null });
    } catch {
      set({ phase: "login", user: null });
    }
  },

  login: async (username, password) => {
    try {
      set({ error: null });
      const { user } = await authApi.login({ username, password });
      set({ phase: "authenticated", user, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Login failed" });
    }
  },

  setup: async (username, displayName, password) => {
    try {
      set({ error: null });
      const { user } = await authApi.setup({ username, displayName, password });
      set({ phase: "authenticated", user, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Setup failed" });
    }
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      // Ignore logout errors
    }
    set({ phase: "login", user: null, error: null });
  },

  clearError: () => set({ error: null }),
}));
