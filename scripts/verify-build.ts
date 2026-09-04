import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { quote } from "shell-quote";
import { connects, eventually, fixture, freePort } from "../tests/helpers.ts";

const project = resolve(import.meta.dir, "..");
const context = await fixture();
const isolated = join(context.directory, "standalone without dependencies");
await mkdir(isolated);

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((done, reject) => {
    execFile(file, args, { cwd: isolated, env, timeout: 15000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file}: ${stderr || error.message}`));
      else done(stdout);
    });
  });
}

try {
  const binary = join(isolated, "wt");
  await copyFile(join(project, "dist", "wt"), binary);
  // The test server has its own embedded runtime too, so the binary's process
  // lifecycle is tested with neither Bun nor Node available on PATH.
  const server = join(isolated, "test-server");
  const build = await Bun.build({
    entrypoints: [join(project, "tests", "fixtures", "server.ts")],
    target: "bun",
    compile: { outfile: server, autoloadDotenv: false, autoloadBunfig: false },
  });
  if (!build.success) throw new AggregateError(build.logs, "Test server build failed.");

  const variants = [
    {
      name: "JavaScript bundle",
      file: process.execPath,
      args: [join(project, "dist", "cli.js")],
      env: process.env,
    },
    {
      name: "Standalone binary",
      file: binary,
      args: [],
      env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    },
  ];
  for (const variant of variants) {
    const invoke = (...args: string[]) =>
      run(variant.file, [...variant.args, ...args], variant.env);
    assert.match(await invoke("--version"), /^\d+\.\d+\.\d+/);
    const initial = JSON.parse(await invoke("-C", context.repo.root, "list", "--json"));
    assert.equal(initial.worktrees.length, 1);
    const port = freePort();
    await invoke("-C", context.repo.root, "run", "-c", quote([server, String(port)]));
    await eventually(() => connects(port));
    const listed = JSON.parse(await invoke("-C", context.repo.root, "list", "--json"));
    assert.equal(listed.worktrees[0].running, true);
    assert(
      listed.worktrees[0].ports.some(
        (p: { port: number; managed: boolean }) => p.port === port && p.managed,
      ),
    );
    assert.match(await invoke("-C", context.repo.root, "logs"), /Listening/);
    await invoke("-C", context.repo.root, "stop");
    await eventually(async () => !(await connects(port)));
    console.log(`${variant.name}: version → list → run → port → logs → stop passed`);
  }
  console.log("Standalone tested from a separate folder, with no Bun/Node on PATH.");
} finally {
  await context.cleanup();
}
