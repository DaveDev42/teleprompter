import { create } from "zustand";

export interface ToastData {
  title: string;
  body: string;
  data?: { sid: string; daemonId: string; event: string };
}

interface NotificationStore {
  toast: ToastData | null;
  _timer: ReturnType<typeof setTimeout> | null;
  _toastId: number;
  showToast: (data: ToastData) => void;
  dismissToast: () => void;
}

let nextToastId = 0;

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  toast: null,
  _timer: null,
  _toastId: 0,
  showToast: (data) => {
    const prev = get()._timer;
    if (prev) clearTimeout(prev);
    const id = ++nextToastId;
    const timer = setTimeout(() => {
      set((state) =>
        state._toastId === id ? { toast: null, _timer: null } : state,
      );
    }, 5000);
    set({ toast: data, _timer: timer, _toastId: id });
  },
  dismissToast: () => {
    const timer = get()._timer;
    if (timer) clearTimeout(timer);
    set({ toast: null, _timer: null });
  },
}));
