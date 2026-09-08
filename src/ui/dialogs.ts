import {
  type BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  type Renderable,
  TextRenderable,
} from "@opentui/core";
import type { CreateOptions, Repository } from "../git.ts";
import { errorMessage, type Workspace } from "../types.ts";
import { createBranchPicker } from "./branch-picker.ts";
import type { Controls } from "./controls.ts";
import { color } from "./theme.ts";

export interface Dialog {
  kind: "add" | "run" | "remove" | "project-add";
  overlay: BoxRenderable;
  panel: BoxRenderable;
  fields: Map<string, InputRenderable>;
  focus: Renderable[];
  error: TextRenderable;
  submit: () => void;
  closeDropdown?: () => boolean;
}

// Forms own local input and async loading; the app owns repository operations.
export class Dialogs {
  private modal?: Dialog;
  private disposed = false;

  constructor(
    private readonly ui: Controls,
    private readonly root: BoxRenderable,
    private readonly onOpen: () => void,
    private readonly onClose: () => void,
  ) {}

  get active(): Dialog | undefined {
    return this.modal;
  }

  private get renderer() {
    return this.ui.renderer;
  }

  dispose(): void {
    this.disposed = true;
  }

  private createDialog(kind: Dialog["kind"], title: string, height: number): Dialog {
    this.onOpen();
    const overlay = this.ui.box(this.root, "modal", {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 100,
      backgroundColor: color.overlay,
    });
    const width = Math.min(72, this.renderer.width - 4);
    const panel = this.ui.panel(overlay, "dialog", ` ${title} `, {
      position: "absolute",
      width,
      height: Math.min(height, this.renderer.height),
      top: Math.max(0, Math.floor((this.renderer.height - height) / 2)),
      left: Math.floor((this.renderer.width - width) / 2),
      borderColor: color.accent,
      paddingX: 1,
    });
    const error = new TextRenderable(this.renderer, {
      id: "form-error",
      content: "",
      fg: color.error,
      height: 1,
      selectable: true,
      selectionBg: color.accent,
      selectionFg: color.bg,
    });
    const dialog: Dialog = {
      kind,
      overlay,
      panel,
      error,
      fields: new Map(),
      focus: [],
      submit: () => {},
    };
    this.modal = dialog;
    return dialog;
  }

  private field(
    dialog: Dialog,
    id: string,
    label: string,
    value = "",
    placeholder = "",
    parent = dialog.panel,
  ) {
    this.ui.text(parent, `${id}-label`, label, { height: 1, fg: color.muted });
    const input = new InputRenderable(this.renderer, {
      id,
      value,
      placeholder,
      width: "100%",
      marginBottom: 0,
      backgroundColor: color.raised,
      focusedBackgroundColor: color.selected,
      textColor: color.text,
    });
    parent.add(input);
    dialog.fields.set(id, input);
    dialog.focus.push(input);
    input.on(InputRenderableEvents.ENTER, () => dialog.submit());
    return input;
  }

  private dialogActions(dialog: Dialog, label: string): void {
    dialog.panel.add(dialog.error);
    const actions = this.ui.box(dialog.panel, "dialog-actions", {
      height: 1,
      flexDirection: "row",
      gap: 1,
    });
    this.ui.button(actions, "cancel", "Cancel", () => this.close(), false, undefined, dialog);
    this.ui.button(actions, "submit", label, () => dialog.submit(), true, undefined, dialog);
    dialog.focus[0]?.focus();
  }

  close(): void {
    this.modal?.overlay.destroyRecursively();
    this.modal = undefined;
    for (const id of ["cancel", "submit", "existing", "project-browse"]) this.ui.buttons.delete(id);
    this.onClose();
  }

  openProjectAdd(
    pickFolder: (() => Promise<string | undefined>) | undefined,
    onSubmit: (path: string, dialog: Dialog) => Promise<void>,
  ): void {
    const dialog = this.createDialog("project-add", "Add project", 7);
    const row = this.ui.box(dialog.panel, "project-path-row", {
      height: 2,
      flexDirection: "row",
      gap: 1,
    });
    const pathColumn = this.ui.box(row, "project-path-column", {
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 0,
      flexDirection: "column",
    });
    const path = this.field(
      dialog,
      "project-path",
      "Local Git repository path",
      "",
      "~/code/my-project",
      pathColumn,
    );
    let picking = false;
    if (pickFolder) {
      const browse = this.ui.button(
        row,
        "project-browse",
        "Choose folder…",
        () => {
          if (picking) return;
          picking = true;
          dialog.error.content = "";
          this.ui.enable("project-browse", false);
          this.ui.enable("submit", false);
          void pickFolder()
            .then((selected) => {
              if (this.disposed || this.modal !== dialog) return;
              if (selected !== undefined) path.value = selected;
            })
            .catch((error) => {
              if (!this.disposed && this.modal === dialog)
                dialog.error.content = errorMessage(error);
            })
            .finally(() => {
              picking = false;
              if (this.disposed || this.modal !== dialog) return;
              this.ui.enable("project-browse", true);
              this.ui.enable("submit", true);
              path.focus();
            });
        },
        false,
        16,
        dialog,
      );
      browse.marginTop = 1;
    }
    this.ui.text(
      dialog.panel,
      "project-hint",
      "Register an existing repository. Its files stay in place.",
      { height: 1, fg: color.muted },
    );
    dialog.submit = () => {
      if (picking) return;
      if (!path.value.trim()) {
        dialog.error.content = "Enter a repository path.";
        return;
      }
      void onSubmit(path.value.trim(), dialog);
    };
    this.dialogActions(dialog, "Add & switch");
  }

  openAdd(repo: Repository, onSubmit: (options: CreateOptions) => void): void {
    const dialog = this.createDialog("add", "New worktree", 12);
    const branch = this.field(dialog, "branch", "Branch", "", "feature/login");
    const path = this.field(
      dialog,
      "path",
      "Directory · optional",
      "",
      "Default: ~/.worktree-managers/<project>/<branch>",
    );
    const base = this.field(
      dialog,
      "base",
      "Base branch / ref ▾ · click or ↓ to open, type to filter",
      "HEAD",
    );
    const selection = createBranchPicker(
      this.ui,
      dialog,
      base,
      repo,
      () => this.modal === dialog && !this.disposed,
    );
    dialog.submit = () => {
      if (!branch.value.trim()) {
        dialog.error.content = "Enter a branch name.";
        return;
      }
      const options = {
        branch: branch.value.trim(),
        path: path.value.trim() || undefined,
        ...selection(),
      };
      onSubmit(options);
    };
    this.dialogActions(dialog, "Create worktree");
  }

  openRun(
    ws: Workspace,
    defaultCommand: string,
    onSubmit: (command: string, port?: number) => void,
  ): void {
    const dialog = this.createDialog("run", "Run development server", 11);
    this.ui.text(dialog.panel, "run-branch", ws.tree.branch, { height: 1, fg: color.accent });
    const command = this.field(
      dialog,
      "command-input",
      "Shell command · saved as project default",
      defaultCommand,
      "pnpm dev",
    );
    const port = this.field(
      dialog,
      "port-input",
      "PORT environment variable · optional",
      ws.run?.port ? String(ws.run.port) : "",
      "3000",
    );
    this.ui.text(
      dialog.panel,
      "run-hint",
      "Checks availability and sets PORT. Your command must use it,\nor add its own --port flag. Servers keep running when you quit.",
      { height: 2, fg: color.muted },
    );
    dialog.submit = () => {
      const raw = port.value.trim();
      const selectedPort = raw ? Number(raw) : undefined;
      if (!command.value.trim()) {
        dialog.error.content = "Enter a server command.";
        return;
      }
      if (
        selectedPort !== undefined &&
        (!/^\d+$/.test(raw) || selectedPort < 1 || selectedPort > 65535)
      ) {
        dialog.error.content = "Port must be between 1 and 65535.";
        return;
      }
      const value = command.value.trim();
      onSubmit(value, selectedPort);
    };
    this.dialogActions(dialog, "Run server");
  }

  openRemove(ws: Workspace, onSubmit: () => void): void {
    const dialog = this.createDialog("remove", "Remove worktree?", 10);
    this.ui.text(
      dialog.panel,
      "remove-description",
      `${ws.tree.branch}\n${ws.tree.path}\n\nThe directory will be removed. The Git branch will be kept.`,
      { height: 6 },
    );
    dialog.submit = onSubmit;
    this.dialogActions(dialog, "Remove worktree");
  }
}
