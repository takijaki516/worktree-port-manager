import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InputRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { WorktreeApp } from "../src/app.ts";
import { eventually, fixture, seedBaseBranches } from "../tests/helpers.ts";

// Pass an earlier checkout's src/app.ts; both versions use the same fixtures
// and OpenTUI version so paths, colors, and focus can be compared exactly.
const baseline = process.argv[2];
if (!baseline) throw new Error("Usage: bun scripts/verify-ui-compatibility.ts <old-src/app.ts>");
const previous: typeof WorktreeApp = (await import(pathToFileURL(resolve(baseline)).href))
  .WorktreeApp;
const context = await fixture();

try {
  await seedBaseBranches(context.repo);
  const tree = await context.repo.create({ branch: "feature/화면-compatibility-long-branch-name" });

  async function capture(App: typeof WorktreeApp, width: number, height: number) {
    const terminal = await createTestRenderer({ width, height });
    const app = new App(context.manager, terminal.renderer);
    const frames = new Map<string, unknown>();
    const element = (id: string) => {
      const node = terminal.renderer.root.findDescendantById(id);
      assert(node, `Missing renderable: ${id}`);
      return node;
    };
    const record = async (name: string) => {
      await terminal.renderOnce();
      frames.set(name, {
        frame: terminal.captureSpans(),
        focused: terminal.renderer.currentFocusedRenderable?.id,
        selected: app.selected,
        modal: app.modal?.kind,
      });
    };
    const click = async (id: string) => {
      await terminal.renderOnce();
      const node = element(id);
      await terminal.mockMouse.click(node.x + Math.min(2, node.width - 1), node.y);
    };
    try {
      await app.start();
      await record("initial");
      app.openProjects();
      terminal.mockInput.pressArrow("left");
      await record("collapsed");
      terminal.mockInput.pressArrow("right");
      app.selectTree(tree.path);
      await app.refresh();
      await record("selected worktree");

      app.openAdd();
      await eventually(() =>
        Boolean(terminal.renderer.root.findDescendantById("base-branch:refs/heads/develop")),
      );
      await record("new worktree");
      await click("base");
      await record("base choices");
      const base = element("base");
      assert(base instanceof InputRenderable);
      base.value = "origin/rel";
      await record("filtered base choices");
      terminal.mockInput.pressArrow("down");
      terminal.mockInput.pressEnter();
      await record("selected remote base");
      await click("existing");
      await record("existing branch");
      app.closeModal();

      await app.openRun();
      await record("run server");
      app.modal?.submit();
      await record("command validation");
      app.closeModal();
      app.openRemove();
      await record("remove confirmation");
      app.closeModal();
      app.openProjectAdd();
      await record("add project");
      app.modal?.submit();
      await record("project validation");
      app.closeModal();

      await app.perform(async () => {}, "Completed");
      await record("success notification");
      await app.perform(async () => {
        throw new Error("Example failure");
      }, "Unused");
      await record("error notification");
      terminal.mockInput.pressEscape();
      await record("dismissed notification");

      if (width >= 95) {
        const panel = element("project-panel");
        await terminal.mockMouse.pressDown(panel.x + panel.width - 1, panel.y + 5);
        await terminal.mockMouse.emitMouseEvent("drag", 19, panel.y + 6);
        await terminal.mockMouse.release(19, panel.y + 6);
        await record("resized panels");
        const label = element(`tree-text:${tree.path}`);
        await terminal.mockMouse.moveTo(label.x + 3, label.y);
        await record("branch tooltip");
        terminal.resize(80, 24);
        await record("narrow after resizing");
        terminal.resize(width, height);
        await record("restored panel ratio");
      }
      return frames;
    } finally {
      app.dispose();
      terminal.renderer.destroy();
    }
  }

  let compared = 0;
  for (const [width, height] of [
    [80, 24],
    [94, 30],
    [95, 30],
    [120, 38],
    [160, 48],
  ] as const) {
    const before = await capture(previous, width, height);
    const after = await capture(WorktreeApp, width, height);
    assert.deepEqual([...after.keys()], [...before.keys()]);
    for (const [scene, frame] of before) {
      assert.deepEqual(after.get(scene), frame, `${width}×${height}: ${scene}`);
      compared++;
    }
    console.log(
      `${width}×${height}: ${before.size} scenes match (text, colors, cursor, focus, selection)`,
    );
  }
  console.log(`${compared} baseline/current screen comparisons passed.`);
} finally {
  await context.cleanup();
}
