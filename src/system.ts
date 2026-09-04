import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { WorktreeError } from "./types.ts";

export function execute(file: string, args: string[], timeout = 30000) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((done, reject) => {
    execFile(
      file,
      args,
      {
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        if (error && (typeof error.code !== "number" || error.killed)) {
          reject(new WorktreeError(`${file} could not finish: ${error.message}`));
        } else {
          done({ stdout, stderr, code: typeof error?.code === "number" ? error.code : 0 });
        }
      },
    );
  });
}

export async function canonical(path: string): Promise<string> {
  const expanded =
    path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;
  const absolute = resolve(expanded);
  return realpath(absolute).catch(() => absolute);
}

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
