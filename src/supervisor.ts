import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { processTable } from "./process-info.ts";
import { writeJson } from "./store.ts";
import { sleep } from "./system.ts";
import type { RunResult } from "./types.ts";

export interface RunSpec {
  command: string;
  cwd: string;
  result: string;
  control: string;
  ready: string;
  token: string;
}

async function supervise(specPath: string): Promise<void> {
  const spec: RunSpec = JSON.parse(await readFile(specPath, "utf8"));
  let stopped = false;
  const requestStop = () => {
    stopped = true;
  };
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);
  const identity = (await processTable()).get(process.pid);
  if (!identity) throw new Error("Cannot determine supervisor identity.");
  await writeJson(spec.ready, { pid: process.pid, started_at: identity.started });

  const child = spawn("/bin/sh", ["-c", spec.command], {
    cwd: spec.cwd,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  let exitCode: number | undefined;
  child.on("error", (error) => {
    console.error(error.message);
    exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    exitCode = code ?? (signal ? 128 : 1);
  });

  try {
    while (exitCode === undefined && !stopped) {
      if ((await readFile(spec.control, "utf8").catch(() => "")) === spec.token) stopped = true;
      if (!stopped) await sleep(100);
    }
  } finally {
    // Only this supervisor owns this newly created server group. CLI callers send
    // a per-run token to a control file and never signal a guessed group ID.
    if (child.pid) {
      const group = child.pid;
      const signalGroup = (signal: NodeJS.Signals) => {
        try {
          process.kill(-group, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
      signalGroup("SIGTERM");
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const alive = [...(await processTable()).values()].some(
          (info) => info.group === group && !info.status.startsWith("Z"),
        );
        if (!alive) break;
        await sleep(100);
      }
      const remaining = [...(await processTable()).values()].some(
        (info) => info.group === group && !info.status.startsWith("Z"),
      );
      if (remaining) signalGroup("SIGKILL");
    }
    const result: RunResult = {
      exit_code: stopped ? -15 : (exitCode ?? 1),
      stopped,
      finished_at: Date.now() / 1000,
    };
    await writeJson(spec.result, result);
  }
}

if (import.meta.main) {
  const spec = process.argv[2];
  if (!spec) throw new Error("A supervisor spec path is required.");
  await supervise(spec);
}
