import { main } from "./cli.ts";
import { supervise } from "./supervisor.ts";
import { errorMessage } from "./types.ts";

// Re-execute the same binary for background servers, without a sibling script
// or an installed Bun runtime. Normal user commands go through the usual CLI.
if (process.argv[2] === "--internal-supervisor") {
  const specPath = process.argv[3];
  if (!specPath || process.argv.length !== 4) {
    console.error("A supervisor spec path is required.");
    process.exitCode = 1;
  } else {
    try {
      await supervise(specPath);
    } catch (error) {
      console.error(errorMessage(error));
      process.exitCode = 1;
    }
  }
} else {
  process.exitCode = await main();
}
