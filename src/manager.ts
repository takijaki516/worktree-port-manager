import { spawn } from "node:child_process";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "shell-quote";
import type { Repository } from "./git.ts";
import {
  descendants,
  isLive,
  legacyIdentityMatches,
  listeners,
  processTable,
  workingDirectories,
} from "./process-info.ts";
import { Store, writeJson } from "./store.ts";
import type { RunSpec } from "./supervisor.ts";
import { canonical, execute, sleep } from "./system.ts";
import {
  type RunRecord,
  type RunResult,
  type Snapshot,
  type Workspace,
  type Worktree,
  WorktreeError,
} from "./types.ts";

// Replaced only by the standalone build. Source and JS bundles use Bun directly.
declare const WT_STANDALONE: boolean;

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
    const [state, trees, table, discovery] = await Promise.all([
      this.store.read(),
      this.repo.list(),
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
    const directories = await workingDirectories(external.map((port) => port.pid)).catch(
      (error) => {
        warning = `Some external servers could not be mapped: ${error}`;
        return new Map<number, string>();
      },
    );
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
      const token = crypto.randomUUID();
      const directory = join(this.store.directory, "runs", token);
      await mkdir(directory, { recursive: true });
      const spec: RunSpec = {
        command,
        cwd: tree.path,
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
        cwd: standalone ? tree.path : dirname(supervisor),
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
            state.runs[tree.path] = run;
            state.command = command;
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
    });
  }

  async stop(tree: Worktree): Promise<void> {
    await this.store.edit(async (state) => {
      const record = state.runs[tree.path];
      if (!record || !isLive(record, await processTable()))
        throw new WorktreeError("No managed server is running in this worktree.");
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

  async openCodex(tree: Worktree): Promise<void> {
    if (!(await stat(tree.path).catch(() => null))?.isDirectory()) {
      throw new WorktreeError("The worktree directory is missing.");
    }
    const command = Bun.which("codex", { PATH: process.env.PATH });
    if (!command) {
      throw new WorktreeError(
        "Codex CLI not found. Install it and make 'codex' available on PATH.",
      );
    }
    const result = await execute(command, ["app", tree.path]);
    if (result.code !== 0) {
      throw new WorktreeError(
        `Could not open Codex: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
      );
    }
  }

  async openEditor(tree: Worktree): Promise<void> {
    const args = parse(process.env.WT_EDITOR || "code");
    if (
      !args.length ||
      args.some((arg) => typeof arg !== "string") ||
      !Bun.which(String(args[0]))
    ) {
      throw new WorktreeError("Editor not found. Set WT_EDITOR to a GUI editor, e.g. 'cursor'.");
    }
    await launch(String(args[0]), [...(args.slice(1) as string[]), tree.path]);
  }

  async openTerminal(tree: Worktree): Promise<void> {
    if (process.platform === "darwin") await launch("open", ["-a", "Terminal", tree.path]);
    else await launch("x-terminal-emulator", [], tree.path);
  }

  async openBrowser(url: string): Promise<void> {
    await launch(process.platform === "darwin" ? "open" : "xdg-open", [url]);
  }
}

async function launch(command: string, args: string[], cwd?: string): Promise<void> {
  const child = spawn(command, args, { cwd, detached: true, stdio: "ignore" });
  await new Promise<void>((done, reject) => {
    child.once("spawn", done);
    child.once("error", reject);
  });
  child.unref();
}
