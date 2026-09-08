import type { BoxRenderable, TextRenderable } from "@opentui/core";
import type { Controls } from "./controls.ts";
import { color } from "./theme.ts";

export class Notifications {
  private readonly toast: BoxRenderable;
  private readonly status: TextRenderable;
  private toastKind?: "success" | "progress" | "error";
  private toastTimer?: ReturnType<typeof setTimeout>;
  private lastWarning?: string;
  private disposed = false;

  constructor(ui: Controls, parent: BoxRenderable) {
    this.toast = ui.box(parent, "toast", {
      position: "absolute",
      top: 0,
      right: 0,
      width: Math.min(56, ui.renderer.width),
      zIndex: 90,
      border: true,
      borderStyle: "rounded",
      borderColor: color.line,
      backgroundColor: color.raised,
      paddingX: 1,
      visible: false,
    });
    this.status = ui.text(this.toast, "status", "", {
      wrapMode: "word",
      visible: false,
    });
  }

  get hasError(): boolean {
    return this.toastKind === "error";
  }

  resize(width: number): void {
    this.toast.width = Math.min(56, width);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.toastTimer);
  }

  dismiss(): void {
    clearTimeout(this.toastTimer);
    this.toastKind = undefined;
    this.toast.visible = false;
    this.status.visible = false;
  }

  show(message: string, kind: "success" | "progress" | "error" = "success"): void {
    if (this.disposed || !message || (this.toastKind === "error" && kind !== "error")) return;
    clearTimeout(this.toastTimer);
    this.toastKind = kind;
    const prefix = kind === "error" ? "!" : kind === "progress" ? "…" : "✓";
    this.status.content = `${prefix} ${message}${kind === "error" ? "\nEsc Close" : ""}`;
    this.status.fg = kind === "error" ? color.error : color.text;
    this.toast.borderColor = kind === "error" ? color.error : color.line;
    this.toast.visible = true;
    this.status.visible = true;
    if (kind === "success") {
      this.toastTimer = setTimeout(() => this.dismiss(), 3000);
      this.toastTimer.unref();
    }
  }

  warn(warning?: string): void {
    if (warning && warning !== this.lastWarning) this.show(warning, "error");
    this.lastWarning = warning;
  }
}
