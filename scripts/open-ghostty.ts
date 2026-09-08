import { resolve } from "node:path";

if (process.platform !== "darwin") {
  throw new Error("The Ghostty launcher currently supports macOS only.");
}

const child = Bun.spawn(
  [
    "/usr/bin/open",
    "-na",
    "Ghostty.app",
    "--args",
    "--keybind=performable:super+c=copy_to_clipboard",
    "--keybind=super+v=paste_from_clipboard",
    "--window-save-state=never",
    `--working-directory=${process.cwd()}`,
    "-e",
    process.execPath,
    resolve(import.meta.dir, "../bin/wt"),
    ...process.argv.slice(2),
  ],
  { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
);
process.exitCode = await child.exited;
