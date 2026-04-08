/**
 * Persistent connection settings store.
 * Stores the server URL and auth token using expo-secure-store for credentials.
 */

import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

const STORAGE_KEY_URL = "t3code:server-url";
const STORAGE_KEY_TOKEN = "t3code:auth-token";

export interface ConnectionSettings {
  serverUrl: string;
  authToken: string;
}

interface ConnectionStore {
  serverUrl: string;
  authToken: string;
  loaded: boolean;
  load: () => Promise<void>;
  save: (settings: ConnectionSettings) => Promise<void>;
  clear: () => Promise<void>;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  serverUrl: "",
  authToken: "",
  loaded: false,

  load: async () => {
    const serverUrl = (await SecureStore.getItemAsync(STORAGE_KEY_URL)) ?? "";
    const authToken = (await SecureStore.getItemAsync(STORAGE_KEY_TOKEN)) ?? "";
    set({ serverUrl, authToken, loaded: true });
  },

  save: async (settings) => {
    await SecureStore.setItemAsync(STORAGE_KEY_URL, settings.serverUrl);
    await SecureStore.setItemAsync(STORAGE_KEY_TOKEN, settings.authToken);
    set({ serverUrl: settings.serverUrl, authToken: settings.authToken });
  },

  clear: async () => {
    await SecureStore.deleteItemAsync(STORAGE_KEY_URL);
    await SecureStore.deleteItemAsync(STORAGE_KEY_TOKEN);
    set({ serverUrl: "", authToken: "" });
  },
}));
