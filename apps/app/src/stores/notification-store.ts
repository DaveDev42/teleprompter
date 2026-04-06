import { create } from "zustand";

export interface ToastData {
  title: string;
  body: string;
  data?: { sid: string; daemonId: string; event: string };
}

interface NotificationStore {
  toast: ToastData | null;
  _timer: ReturnType<typeof setTimeout> | null;
  showToast: (data: ToastData) => void;
  dismissToast: () => void;
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  toast: null,
  _timer: null,
  showToast: (data) => {
    const prev = get()._timer;
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      set((state) => (state.toast === data ? { toast: null, _timer: null } : state));
    }, 5000);
    set({ toast: data, _timer: timer });
  },
  dismissToast: () => {
    const timer = get()._timer;
    if (timer) clearTimeout(timer);
    set({ toast: null, _timer: null });
  },
}));
