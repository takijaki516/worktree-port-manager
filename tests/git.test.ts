import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseWorktrees, Repository } from "../src/git.ts";
import { execute } from "../src/system.ts";
import { fixture } from "./helpers.ts";

let context: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  context = await fixture();
});
afterEach(async () => {
  await context.cleanup();
});

test("create, find from a linked worktree, remove and keep the branch", async () => {
  const tree = await context.repo.create({ branch: "feature/login" });
  expect(tree.path.endsWith("feature-login")).toBe(true);
  const linked = await Repository.open(tree.path);
  expect(linked.commonDir).toBe(context.repo.commonDir);
  expect((await linked.find()).path).toBe(tree.path);
  expect(await linked.list()).toHaveLength(2);
  await linked.git(["branch", "--list"]);
  await context.repo.remove(tree);
  expect(await stat(tree.path).catch(() => null)).toBeNull();
  expect(await context.repo.git(["branch", "--list"])).toContain("feature/login");
});

test("main, dirty, and locked worktrees cannot be removed", async () => {
  await expect(context.repo.remove(await context.repo.find())).rejects.toThrow("main worktree");
  const tree = await context.repo.create({ branch: "dirty" });
  const file = join(tree.path, "local.txt");
  await writeFile(file, "keep me");
  await expect(context.repo.remove(tree)).rejects.toThrow("local changes");
  expect(await readFile(file, "utf8")).toBe("keep me");
  await rm(file);
  await context.repo.git(["worktree", "lock", tree.path]);
  await expect(context.repo.remove(tree)).rejects.toThrow("locked");
});

test("unborn repository reports that the first commit is needed", async () => {
  const path = join(context.directory, "empty");
  await execute("git", ["init", path]);
  const repo = await Repository.open(path);
  expect(await repo.list()).toHaveLength(1);
  await expect(repo.create({ branch: "new" })).rejects.toThrow("first commit");
});

test("NUL worktree format preserves newline paths and detached metadata", () => {
  const trees = parseWorktrees(
    'worktree /tmp/a\n"b\0HEAD abc\0branch refs/heads/main\0\0' +
      "worktree /tmp/next\0HEAD def\0detached\0locked reason\0\0",
  );
  expect(trees[0]?.path).toBe('/tmp/a\n"b');
  expect(trees[1]?.branch).toBe("detached");
  expect(trees[1]?.locked).toBe(true);
});

test("existing branch checkout and destination collision", async () => {
  await context.repo.git(["branch", "existing"]);
  const tree = await context.repo.create({ branch: "existing", existing: true });
  expect(tree.branch).toBe("existing");
  await expect(context.repo.create({ branch: "other", path: tree.path })).rejects.toThrow(
    "already exists",
  );
  await expect(context.repo.create({ branch: "--orphan" })).rejects.toThrow("valid branch");
});
