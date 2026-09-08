import { expect, test } from "bun:test";
import { ResizePointer } from "../src/resize-pointer.ts";

test("Ghostty receives a supported horizontal resize shape and an explicit reset", () => {
  const output: string[] = [];
  const pointer = new ResizePointer(
    {
      setMousePointer: () => {
        throw new Error("OpenTUI cannot encode ew-resize");
      },
    },
    true,
    (sequence) => {
      output.push(sequence);
    },
  );
  pointer.set(true);
  pointer.set(true);
  pointer.set(false);
  expect(output).toEqual(["\x1b]22;ew-resize\x07", "\x1b]22;default\x07"]);
});
