import { spawn } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isLive, legacyIdentityMatches, processTable } from "./process-info.ts";
import { writeJson } from "./store.ts";
import type { RunSpec } from "./supervisor.ts";
import { sleep } from "./system.ts";
import { type RunRecord, WorktreeError } from "./types.ts";

// Replaced only by the standalone build. Source and JS bundles use Bun directly.
declare const WT_STANDALONE: boolean;

// Callers hold the store lock across validation, launch, and persistence.
export async function startRun(
  storeDirectory: string,
  cwd: string,
  command: string,
  port?: number,
): Promise<RunRecord> {
  const token = crypto.randomUUID();
  const directory = join(storeDirectory, "runs", token);
  await mkdir(directory, { recursive: true });
  const spec: RunSpec = {
    command,
    cwd: cwd,
    token,
    result: join(directory, "result.json"),
    control: join(directory, "stop"),
    ready: join(directory, "ready.json"),
  };
  const specPath = join(directory, "spec.json");
  const logPath = join(directory, "server.log");
  await writeJson(specPath, spec);
  const output = await open(logPath, "a", 0o600);
  const standalone = typeof WT_STANDALONE !== "undefined" && WT_STANDALONE;
  const supervisor = standalone
    ? process.execPath
    : fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts") ? "./supervisor.ts" : "./supervisor.js",
          import.meta.url,
        ),
      );
  const args = standalone ? ["--internal-supervisor", specPath] : [supervisor, specPath];
  const child = spawn(process.execPath, args, {
    // Embedded Bun filesystem paths cannot be used as a process cwd.
    cwd: standalone ? cwd : dirname(supervisor),
    detached: true,
    stdio: ["ignore", output.fd, output.fd],
    env: { ...process.env, ...(port === undefined ? {} : { PORT: String(port) }) },
  });
  try {
    await new Promise<void>((done, reject) => {
      child.once("spawn", done);
      child.once("error", reject);
    });
  } finally {
    await output.close();
  }
  child.unref();
  try {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const ready = await readFile(spec.ready, "utf8").catch(() => "");
      if (ready) {
        const identity = JSON.parse(ready) as { pid: number; started_at: string };
        const run: RunRecord = {
          ...identity,
          command,
          log: logPath,
          result: spec.result,
          port,
          control: spec.control,
          token,
        };
        return run;
      }
      if (child.exitCode !== null) break;
      await sleep(50);
    }
    throw new WorktreeError(`Server failed to start. See ${logPath}`);
  } catch (error) {
    await writeFile(spec.control, token);
    throw error;
  }
}

export async function stopRun(record: RunRecord): Promise<void> {
  if (record.control && record.token) {
    await writeFile(record.control, record.token, { mode: 0o600 });
  } else {
    if (!(await legacyIdentityMatches(record)) || !isLive(record, await processTable())) {
      throw new WorktreeError(
        "Cannot verify the legacy supervisor identity. Stop it in its original session.",
      );
    }
    process.kill(record.pid, "SIGTERM");
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!isLive(record, await processTable())) return;
    await sleep(100);
  }
  throw new WorktreeError("Server is still stopping. Check its logs and try again.");
}

export async function readRunLog(record: RunRecord | undefined, limit: number): Promise<string> {
  if (!record) return "Run a server to see its output here.";
  try {
    const file = await open(record.log, "r");
    try {
      const size = (await file.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, limit));
      await file.read(buffer, 0, buffer.length, Math.max(0, size - limit));
      return buffer.toString("utf8") || "Waiting for output…";
    } finally {
      await file.close();
    }
  } catch (error) {
    return `Log unavailable: ${error}`;
  }
}
