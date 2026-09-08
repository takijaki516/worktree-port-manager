import { execute } from "./system.ts";
import { WorktreeError } from "./types.ts";

// Handle cancellation in AppleScript so it cannot be confused with a launch failure.
const script = `
try
  activate
  set selectedFolder to choose folder with prompt "Select a Git repository"
  return POSIX path of selectedFolder
on error number -128
  return ""
end try
`;

export async function chooseFolder(): Promise<string | undefined> {
  const result = await execute("/usr/bin/osascript", ["-e", script], 0);
  if (result.code !== 0) {
    throw new WorktreeError("Could not open the folder picker. Enter a repository path manually.");
  }
  // osascript appends one newline; preserve whitespace in the actual folder name.
  return result.stdout.replace(/\r?\n$/, "") || undefined;
}
