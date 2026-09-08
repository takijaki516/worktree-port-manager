import {
  type BoxRenderable,
  type InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
} from "@opentui/core";
import type { BranchRef, CreateOptions, Repository } from "../git.ts";
import { errorMessage } from "../types.ts";
import type { Controls } from "./controls.ts";
import type { Dialog } from "./dialogs.ts";
import { color } from "./theme.ts";

// Keep the displayed branch name separate from its fully qualified Git ref.
export function createBranchPicker(
  ui: Controls,
  dialog: Dialog,
  base: InputRenderable,
  repo: Repository,
  isActive: () => boolean,
): () => Pick<CreateOptions, "base" | "existing"> {
  let existing = false;
  const choices = new ScrollBoxRenderable(ui.renderer, {
    id: "base-branches",
    height: 4,
    flexShrink: 1,
    minHeight: 1,
    scrollX: false,
    backgroundColor: color.raised,
    visible: false,
  });
  dialog.panel.add(choices);
  dialog.focus.push(choices);
  const hint = ui.text(dialog.panel, "base-hint", "Loading local and fetched remote branches…", {
    height: 1,
    fg: color.muted,
  });
  const head: BranchRef = { name: "HEAD", ref: "HEAD", remote: false };
  let branches: BranchRef[] = [head];
  let filtered = branches;
  let selectedBase: BranchRef | undefined = head;
  let cursor = 0;
  let picking = false;
  let rows: BoxRenderable[] = [];
  const closeDropdown = () => {
    if (!choices.visible) return false;
    if (choices.focused) base.focus();
    choices.visible = false;
    choices.focusable = false;
    dialog.panel.height = Math.min(12, ui.renderer.height);
    return true;
  };
  dialog.closeDropdown = closeDropdown;
  choices.focusable = false;
  const highlight = () => {
    for (const [index, row] of rows.entries()) {
      row.backgroundColor = index === cursor ? color.selected : color.raised;
    }
    const row = rows[cursor];
    if (row) choices.scrollChildIntoView(row.id);
  };
  const pick = (index: number) => {
    const choice = filtered[index];
    if (existing || !choice) return;
    picking = true;
    base.value = choice.name;
    picking = false;
    selectedBase = choice;
    cursor = index;
    highlight();
    closeDropdown();
    base.focus();
  };
  const renderBranches = () => {
    for (const child of choices.getChildren()) child.destroyRecursively();
    const query = base.value.trim().toLowerCase();
    filtered = branches.filter(
      (branch) =>
        selectedBase ||
        !query ||
        query === "head" ||
        branch.name.toLowerCase().includes(query) ||
        branch.ref.toLowerCase().includes(query),
    );
    cursor = Math.max(
      0,
      filtered.findIndex((branch) => branch.ref === selectedBase?.ref),
    );
    rows = filtered.map((branch, index) => {
      const row = ui.box(choices, `base-branch:${branch.ref}`, {
        height: 1,
        onMouseUp: (event) => {
          if (event.button === 0 && !ui.isMouseDrag()) pick(index);
        },
      });
      const source =
        branch.ref === "HEAD" ? "current checkout" : branch.remote ? "remote" : "local";
      ui.text(row, `base-branch-label:${branch.ref}`, `${branch.name}  ·  ${source}`, {
        height: 1,
      });
      return row;
    });
    if (!rows.length)
      ui.text(choices, "base-empty", "No matching branches · you can enter a ref or commit.", {
        height: 1,
        fg: color.muted,
      });
    choices.scrollTo(0);
    highlight();
  };
  const openDropdown = () => {
    if (existing) return;
    choices.visible = true;
    choices.focusable = true;
    dialog.panel.height = Math.min(16, ui.renderer.height);
    dialog.panel.top = Math.max(
      0,
      Math.min(
        typeof dialog.panel.top === "number" ? dialog.panel.top : 0,
        ui.renderer.height - dialog.panel.height,
      ),
    );
    renderBranches();
  };
  base.onMouseDown = (event) => {
    if (event.button === 0) openDropdown();
  };
  base.removeAllListeners(InputRenderableEvents.ENTER);
  base.on(InputRenderableEvents.ENTER, () => {
    if (choices.visible) pick(cursor);
    else openDropdown();
  });
  base.on(InputRenderableEvents.INPUT, () => {
    if (picking) return;
    selectedBase = undefined;
    openDropdown();
  });
  base.onKeyDown = (key) => {
    if (key.name === "down" && !existing) {
      key.preventDefault();
      openDropdown();
      choices.focus();
    }
  };
  choices.onKeyDown = (key) => {
    if (existing) return;
    if (key.name === "return" || key.name === "space") {
      key.preventDefault();
      pick(cursor);
    } else if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      cursor = Math.max(0, Math.min(filtered.length - 1, cursor + (key.name === "up" ? -1 : 1)));
      highlight();
    }
  };
  renderBranches();
  void repo
    .branches()
    .then((refs) => {
      if (!isActive()) return;
      branches = [head, ...refs];
      renderBranches();
      if (!existing) hint.content = "Local + fetched remote branches · ↑/↓ then Enter to choose";
    })
    .catch((error) => {
      if (isActive()) dialog.error.content = errorMessage(error);
    });
  ui.button(
    dialog.panel,
    "existing",
    "[ ] Use an existing branch",
    () => {
      existing = !existing;
      closeDropdown();
      const toggle = ui.buttons.get("existing");
      if (toggle) toggle.text.content = `${existing ? "[x]" : "[ ]"} Use an existing branch`;
      base.focusable = !existing;
      base.opacity = choices.opacity = existing ? 0.4 : 1;
      hint.content = existing
        ? "Base is not used when checking out an existing branch."
        : "Local + fetched remote branches · ↑/↓ then Enter to choose";
    },
    false,
    undefined,
    dialog,
  );
  return () => ({
    base: existing ? undefined : (selectedBase?.ref ?? (base.value.trim() || "HEAD")),
    existing,
  });
}
