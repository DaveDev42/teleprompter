/**
 * Tracks whether any ModalContainer-backed dialog is currently open, so
 * global shortcuts can stay quiet while one is up. The modal's inert-siblings
 * walk only blocks Tab order, clicks, and the AT virtual cursor —
 * capture-phase document keydown listeners still fire.
 *
 * A module-level counter rather than a Zustand store: nothing renders from
 * this state, it is only read inside event handlers.
 */
let openCount = 0;

/**
 * Mark a modal as open. Returns a release function that is safe to call
 * more than once (effect cleanups can run on both close and unmount).
 */
export function registerOpenModal(): () => void {
  openCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCount--;
  };
}

export function isAnyModalOpen(): boolean {
  return openCount > 0;
}
