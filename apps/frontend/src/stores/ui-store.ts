import { create } from "zustand";

export type ActiveTab = "chat" | "terminal";

export interface UIState {
  /** Currently active tab */
  activeTab: ActiveTab;

  // Actions
  setActiveTab: (tab: ActiveTab) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeTab: "chat",

  setActiveTab: (tab) => set({ activeTab: tab }),
}));
