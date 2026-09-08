import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { openBrowser, openCodex, openEditor, openTerminal } from "./desktop.ts";
import type { Repository } from "./git.ts";
import { readRunLog, startRun, stopRun } from "./managed-run.ts";
import { isLive, listeners, processTable } from "./process-info.ts";
import { Store } from "./store.ts";
import { type RunRecord, type Snapshot, type Worktree, WorktreeError } from "./types.ts";
import { readSnapshot } from "./workspace-snapshot.ts";

export class Manager {
  readonly store: Store;
  constructor(readonly repo: Repository) {
    this.store = new Store(repo.commonDir);
  }

  async defaultCommand(tree: Worktree): Promise<string> {
    const saved = (await this.store.read()).command;
    if (saved) return saved;
    try {
      const pkg = JSON.parse(await readFile(join(tree.path, "package.json"), "utf8"));
      if (pkg.scripts?.dev) {
        for (const [file, runner] of [
          ["pnpm-lock.yaml", "pnpm"],
          ["yarn.lock", "yarn"],
          ["bun.lock", "bun"],
          ["bun.lockb", "bun"],
        ]) {
          if (file && (await stat(join(tree.path, file)).catch(() => null)))
            return `${runner} run dev`;
        }
        return "npm run dev";
      }
    } catch {
      /* No dev script to suggest. */
    }
    return "";
  }

  async snapshot(): Promise<Snapshot> {
    return readSnapshot(this.repo, this.store);
  }

  async start(target: Worktree, command: string, port?: number): Promise<RunRecord> {
    const tree = await this.repo.find(target.path);
    if (tree.statusError) throw new WorktreeError(tree.statusError);
    if (!command.trim())
      throw new WorktreeError("Enter a server command, for example: npm run dev");
    if (tree.prunable || !(await stat(tree.path).catch(() => null))?.isDirectory()) {
      throw new WorktreeError("The worktree directory is missing.");
    }
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new WorktreeError("Port must be between 1 and 65535.");
    }
    return this.store.edit(async (state) => {
      if (isLive(state.runs[tree.path], await processTable())) {
        throw new WorktreeError("This worktree already has a managed server running.");
      }
      if (port !== undefined) {
        const found = await listeners();
        if (found.warning) throw new WorktreeError(found.warning);
        if (found.ports.some((p) => p.port === port))
          throw new WorktreeError(`Port ${port} is already in use. Choose another port.`);
      }
      const run = await startRun(this.store.directory, tree.path, command, port);
      state.runs[tree.path] = run;
      state.command = command;
      return run;
    });
  }

  async stop(tree: Worktree): Promise<void> {
    await this.store.edit(async (state) => {
      const record = state.runs[tree.path];
      if (!record || !isLive(record, await processTable()))
        throw new WorktreeError("No managed server is running in this worktree.");
      await stopRun(record);
    });
  }

  async remove(tree: Worktree): Promise<void> {
    await this.store.edit(async (state) => {
      if (isLive(state.runs[tree.path], await processTable()))
        throw new WorktreeError("Stop this worktree's server before removing the worktree.");
      const snapshot = await this.snapshot();
      if (snapshot.warning) throw new WorktreeError(snapshot.warning);
      if (snapshot.worktrees.find((ws) => ws.tree.path === tree.path)?.ports.length) {
        throw new WorktreeError("This worktree still has listening servers. Stop them first.");
      }
      await this.repo.remove(tree);
      delete state.runs[tree.path];
    });
  }

  async logs(tree: Worktree, limit = 32000): Promise<string> {
    const record = (await this.store.read()).runs[tree.path];
    return readRunLog(record, limit);
  }

  async openCodex(tree: Worktree): Promise<void> {
    await openCodex(tree);
  }

  async openEditor(tree: Worktree): Promise<void> {
    await openEditor(tree);
  }

  async openTerminal(tree: Worktree): Promise<void> {
    await openTerminal(tree);
  }

  async openBrowser(url: string): Promise<void> {
    await openBrowser(url);
  }
}
