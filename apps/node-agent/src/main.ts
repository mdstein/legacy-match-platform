import { GameNodeAgent } from "./agent.js";
import { loadAgentConfig } from "./config.js";
import { NODE_VERSION } from "./version.js";

if (process.argv.length === 3 && process.argv[2] === "--version") {
  console.log(`B2G Game Node ${NODE_VERSION}`);
} else {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => controller.abort());
  }
  const agent = new GameNodeAgent(loadAgentConfig());
  await agent.run(controller.signal);
}
