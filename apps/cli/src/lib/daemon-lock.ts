/**
 * Re-export daemon singleton lock helpers from the daemon package so CLI
 * modules can import from a local path without reaching into another package's
 * `src/` directory directly.
 */
export {
  acquireDaemonLock,
  checkDaemonLockAlive,
  getDaemonLockPath,
  readDaemonLockPid,
  releaseDaemonLock,
} from "@teleprompter/daemon";
