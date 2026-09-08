import { writeSync } from "node:fs";
import type { CliRenderer } from "@opentui/core";

export class ResizePointer {
  private active = false;

  constructor(
    private readonly renderer: Pick<CliRenderer, "setMousePointer">,
    private readonly ghostty = Boolean(
      process.stdout.isTTY &&
        (process.env.TERM_PROGRAM === "ghostty" || process.env.TERM === "xterm-ghostty"),
    ),
    private readonly write = (sequence: string) => {
      // Bypass OpenTUI's stdout log capture for terminal control sequences.
      writeSync(process.stdout.fd, sequence);
    },
  ) {}

  set(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (this.ghostty) {
      // macOS Ghostty ignores "move"; OpenTUI 0.5.10 cannot encode "ew-resize".
      this.write(`\x1b]22;${active ? "ew-resize" : "default"}\x07`);
    } else {
      this.renderer.setMousePointer(active ? "pointer" : "default");
    }
  }
}
