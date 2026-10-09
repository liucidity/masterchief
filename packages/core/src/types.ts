export type MissionType = 'build' | 'investigate';
export type MissionStatus =
  | 'planning'
  | 'running'
  | 'blocked'
  | 'paused'
  | 'done'
  | 'aborted';
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';
export type TaskKind = 'ship' | 'sentinel';
export type DeliveryMode = 'no-mistakes' | 'direct-pr' | 'local-only';
export type AgentRole = 'commander' | 'pilot' | 'sentinel' | 'cortana';
/** Semantic state of a terminal agent. Unknown is never promoted to idle or busy. */
export type AgentState = 'starting' | 'busy' | 'idle' | 'unknown' | 'dead' | 'retired';
export type CortanaRoute = 'local';
export type WorkspaceAccess = 'rw' | 'ro';
export type Verdict = 'approve' | 'reject' | 'escalate';

export interface Project {
  id: string;
  path: string;
  defaultBranch: string;
  repoUrl: string | null;
  deliveryMode: DeliveryMode;
}

export interface Mission {
  id: string;
  projectId: string;
  type: MissionType;
  goal: string;
  status: MissionStatus;
  branch: string;
  budget: number | null;
}

export interface Task {
  id: string;
  missionId: string;
  title: string;
  kind: TaskKind;
  deliveryMode: DeliveryMode;
  agentId: string | null;
  status: TaskStatus;
  dependsOn: string[];
}

export interface Agent {
  id: string;
  role: AgentRole;
  harness: string;
  model: string | null;
  effort: string | null;
  /** Terminal window the agent runs in; null until launched. */
  endpoint: string | null;
  workspaceId: string | null;
  state: AgentState;
  permanent: boolean;
  /** Incarnation token of the current launch; hook events from other launches are ignored. */
  gen: string | null;
  hookLog: string | null;
  /** Port/temp-dir slot while the agent is live. */
  slot: number | null;
}

export interface Workspace {
  id: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  access: WorkspaceAccess;
}

export interface Review {
  id: string;
  missionId: string;
  /** The task the verdict is about, when it is about one. */
  taskId: string | null;
  by: 'cortana' | 'commander';
  verdict: Verdict;
  notes: string;
}

export interface Finding {
  id: string;
  missionId: string;
  claim: string;
  evidence: string;
  confidence: number;
}

export interface Event {
  id: string;
  missionId: string | null;
  agentId: string | null;
  kind: string;
  payload: unknown;
  ts: number;
}

/** A persistent second mate (Cortana) with its own scope, projects and home. */
export interface CortanaHome {
  id: string;
  scope: string;
  projects: string[];
  homePath: string;
  route: CortanaRoute;
  harness: string | null;
}
