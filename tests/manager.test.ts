import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Manager } from "../src/manager.ts";
import { isLive, parseListeners, portUrl, processTable } from "../src/process-info.ts";
import { writeJson } from "../src/store.ts";
import { execute } from "../src/system.ts";
import { connects, eventually, fixture, freePort, serverCommand } from "./helpers.ts";

let context: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  context = await fixture();
});
afterEach(async () => {
  await context.cleanup();
});

test("Codex receives the exact selected path and reports launch failures", async () => {
  const tree = await context.repo.create({
    branch: "codex",
    path: join(context.directory, "worktree ' $() with spaces"),
  });
  const executable = join(context.directory, "codex");
  await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "$0.args"\n');
  await chmod(executable, 0o755);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = context.directory;
    await context.manager.openCodex(tree);
    expect(await readFile(`${executable}.args`, "utf8")).toBe(`app\n${tree.path}\n`);
    await writeFile(executable, '#!/bin/sh\nprintf "desktop launch failed" >&2\nexit 7\n');
    await expect(context.manager.openCodex(tree)).rejects.toThrow("desktop launch failed");
    await rm(executable);
    await expect(context.manager.openCodex(tree)).rejects.toThrow("Codex CLI not found");
    await expect(
      context.manager.openCodex({ ...tree, path: join(context.directory, "missing") }),
    ).rejects.toThrow("directory is missing");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("managed ports survive reconnect, protect deletion, and close on stop", async () => {
  const tree = await context.repo.create({ branch: "server" });
  const port = freePort();
  const run = await context.manager.start(tree, serverCommand(port), port);
  await eventually(() => connects(port));
  const other = new Manager(context.repo);
  const snapshot = await other.snapshot();
  expect(snapshot.warning).toBe("");
  const ws = snapshot.worktrees.find((ws) => ws.tree.path === tree.path);
  expect(ws?.running).toBe(true);
  expect(ws?.ports.some((p) => p.port === port && p.managed)).toBe(true);
  expect(await other.logs(tree)).toContain("Listening");
  await expect(other.start(tree, "sleep 30")).rejects.toThrow("already has a managed");
  await expect(other.remove(tree)).rejects.toThrow("Stop this worktree");
  await other.stop(tree);
  await eventually(async () => !(await connects(port)));
  expect(isLive(run, await processTable())).toBe(false);
  expect(JSON.parse(await readFile(run.result, "utf8")).stopped).toBe(true);
});

test("external server is discovered, protected from deletion, and never stopped", async () => {
  const tree = await context.repo.create({ branch: "external" });
  const port = freePort();
  const child = spawn("/bin/sh", ["-c", `exec ${serverCommand(port)}`], {
    cwd: tree.path,
    stdio: "ignore",
  });
  try {
    await eventually(() => connects(port));
    const ws = (await context.manager.snapshot()).worktrees.find(
      (ws) => ws.tree.path === tree.path,
    );
    expect(ws?.status).toBe("External");
    expect(ws?.ports.some((p) => p.port === port && !p.managed)).toBe(true);
    await expect(context.manager.stop(tree)).rejects.toThrow("No managed server");
    await expect(context.manager.remove(tree)).rejects.toThrow("still has listening");
    await expect(
      context.manager.start(await context.repo.find(), "sleep 30", port),
    ).rejects.toThrow("already in use");
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill();
    await eventually(() => child.exitCode !== null || child.signalCode !== null);
  }
});

test("stale PID and start time never stop an unrelated process", async () => {
  const tree = await context.repo.find();
  const child = spawn("sleep", ["30"]);
  await eventually(() => child.pid !== undefined);
  try {
    await context.manager.store.edit(async (state) => {
      state.runs[tree.path] = {
        pid: child.pid ?? 0,
        started_at: "stale",
        command: "old",
        log: "/missing",
        result: "/missing",
      };
    });
    await expect(context.manager.stop(tree)).rejects.toThrow("No managed server");
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill();
    await eventually(() => child.signalCode !== null);
  }
});

test("failed command records exit code, logs, and can restart", async () => {
  const tree = await context.repo.find();
  const run = await context.manager.start(tree, "printf 'failed intentionally\\n'; exit 7");
  await eventually(async () => Boolean(await Bun.file(run.result).exists()));
  expect((await context.manager.snapshot()).worktrees[0]?.status).toBe("Exited (7)");
  expect(await context.manager.logs(tree)).toContain("failed intentionally");
  const next = await context.manager.start(tree, "sleep 30");
  expect(next.pid).not.toBe(run.pid);
  await context.manager.stop(tree);
});

test("CLI server survives its launching process and supports JSON from a linked worktree", async () => {
  const tree = await context.repo.create({ branch: "feature/cli" });
  const port = freePort();
  const cli = join(import.meta.dir, "../src/cli.ts");
  const started = await execute(process.execPath, [
    cli,
    "-C",
    tree.path,
    "run",
    "-c",
    serverCommand(port),
  ]);
  expect(started.code).toBe(0);
  await eventually(() => connects(port));
  const list = await execute(process.execPath, [cli, "-C", tree.path, "list", "--json"]);
  expect(list.code).toBe(0);
  expect(JSON.parse(list.stdout).worktrees).toHaveLength(2);
  await context.manager.stop(tree);
  await eventually(async () => !(await connects(port)));
});

test("PORT environment and multiple listener addresses", async () => {
  const tree = await context.repo.find();
  const port = freePort();
  const run = await context.manager.start(tree, "printf 'port=%s\\n' \"$PORT\"", port);
  await eventually(() => Bun.file(run.result).exists());
  expect(await context.manager.logs(tree)).toContain(`port=${port}`);
  const listeners = parseListeners("p12\ncnode\nn*:3000\nn[::1]:3000\nn127.0.0.1:3001\n");
  expect(listeners.map((p) => p.port)).toEqual([3000, 3001]);
  if (listeners[0]) expect(portUrl(listeners[0])).toBe("http://localhost:3000");
});

test("stop closes all servers started by a multi-process command", async () => {
  const tree = await context.repo.find();
  const first = freePort();
  const second = freePort();
  await context.manager.start(tree, `${serverCommand(first)} & ${serverCommand(second)} & wait`);
  await eventually(async () => (await connects(first)) && (await connects(second)));
  const ws = (await context.manager.snapshot()).worktrees[0];
  expect(
    ws?.ports
      .filter((p) => p.managed)
      .map((p) => p.port)
      .sort(),
  ).toEqual([first, second].sort());
  await context.manager.stop(tree);
  await eventually(async () => !(await connects(first)) && !(await connects(second)));
});

test("concurrent starts leave exactly one managed server", async () => {
  const tree = await context.repo.find();
  const results = await Promise.allSettled([
    context.manager.start(tree, "sleep 30"),
    new Manager(context.repo).start(tree, "sleep 30"),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
});

test("legacy Python state retains saved commands and previous logs", async () => {
  const tree = await context.repo.find();
  const log = join(context.directory, "legacy.log");
  const result = join(context.directory, "legacy-result.json");
  await writeFile(log, "previous output\n");
  await writeJson(result, { exit_code: 0, stopped: true, finished_at: 1 });
  await writeJson(context.manager.store.path, {
    command: "npm run dev",
    runs: {
      [tree.path]: {
        pid: 99999999,
        created_at: 0,
        command: "npm run dev",
        log,
        result,
        port: null,
      },
    },
  });
  expect(await context.manager.defaultCommand(tree)).toBe("npm run dev");
  expect(await context.manager.logs(tree)).toContain("previous output");
  expect((await context.manager.snapshot()).worktrees[0]?.status).toBe("Stopped");
});
