/**
 * Cross-platform secure storage.
 * - iOS: Keychain via expo-secure-store
 * - Android: Keystore via expo-secure-store
 * - Web: localStorage (best available without native keychain)
 */

import { Platform } from "react-native";

let SecureStore: any = null;
if (Platform.OS !== "web") {
  try {
    SecureStore = require("expo-secure-store");
  } catch {
    // Not available
  }
}

export async function secureGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    try {
      return localStorage.getItem(`tp_${key}`);
    } catch {
      return null;
    }
  }

  if (SecureStore) {
    return SecureStore.getItemAsync(key);
  }

  return null;
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      localStorage.setItem(`tp_${key}`, value);
    } catch {
      // Storage full or blocked
    }
    return;
  }

  if (SecureStore) {
    await SecureStore.setItemAsync(key, value);
  }
}

export async function secureDelete(key: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      localStorage.removeItem(`tp_${key}`);
    } catch {
      // ignore
    }
    return;
  }

  if (SecureStore) {
    await SecureStore.deleteItemAsync(key);
  }
}
