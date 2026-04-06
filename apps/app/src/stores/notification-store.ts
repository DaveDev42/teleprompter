import { create } from "zustand";

export interface ToastData {
  title: string;
  body: string;
  data?: { sid: string; daemonId: string; event: string };
}

interface NotificationStore {
  toast: ToastData | null;
  showToast: (data: ToastData) => void;
  dismissToast: () => void;
}

export const useNotificationStore = create<NotificationStore>((set) => ({
  toast: null,
  showToast: (data) => {
    set({ toast: data });
    setTimeout(() => {
      set((state) => (state.toast === data ? { toast: null } : state));
    }, 5000);
  },
  dismissToast: () => set({ toast: null }),
}));
