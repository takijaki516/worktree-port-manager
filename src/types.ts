export class WorktreeError extends Error {}

export interface Worktree {
  path: string;
  branch: string;
  head: string;
  main: boolean;
  locked: boolean;
  prunable: boolean;
  dirty: boolean;
  statusError?: string;
}

// Existing Python state files keep their field names and remain readable.
export interface RunRecord {
  pid: number;
  started_at?: string;
  created_at?: number;
  command: string;
  log: string;
  result: string;
  port?: number | null;
  control?: string;
  token?: string;
}

export interface State {
  command: string;
  runs: Record<string, RunRecord>;
}

export interface RunResult {
  exit_code: number;
  stopped: boolean;
  finished_at: number;
}

export interface Port {
  pid: number;
  name: string;
  host: string;
  port: number;
  managed: boolean;
}

export interface Workspace {
  tree: Worktree;
  ports: Port[];
  run?: RunRecord;
  running: boolean;
  exit_code?: number;
  stopped: boolean;
  status: string;
}

export interface Snapshot {
  worktrees: Workspace[];
  warning: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
