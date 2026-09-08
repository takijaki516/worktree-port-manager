import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Repository } from "../src/git.ts";
import { Projects } from "../src/projects.ts";
import { fixture } from "./helpers.ts";

let context: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  context = await fixture();
});
afterEach(async () => {
  await context.cleanup();
});

test("projects persist and linked worktrees register only once", async () => {
  const projects = new Projects(context.repo.worktreeDirectory);
  expect(await projects.list()).toEqual([]);
  await projects.add(context.repo);
  const tree = await context.repo.create({ branch: "feature/project" });
  await projects.add(await Repository.open(tree.path, context.repo.worktreeDirectory));
  expect(await new Projects(projects.directory).list()).toEqual([
    {
      name: "repo with spaces",
      path: context.repo.root,
      commonDir: context.repo.commonDir,
    },
  ]);
});

test("a stale linked worktree gitdir does not block project registration or snapshots", async () => {
  const tree = await context.repo.create({ branch: "stale-link" });
  await writeFile(
    join(tree.path, ".git"),
    `gitdir: ${context.directory}/old-location/.git/worktrees/stale-link\n`,
  );
  const snapshot = await context.manager.snapshot();
  expect(snapshot.worktrees).toHaveLength(2);
  expect(snapshot.warning).toContain("not a git repository");
  const broken = snapshot.worktrees.find((ws) => ws.tree.path === tree.path);
  expect(broken?.status).toBe("Git error");
  const projects = new Projects(context.repo.worktreeDirectory);
  expect(await projects.add(context.repo)).toHaveLength(1);
  await expect(context.manager.start(tree, "echo test")).rejects.toThrow("not a git repository");
  await expect(context.repo.remove(tree)).rejects.toThrow("not a git repository");
  await context.repo.git(["worktree", "repair", tree.path]);
  const repaired = await context.manager.snapshot();
  expect(repaired.worktrees.find((ws) => ws.tree.path === tree.path)?.status).toBe("Idle");
});

test("concurrent registrations retain same-named repositories as separate projects", async () => {
  const path = join(context.directory, "other", "repo with spaces");
  await context.repo.git(["clone", "--", context.repo.root, path]);
  const other = await Repository.open(path, context.repo.worktreeDirectory);
  const projects = new Projects(context.repo.worktreeDirectory);
  await Promise.all([projects.add(context.repo), new Projects(projects.directory).add(other)]);
  const saved = await projects.list();
  expect(saved).toHaveLength(2);
  expect(new Set(saved.map((project) => project.path)).size).toBe(2);
});

test("malformed project data is reported and never overwritten", async () => {
  const projects = new Projects(context.repo.worktreeDirectory);
  await projects.add(context.repo);
  await writeFile(projects.path, "{}");
  await expect(projects.add(context.repo)).rejects.toThrow("Cannot read projects");
  await expect(projects.list()).rejects.toThrow("Cannot read projects");
});
