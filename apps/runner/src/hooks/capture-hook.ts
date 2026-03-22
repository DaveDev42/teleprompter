/**
 * Generates the Bun one-liner command that hook scripts use
 * to send event data back to the HookReceiver socket.
 */
export function captureHookCommand(hookSocketPath: string): string {
  // The hook script reads JSON from stdin and sends it to the HookReceiver unix socket.
  // Using Bun one-liner to avoid platform-dependent tools like nc/socat.
  return `bun -e "const d=await Bun.stdin.text();const s=await Bun.connect({unix:'${hookSocketPath}',socket:{open(s){s.write(d);s.end()},data(){},error(){}}});"`;
}
