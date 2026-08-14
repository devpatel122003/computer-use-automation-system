import readline from "node:readline/promises";

export async function promptLine(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(query);
  } finally {
    rl.close();
  }
}
