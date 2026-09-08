import { readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { Repository } from "./git.ts";
import {
  descendants,
  isLive,
  listeners,
  processTable,
  workingDirectories,
} from "./process-info.ts";
import type { Store } from "./store.ts";
import { canonical } from "./system.ts";
import type { RunResult, Snapshot, Workspace } from "./types.ts";

// Managed process ancestry takes precedence over external working-directory matches.
export async function readSnapshot(repo: Repository, store: Store): Promise<Snapshot> {
  const [state, trees, table, discovery] = await Promise.all([
    store.read(),
    repo.list(),
    processTable(),
    listeners(),
  ]);
  const ownership = new Map<number, Workspace>();
  const worktrees = await Promise.all(
    trees.map(async (tree): Promise<Workspace> => {
      const run = state.runs[tree.path];
      const running = isLive(run, table);
      const ws: Workspace = { tree, ports: [], run, running, stopped: false, status: "Idle" };
      if (run && running) {
        for (const pid of descendants(run.pid, table)) ownership.set(pid, ws);
      } else if (run) {
        try {
          const result: RunResult = JSON.parse(await readFile(run.result, "utf8"));
          ws.exit_code = result.exit_code;
          ws.stopped = result.stopped;
        } catch {
          /* A killed supervisor may not have a result file. */
        }
      }
      return ws;
    }),
  );
  let warning = discovery.warning;
  const external = discovery.ports.filter((port) => !ownership.has(port.pid));
  const directories = await workingDirectories(external.map((port) => port.pid)).catch((error) => {
    warning = `Some external servers could not be mapped: ${error}`;
    return new Map<number, string>();
  });
  const byDepth = [...worktrees].sort((a, b) => b.tree.path.length - a.tree.path.length);
  for (const port of discovery.ports) {
    const owned = ownership.get(port.pid);
    if (owned) {
      owned.ports.push({ ...port, managed: true });
      continue;
    }
    const directory = directories.get(port.pid);
    if (!directory) continue;
    const cwd = await canonical(directory);
    const ws = byDepth.find(({ tree }) => {
      const rel = relative(tree.path, cwd);
      return !rel.startsWith("../") && rel !== ".." && !isAbsolute(rel);
    });
    ws?.ports.push(port);
  }
  for (const ws of worktrees) {
    ws.status = ws.running
      ? "Running"
      : ws.exit_code && !ws.stopped
        ? `Exited (${ws.exit_code})`
        : ws.ports.length
          ? "External"
          : ws.run
            ? "Stopped"
            : "Idle";
    if (ws.tree.statusError) {
      if (!ws.running) ws.status = "Git error";
      warning = [warning, `${ws.tree.path}: ${ws.tree.statusError}`].filter(Boolean).join("\n");
    }
  }
  return { worktrees, warning };
}
