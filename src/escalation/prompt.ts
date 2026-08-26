import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * Prompts on stdin/stdout and resolves with the answer. Found for real while verifying an
 * "unattended replay" run against an artifact whose confidence hadn't yet reached "high": the
 * confidence circuit breaker fell back to an interactive confirmation, but stdin was `/dev/null`
 * (a genuinely closed, zero-byte input, as opposed to a pipe that carries a real answer like
 * `echo yes | ...`). `readline/promises`' own `question()` never settles when the input stream
 * ends before an answer is typed -- it just hangs forever, and with a live Playwright browser
 * still open the process has other active handles keeping the event loop alive, so it never
 * naturally exits either. A script that pipes closed/non-interactive stdin at an unattended
 * command has no way to ever supply "yes", so the only safe behavior is to treat stream closure
 * as an explicit decline, consistent with this system's "never auto-execute a risky action when
 * uncertain" posture -- not to hang indefinitely.
 *
 * Uses the classic callback-based `readline` module rather than `readline/promises` on purpose:
 * an earlier version of this fix raced `question()`'s promise (settled via a `.then()`
 * microtask) against a synchronous `close` listener, and on a stream that provides a real
 * answer immediately followed by EOF (exactly what `echo yes | ...` looks like from readline's
 * perspective), `close` could fire and resolve the "declined" branch before the microtask ever
 * ran -- silently turning a real "yes" into a decline. The callback form invokes its callback
 * synchronously within the same `line` event that a real answer arrives on, so a `settled` flag
 * checked from both paths resolves this correctly without that race.
 */
export async function promptLine(
  query: string,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return await new Promise<string>((resolve) => {
      let settled = false;
      const settle = (value: string): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      rl.question(query, settle);
      rl.once("close", () => settle(""));
    });
  } finally {
    rl.close();
  }
}
