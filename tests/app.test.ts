import { afterEach, beforeEach, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { InputRenderable, Renderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { WorktreeApp } from "../src/app.ts";
import { Projects } from "../src/projects.ts";
import { eventually, fixture, freePort, seedBaseBranches, serverCommand } from "./helpers.ts";

let context: Awaited<ReturnType<typeof fixture>>;
let terminal: TestRendererSetup;
let app: WorktreeApp;
beforeEach(async () => {
  context = await fixture();
  terminal = await createTestRenderer({ width: 120, height: 38 });
  app = new WorktreeApp(context.manager, terminal.renderer);
  await app.start();
  await terminal.renderOnce();
});
afterEach(async () => {
  app.dispose();
  terminal.renderer.destroy();
  await context.cleanup();
});

function element(id: string): Renderable {
  const node = terminal.renderer.root.findDescendantById(id);
  if (!(node instanceof Renderable)) throw new Error(`Missing renderable: ${id}`);
  return node;
}

async function click(id: string) {
  await terminal.renderOnce();
  const node = element(id);
  await terminal.mockMouse.click(
    node.x + Math.min(2, node.width - 1),
    node.y + Math.min(1, node.height - 1),
  );
  await terminal.renderOnce();
}

function fill(id: string, value: string) {
  const node = element(id);
  if (!(node instanceof InputRenderable)) throw new Error(`Not an input: ${id}`);
  node.value = value;
}

async function idle(predicate: () => boolean) {
  await eventually(async () => {
    await terminal.renderOnce();
    return !app.busy && predicate();
  });
}

test("mouse creates, selects, cancels deletion, and removes a worktree", async () => {
  await click("add");
  expect(app.modal?.kind).toBe("add");
  fill("branch", "feature/mouse");
  await click("submit");
  await idle(() => app.workspaces.length === 2);
  const tree = await context.repo.find("feature/mouse");
  await click(`tree:${context.repo.root}`);
  expect(app.current?.tree.branch).toBe("main");
  await click(`tree:${tree.path}`);
  expect(app.current?.tree.branch).toBe("feature/mouse");
  await click("remove");
  expect(app.modal?.kind).toBe("remove");
  await click("cancel");
  expect((await stat(tree.path)).isDirectory()).toBe(true);
  await click("remove");
  await click("submit");
  await idle(() => app.workspaces.length === 1);
  expect(await stat(tree.path).catch(() => null)).toBeNull();
  expect(terminal.captureCharFrame()).not.toContain("feature/mouse");
});

test("mouse starts a server, displays a live port, opens selected URL, and stops", async () => {
  const port = freePort();
  const opened: string[] = [];
  context.manager.openBrowser = async (url) => {
    opened.push(url);
  };
  await click("run");
  await eventually(() => app.modal?.kind === "run");
  fill("command-input", serverCommand(port));
  fill("port-input", String(port));
  await click("submit");
  await idle(() => Boolean(app.current?.running && app.current.ports.length));
  expect(terminal.captureCharFrame()).toContain(String(port));
  expect(terminal.captureCharFrame()).toContain("Managed");
  await click("browser");
  await idle(() => opened.length === 1);
  expect(opened).toEqual([`http://localhost:${port}`]);
  await click("stop");
  await idle(() => !app.current?.running);
  expect(app.current?.ports).toHaveLength(0);
});

test("Open in Codex uses the selected worktree and displays launcher errors", async () => {
  const tree = await context.repo.create({ branch: "open-codex" });
  await app.refresh();
  await click(`tree:${tree.path}`);
  const opened: string[] = [];
  context.manager.openCodex = async (selected) => {
    opened.push(selected.path);
  };
  await click("codex");
  await idle(() => opened.length === 1);
  expect(opened).toEqual([tree.path]);
  expect(terminal.captureCharFrame()).toContain("Opened in Codex");
  context.manager.openCodex = async () => {
    throw new Error("Codex CLI not found");
  };
  element("codex").focus();
  terminal.mockInput.pressEnter();
  await idle(() => terminal.captureCharFrame().includes("Codex CLI not found"));
});

test("small terminal keeps input isolated from shortcuts and supports Tab and mouse scrolling", async () => {
  terminal.resize(80, 24);
  await terminal.renderOnce();
  terminal.mockInput.pressKey("r");
  await eventually(() => app.modal?.kind === "run");
  await terminal.mockInput.typeText("qnr");
  const input = element("command-input");
  expect(input instanceof InputRenderable && input.value).toBe("qnr");
  terminal.mockInput.pressTab();
  expect(terminal.renderer.currentFocusedRenderable?.id).toBe("port-input");
  terminal.mockInput.pressEscape();
  await eventually(() => !app.modal);
  expect(Boolean(app.modal)).toBe(false);
  await terminal.mockMouse.scroll(76, 18, "down");
  await terminal.renderOnce();
  terminal.mockInput.pressKey("n");
  await terminal.renderOnce();
  expect(app.modal?.kind).toBe("add");
  expect(element("submit").y + element("submit").height).toBeLessThanOrEqual(24);
  terminal.mockInput.pressEscape();
  await eventually(() => !app.modal);
  expect(Boolean(app.modal)).toBe(false);
});

test("mouse selects a local base and a filtered remote base, including ambiguous names", async () => {
  const baseHead = await seedBaseBranches(context.repo);
  // The remote selection must use its full ref even if a local name is identical.
  await context.repo.git(["branch", "origin/release"]);
  for (const [index, ref] of ["refs/heads/develop", "refs/remotes/origin/release"].entries()) {
    await click("add");
    await eventually(() =>
      Boolean(terminal.renderer.root.findDescendantById(`base-branch:${ref}`)),
    );
    fill("branch", `selected-base-${index}`);
    expect(element("base-branches").visible).toBe(false);
    await click("base");
    expect(element("base-branches").visible).toBe(true);
    if (index === 1) fill("base", "origin/release");
    await click(`base-branch:${ref}`);
    expect(element("base-branches").visible).toBe(false);
    expect(app.modal?.kind).toBe("add");
    await click("submit");
    await idle(() => app.workspaces.length === index + 2);
    expect((await context.repo.find(`selected-base-${index}`)).head).toBe(baseHead);
  }
});

test("base list scrolls and keyboard selection works in a small terminal", async () => {
  const baseHead = await seedBaseBranches(context.repo);
  for (let index = 0; index < 8; index++) await context.repo.git(["branch", `feature/${index}`]);
  terminal.resize(80, 24);
  await click("add");
  await eventually(() =>
    Boolean(terminal.renderer.root.findDescendantById("base-branch:refs/remotes/origin/release")),
  );
  fill("branch", "keyboard-base");
  await click("base");
  await terminal.renderOnce();
  const list = element("base-branches");
  if (!(list instanceof ScrollBoxRenderable)) throw new Error("Missing branch list");
  await terminal.mockMouse.scroll(list.x + 2, list.y + 1, "down");
  await terminal.renderOnce();
  expect(list.scrollTop).toBeGreaterThan(0);
  await click("base");
  fill("base", "origin/rel");
  terminal.mockInput.pressArrow("down");
  expect(terminal.renderer.currentFocusedRenderable?.id).toBe("base-branches");
  terminal.mockInput.pressEnter();
  expect(app.modal?.kind).toBe("add");
  const base = element("base");
  expect(base instanceof InputRenderable && base.value).toBe("origin/release");
  expect(element("base-branches").visible).toBe(false);
  expect(element("submit").y + element("submit").height).toBeLessThanOrEqual(24);
  await click("submit");
  await idle(() => app.workspaces.length === 2);
  expect((await context.repo.find("keyboard-base")).head).toBe(baseHead);
});

test("base dropdown reopens with all options and Escape and Tab dismiss it", async () => {
  await seedBaseBranches(context.repo);
  await click("add");
  await eventually(() =>
    Boolean(terminal.renderer.root.findDescendantById("base-branch:refs/heads/develop")),
  );
  await click("base");
  fill("base", "develop");
  await click("base-branch:refs/heads/develop");
  expect(element("base-branches").visible).toBe(false);
  terminal.mockInput.pressArrow("down");
  await terminal.renderOnce();
  expect(element("base-branches").visible).toBe(true);
  expect(element("base-branch:refs/remotes/origin/release")).toBeDefined();
  terminal.mockInput.pressEscape();
  await eventually(() => !element("base-branches").visible);
  expect(app.modal?.kind).toBe("add");
  expect(element("base-branches").visible).toBe(false);
  expect(terminal.renderer.currentFocusedRenderable?.id).toBe("base");
  terminal.mockInput.pressEnter();
  expect(element("base-branches").visible).toBe(true);
  terminal.mockInput.pressTab();
  expect(element("base-branches").visible).toBe(false);
  expect(terminal.renderer.currentFocusedRenderable?.id).toBe("existing");
  terminal.mockInput.pressEscape();
  await eventually(() => !app.modal);
  expect(app.modal).toBeUndefined();
});

test("existing branch mode disables and skips base selection", async () => {
  const baseHead = await seedBaseBranches(context.repo);
  await click("add");
  await eventually(() =>
    Boolean(terminal.renderer.root.findDescendantById("base-branch:refs/heads/develop")),
  );
  fill("branch", "develop");
  fill("base", "invalid-ref");
  await click("existing");
  expect(element("base").focusable).toBe(false);
  expect(element("base-branches").focusable).toBe(false);
  await click("path");
  terminal.mockInput.pressTab();
  expect(terminal.renderer.currentFocusedRenderable?.id).toBe("existing");
  await click("submit");
  await idle(() => app.workspaces.length === 2);
  expect((await context.repo.find("develop")).head).toBe(baseHead);
});

test("mouse selects text and panel titles, and copies without activating buttons", async () => {
  const copied: string[] = [];
  terminal.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text);
    return true;
  };
  for (const id of ["repo", "tree-panel-title", "details", "logs-title", "log-text", "add-label"]) {
    await terminal.renderOnce();
    const node = element(id);
    await terminal.mockMouse.drag(node.x, node.y, node.x + 5, node.y);
    const selected = terminal.renderer.getSelection()?.getSelectedText();
    expect(selected?.trim().length).toBeGreaterThan(0);
    expect(app.modal).toBeUndefined();
    terminal.mockInput.pressKey("y", { ctrl: true });
    expect(copied.at(-1)).toBe(selected);
    terminal.renderer.clearSelection();
  }
  await click("add");
  expect(app.modal?.kind).toBe("add");
  const title = element("dialog-title");
  await terminal.mockMouse.drag(title.x, title.y, title.x + 5, title.y);
  expect(terminal.renderer.getSelection()?.getSelectedText()).toContain("New");
  fill("branch", "feature/selection");
  const input = element("branch");
  await terminal.mockMouse.drag(input.x, input.y, input.x + 7, input.y);
  expect(terminal.renderer.getSelection()?.getSelectedText()).toContain("feature");
  terminal.mockInput.pressKey("y", { ctrl: true });
  expect(copied.at(-1)).toContain("feature");
});

test("dragging a worktree label does not change the selected worktree", async () => {
  const tree = await context.repo.create({ branch: "feature/selection" });
  await app.refresh();
  await terminal.renderOnce();
  const node = element(`tree-text:${tree.path}`);
  await terminal.mockMouse.drag(node.x, node.y, node.x + 7, node.y);
  expect(terminal.renderer.getSelection()?.getSelectedText()).toContain("feature");
  expect(app.current?.tree.branch).toBe("main");
  terminal.renderer.clearSelection();
  await click(`tree:${tree.path}`);
  expect(app.current?.tree.branch).toBe("feature/selection");
});

test("projects remain visible beside worktrees and stack above them in a narrow terminal", async () => {
  expect(element("project-panel").x).toBeLessThan(element("tree-panel").x);
  expect(element("project-panel").y).toBe(element("tree-panel").y);
  expect(element("tree-panel").y).toBe(element("detail-panel").y);
  expect(terminal.captureCharFrame()).toContain("PROJECTS (1)");
  terminal.mockInput.pressKey("p");
  expect(app.modal).toBeUndefined();
  expect(terminal.renderer.currentFocusedRenderable?.id).toBe(
    `project-choice:${context.repo.commonDir}`,
  );
  terminal.resize(80, 24);
  await terminal.renderOnce();
  expect(element("project-panel").y + element("project-panel").height).toBeLessThan(
    element("tree-panel").y,
  );
  expect(element("tree-panel").y + element("tree-panel").height).toBeLessThan(
    element("detail-panel").y,
  );
  await click("project-add");
  expect(app.modal?.kind).toBe("project-add");
});

test("projects can be added, switched, and used to create worktrees without stopping servers", async () => {
  const otherPath = join(context.directory, "other-project");
  await context.repo.git(["clone", "--", context.repo.root, otherPath]);
  await context.manager.start(await context.repo.find(), serverCommand(freePort()));
  await click("project-add");
  fill("project-path", otherPath);
  await click("submit");
  await idle(() => !app.modal && app.manager.repo.root === otherPath);
  expect(app.projects).toHaveLength(2);
  expect(app.current?.running).toBe(false);
  await click("add");
  fill("branch", "feature/other-project");
  await click("submit");
  await idle(() => app.workspaces.length === 2);
  expect(await context.repo.list()).toHaveLength(1);
  expect(app.current?.tree.path).toContain("other-project/feature--other-project");
  const oldSnapshot = await app.manager.snapshot();
  let releaseSnapshot: (snapshot: typeof oldSnapshot) => void = () => {};
  app.manager.snapshot = () =>
    new Promise((resolve) => {
      releaseSnapshot = resolve;
    });
  const pendingRefresh = app.refresh();
  await click(`project-choice:${context.repo.commonDir}`);
  await idle(() => !app.modal && app.manager.repo.commonDir === context.repo.commonDir);
  releaseSnapshot(oldSnapshot);
  await pendingRefresh;
  expect(app.workspaces).toHaveLength(1);
  expect(app.current?.running).toBe(true);
  expect(await new Projects(context.repo.worktreeDirectory).list()).toHaveLength(2);
});

test("folder selection fills the path and requires explicit project submission", async () => {
  app.dispose();
  terminal.renderer.destroy();
  terminal = await createTestRenderer({ width: 120, height: 38 });
  let resolvePicker!: (path: string | undefined) => void;
  let calls = 0;
  app = new WorktreeApp(context.manager, terminal.renderer, undefined, () => {
    calls++;
    return new Promise((resolve) => {
      resolvePicker = resolve;
    });
  });
  await app.start();
  await click("project-add");
  fill("project-path", "previous path");
  await click("project-browse");
  await click("project-browse");
  await click("submit");
  expect(calls).toBe(1);
  expect(app.modal?.kind).toBe("project-add");
  resolvePicker(context.repo.root);
  await eventually(() => (element("project-path") as InputRenderable).value === context.repo.root);
  expect(app.modal?.kind).toBe("project-add");
  expect(terminal.renderer.currentFocusedRenderable?.id).toBe("project-path");
  await click("submit");
  await idle(() => !app.modal);
});

test("folder picker cancellation and errors preserve input; late results do not change a new dialog", async () => {
  app.dispose();
  terminal.renderer.destroy();
  terminal = await createTestRenderer({ width: 120, height: 38 });
  let resolvePicker!: (path: string | undefined) => void;
  let rejectPicker!: (error: Error) => void;
  app = new WorktreeApp(
    context.manager,
    terminal.renderer,
    undefined,
    () =>
      new Promise((resolve, reject) => {
        resolvePicker = resolve;
        rejectPicker = reject;
      }),
  );
  await app.start();
  await click("project-add");
  fill("project-path", "keep this path");
  await click("project-browse");
  resolvePicker(undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await eventually(() => terminal.renderer.currentFocusedRenderable?.id === "project-path");
  expect((element("project-path") as InputRenderable).value).toBe("keep this path");
  element("project-browse").focus();
  await terminal.mockInput.pressKey("RETURN");
  rejectPicker(new Error("Picker unavailable"));
  await eventually(async () => {
    await terminal.renderOnce();
    return terminal.captureCharFrame().includes("Picker unavailable");
  });
  expect((element("project-path") as InputRenderable).value).toBe("keep this path");
  element("project-browse").focus();
  await terminal.mockInput.pressKey("RETURN");
  await click("cancel");
  await click("project-add");
  fill("project-path", "new dialog path");
  resolvePicker(context.repo.root);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((element("project-path") as InputRenderable).value).toBe("new dialog path");
});

test("invalid project paths keep the active project and show an error", async () => {
  await click("project-add");
  fill("project-path", context.directory);
  await click("submit");
  await idle(() => terminal.captureCharFrame().includes("not a git repository"));
  expect(app.modal?.kind).toBe("project-add");
  expect(app.manager).toBe(context.manager);
  expect(app.projects).toHaveLength(1);
  await click("cancel");
});

test("an empty app can register its first project and restore it after restart", async () => {
  app.dispose();
  terminal.renderer.destroy();
  const projects = new Projects(join(context.directory, "empty-projects"));
  terminal = await createTestRenderer({ width: 80, height: 24 });
  app = new WorktreeApp(undefined, terminal.renderer, projects);
  await app.start();
  await terminal.renderOnce();
  expect(terminal.captureCharFrame()).toContain("No project selected");
  await click("project-add");
  fill("project-path", context.repo.root);
  await click("submit");
  await idle(() => !app.modal && app.workspaces.length === 1);
  expect(app.manager.repo.commonDir).toBe(context.repo.commonDir);
  app.dispose();
  terminal.renderer.destroy();
  terminal = await createTestRenderer({ width: 120, height: 38 });
  app = new WorktreeApp(undefined, terminal.renderer, new Projects(projects.directory));
  await app.start();
  expect(app.manager.repo.commonDir).toBe(context.repo.commonDir);
  expect(app.projects).toHaveLength(1);
});
