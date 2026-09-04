import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { isMissing } from "./system.ts";
import { type RunRecord, type State, WorktreeError } from "./types.ts";

export async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validRecord(record: unknown): record is RunRecord {
  if (!record || typeof record !== "object") return false;
  const run = record as Partial<RunRecord>;
  return (
    typeof run.pid === "number" &&
    Number.isInteger(run.pid) &&
    run.pid > 0 &&
    typeof run.command === "string" &&
    typeof run.log === "string" &&
    typeof run.result === "string" &&
    (typeof run.started_at === "string" || typeof run.created_at === "number")
  );
}

export class Store {
  readonly directory: string;
  readonly path: string;
  constructor(commonDir: string) {
    this.directory = join(commonDir, "worktree-manager");
    this.path = join(this.directory, "state.json");
  }

  async read(): Promise<State> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if (
        !value ||
        typeof value.command !== "string" ||
        !value.runs ||
        Array.isArray(value.runs) ||
        typeof value.runs !== "object" ||
        !Object.values(value.runs).every(validRecord)
      ) {
        throw new Error("Invalid state format");
      }
      return value;
    } catch (error) {
      if (isMissing(error)) return { command: "", runs: {} };
      throw new WorktreeError(`Cannot read local state at ${this.path}: ${error}`);
    }
  }

  async edit<T>(operation: (state: State) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const release = await lockfile.lock(join(this.directory, "operations"), {
      realpath: false,
      stale: 30000,
      update: 10000,
      retries: { retries: 60, minTimeout: 100, maxTimeout: 250 },
    });
    try {
      const state = await this.read();
      const result = await operation(state);
      await writeJson(this.path, state);
      return result;
    } finally {
      await release();
    }
  }
}
