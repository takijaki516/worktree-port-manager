import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "../src/store.ts";
import { execute } from "../src/system.ts";
import { fixture } from "./helpers.ts";

let context: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  context = await fixture();
});
afterEach(async () => {
  await context.cleanup();
});

test("default commands preserve saved preferences and package manager precedence", async () => {
  const tree = await context.repo.find();
  expect(await context.manager.defaultCommand(tree)).toBe("");
  await writeJson(join(tree.path, "package.json"), { scripts: { dev: "start-server" } });
  expect(await context.manager.defaultCommand(tree)).toBe("npm run dev");
  for (const [file, runner] of [
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["yarn.lock", "yarn"],
    ["pnpm-lock.yaml", "pnpm"],
  ] as const) {
    await writeFile(join(tree.path, file), "");
    expect(await context.manager.defaultCommand(tree)).toBe(`${runner} run dev`);
  }
  await context.manager.store.edit(async (state) => {
    state.command = "custom dev --flag";
  });
  expect(await context.manager.defaultCommand(tree)).toBe("custom dev --flag");
  await context.manager.store.edit(async (state) => {
    state.command = "";
  });
  await writeFile(join(tree.path, "package.json"), "invalid JSON");
  expect(await context.manager.defaultCommand(tree)).toBe("");
});

test("invalid server input preserves errors without creating run state", async () => {
  const tree = await context.repo.find();
  await expect(context.manager.start(tree, " \n")).rejects.toThrow(
    "Enter a server command, for example: npm run dev",
  );
  for (const port of [0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(context.manager.start(tree, "sleep 30", port)).rejects.toThrow(
      "Port must be between 1 and 65535.",
    );
  }
  expect(await context.manager.store.read()).toEqual({ command: "", runs: {} });
});

test("snapshots preserve exit status precedence and tolerate missing results", async () => {
  const tree = await context.repo.find();
  expect((await context.manager.snapshot()).worktrees[0]?.status).toBe("Idle");
  const result = join(context.directory, "result.json");
  await context.manager.store.edit(async (state) => {
    state.runs[tree.path] = {
      pid: 99999999,
      started_at: "old run",
      command: "old server",
      result,
      log: join(context.directory, "server.log"),
    };
  });
  expect((await context.manager.snapshot()).worktrees[0]?.status).toBe("Stopped");
  for (const [exit_code, stopped, status] of [
    [0, false, "Stopped"],
    [7, false, "Exited (7)"],
    [-15, true, "Stopped"],
    [7, true, "Stopped"],
  ] as const) {
    await writeJson(result, { exit_code, stopped, finished_at: 1 });
    const workspace = (await context.manager.snapshot()).worktrees[0];
    expect(workspace).toMatchObject({ exit_code, stopped, status, running: false, ports: [] });
  }
  await writeFile(result, "invalid JSON");
  expect((await context.manager.snapshot()).worktrees[0]?.status).toBe("Stopped");
});

test("logs preserve empty, missing and byte-limited tail behavior", async () => {
  const tree = await context.repo.find();
  expect(await context.manager.logs(tree)).toBe("Run a server to see its output here.");
  const log = join(context.directory, "server.log");
  await context.manager.store.edit(async (state) => {
    state.runs[tree.path] = {
      pid: 99999999,
      started_at: "old run",
      command: "old server",
      result: join(context.directory, "result.json"),
      log,
    };
  });
  await writeFile(log, "");
  expect(await context.manager.logs(tree)).toBe("Waiting for output…");
  await writeFile(log, "first line\nlast line\n");
  expect(await context.manager.logs(tree, 10)).toBe("last line\n");
  await rm(log);
  expect(await context.manager.logs(tree)).toStartWith("Log unavailable: ");
});

test("CLI preserves version, JSON shape, and non-interactive error output", async () => {
  const cli = join(import.meta.dir, "../src/cli.ts");
  const invoke = (...args: string[]) =>
    execute(process.execPath, [cli, "-C", context.repo.root, ...args]);
  expect(await invoke("--version")).toMatchObject({ code: 0, stdout: "0.2.0\n", stderr: "" });
  const listed = await invoke("list", "--json");
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout)).toEqual({
    worktrees: [
      {
        tree: await context.repo.find(),
        ports: [],
        running: false,
        stopped: false,
        status: "Idle",
      },
    ],
    warning: "",
  });
  expect(await invoke()).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "Open wt in an interactive terminal, or use 'wt list --json'.\n",
  });
});
