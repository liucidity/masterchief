export type MissionType = 'build' | 'investigate';
export type MissionStatus =
  | 'planning'
  | 'running'
  | 'blocked'
  | 'paused'
  | 'done'
  | 'aborted';
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';
export type AgentRole =
  | 'commander'
  | 'cortana'
  | 'engineer'
  | 'tester'
  | 'investigator'
  | 'reviewer';
export type AgentState = 'idle' | 'working' | 'waiting' | 'done' | 'failed';
export type WorkspaceAccess = 'rw' | 'ro';
export type Verdict = 'approve' | 'reject' | 'escalate';

export interface Project {
  id: string;
  path: string;
  defaultBranch: string;
  repoUrl: string | null;
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
  agentId: string | null;
  status: TaskStatus;
  dependsOn: string[];
}

export interface Agent {
  id: string;
  role: AgentRole;
  sessionId: string | null;
  workspaceId: string | null;
  state: AgentState;
  permanent: boolean;
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
  by: 'cortana' | 'reviewer';
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
  missionId: string;
  agentId: string | null;
  kind: string;
  payload: unknown;
  ts: number;
}
