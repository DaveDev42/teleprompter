/**
 * Generates the Bun one-liner command that hook scripts use
 * to send event data back to the HookReceiver socket.
 */
export function captureHookCommand(hookSocketPath: string): string {
  // The hook script reads JSON from stdin and sends it to the HookReceiver unix socket.
  // Using Bun one-liner to avoid platform-dependent tools like nc/socat.
  // JSON.stringify produces a properly-escaped JS string literal (double-quoted),
  // which is safe to embed inside the outer double-quoted shell argument.
  // The raw interpolation `'${hookSocketPath}'` would break on paths that contain
  // a single-quote, backslash, or double-quote — an injection vector on some
  // $TMPDIR configurations. JSON.stringify handles all of those correctly.
  const escapedPath = JSON.stringify(hookSocketPath);
  return `bun -e "const d=await Bun.stdin.text();const s=await Bun.connect({unix:${escapedPath},socket:{open(s){s.write(d);s.end()},data(){},error(){}}});"`;
}
