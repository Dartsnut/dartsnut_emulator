import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { SessionEngine } from "./sessionEngine";

export async function runInteractiveCli(session: SessionEngine): Promise<void> {
  const rl = readline.createInterface({ input, output });
  output.write("Dartsnut Agent CLI. Type 'exit' to quit.\n");
  while (true) {
    const prompt = await rl.question("> ");
    if (prompt.trim().toLowerCase() === "exit") {
      break;
    }
    await session.runPrompt(prompt, (event) => {
      if (event.type === "status") {
        output.write(`[status] ${event.message}\n`);
      }
      if (event.type === "error") {
        output.write(`[error] ${event.message}\n`);
      }
      if (event.type === "final") {
        output.write(`${event.content}\n`);
      }
    });
  }
  rl.close();
}
