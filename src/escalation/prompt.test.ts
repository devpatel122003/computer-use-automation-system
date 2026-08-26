import { describe, expect, it } from "vitest";
import { Readable, Writable } from "node:stream";
import { promptLine } from "./prompt.js";

function nullWritable(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

// Races a real assertion against a short timeout so a regression back to hanging behavior
// fails the test instead of hanging the whole suite.
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

describe("promptLine", () => {
  it("resolves with the typed answer when the input stream provides one", async () => {
    const answer = await withTimeout(
      promptLine("continue? ", Readable.from(["yes\n"]), nullWritable()),
      1000,
      "promptLine with a real answer",
    );
    expect(answer).toBe("yes");
  });

  it("resolves as declined (empty string), not hanging, when input closes before any answer", async () => {
    // Simulates `--allow-risky true < /dev/null`: stdin is a genuinely closed, zero-byte
    // stream, as opposed to a pipe carrying a real answer. Regression coverage for a real bug
    // found while verifying the demo path from a fresh clone -- this used to hang forever
    // (with a live Playwright browser open elsewhere in the process keeping the event loop
    // alive, so it never even exited on its own).
    const answer = await withTimeout(
      promptLine("continue? ", Readable.from([]), nullWritable()),
      1000,
      "promptLine with closed/empty input",
    );
    expect(answer).toBe("");
  });

  it("still resolves with the real answer even though the input stream ends right after it", async () => {
    // Guards the specific race an earlier fix attempt had: a `readline/promises` `question()`
    // resolved via a `.then()` microtask could lose a race against a synchronous `close`
    // listener when the answer is immediately followed by EOF -- exactly what `echo yes | ...`
    // looks like from readline's perspective -- silently turning a real "yes" into a decline.
    const answer = await withTimeout(
      promptLine("continue? ", Readable.from(["yes\n"]), nullWritable()),
      1000,
      "promptLine with answer immediately followed by EOF",
    );
    expect(answer).toBe("yes");
  });
});
