import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { parse } from "shell-quote";
import { execute } from "./system.ts";
import { type Worktree, WorktreeError } from "./types.ts";

export async function openCodex(tree: Worktree): Promise<void> {
  if (!(await stat(tree.path).catch(() => null))?.isDirectory()) {
    throw new WorktreeError("The worktree directory is missing.");
  }
  const command = Bun.which("codex", { PATH: process.env.PATH });
  if (!command) {
    throw new WorktreeError("Codex CLI not found. Install it and make 'codex' available on PATH.");
  }
  const result = await execute(command, ["app", tree.path]);
  if (result.code !== 0) {
    throw new WorktreeError(
      `Could not open Codex: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
    );
  }
}

export async function openEditor(tree: Worktree): Promise<void> {
  const args = parse(process.env.WT_EDITOR || "code");
  if (!args.length || args.some((arg) => typeof arg !== "string") || !Bun.which(String(args[0]))) {
    throw new WorktreeError("Editor not found. Set WT_EDITOR to a GUI editor, e.g. 'cursor'.");
  }
  await launch(String(args[0]), [...(args.slice(1) as string[]), tree.path]);
}

export async function openTerminal(tree: Worktree): Promise<void> {
  if (process.platform === "darwin") await launch("open", ["-a", "Terminal", tree.path]);
  else await launch("x-terminal-emulator", [], tree.path);
}

export async function openBrowser(url: string): Promise<void> {
  await launch(process.platform === "darwin" ? "open" : "xdg-open", [url]);
}

async function launch(command: string, args: string[], cwd?: string): Promise<void> {
  const child = spawn(command, args, { cwd, detached: true, stdio: "ignore" });
  await new Promise<void>((done, reject) => {
    child.once("spawn", done);
    child.once("error", reject);
  });
  child.unref();
}
