/**
 * Generates the Bun one-liner command that hook scripts use
 * to send event data back to the HookReceiver socket.
 */
export function captureHookCommand(hookSocketPath: string): string {
  // The hook script reads JSON from stdin and sends it to the HookReceiver unix socket.
  // Using Bun one-liner to avoid platform-dependent tools like nc/socat.
  //
  // Shell-quoting strategy:
  //   - JSON.stringify produces a double-quoted JS string literal for the path
  //     (e.g. "/tmp/hook.sock"), which is the correct way to embed the path as a
  //     JS string literal inside the bun script.
  //   - We wrap the ENTIRE `bun -e` argument in SINGLE quotes so the inner
  //     double-quotes from JSON.stringify don't collide with (and prematurely
  //     terminate) the outer shell argument.
  //   - Any single-quote that appears inside the script (possible if hookSocketPath
  //     contains a single-quote — JSON.stringify does not escape it since `'` is not
  //     a JSON special char) is escaped using the POSIX-safe `'\''` idiom:
  //     close-quote → literal-escaped-quote → reopen-quote.
  const jsLiteralPath = JSON.stringify(hookSocketPath);
  const script = `const d=await Bun.stdin.text();const s=await Bun.connect({unix:${jsLiteralPath},socket:{open(s){s.write(d);s.end()},data(){},error(){}}});`;
  const shellEscaped = script.replace(/'/g, `'\\''`);
  return `bun -e '${shellEscaped}'`;
}
