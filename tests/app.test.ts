import { afterEach, beforeEach, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { InputRenderable, Renderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { WorktreeApp } from "../src/app.ts";
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
    if (index === 1) fill("base", "origin/release");
    await click(`base-branch:${ref}`);
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
  expect(element("submit").y + element("submit").height).toBeLessThanOrEqual(24);
  await click("submit");
  await idle(() => app.workspaces.length === 2);
  expect((await context.repo.find("keyboard-base")).head).toBe(baseHead);
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
