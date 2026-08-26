import { randomUUID } from 'node:crypto';
import type { AgentTraceStep, Operation } from '@editify/shared';
import type { EditifyDatabase } from './database.js';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ops?: Operation[];
  trace?: AgentTraceStep[];
  /** Checkpoint this turn's operations were logged under, for Revert. */
  runId?: string;
  createdAt: string;
}

export class ChatStore {
  constructor(private readonly database: EditifyDatabase) {}

  add(
    projectId: string,
    role: ChatMessage['role'],
    content: string,
    ops?: Operation[],
    trace?: AgentTraceStep[],
    runId?: string,
  ): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(), role, content,
      ...(ops ? { ops } : {}),
      ...(trace ? { trace } : {}),
      ...(runId ? { runId } : {}),
      createdAt: new Date().toISOString(),
    };
    const agentData = ops || trace
      ? JSON.stringify({ ops: ops ?? [], trace: trace ?? [], ...(runId ? { runId } : {}) })
      : null;
    this.database.prepare(`
      INSERT INTO chat_messages (id, project_id, role, content, ops_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(message.id, projectId, role, content, agentData, message.createdAt);
    return message;
  }

  list(projectId: string): ChatMessage[] {
    const rows = this.database.prepare(`
      SELECT id, role, content, ops_json, created_at FROM chat_messages
      WHERE project_id = ? ORDER BY created_at ASC
    `).all(projectId) as Array<{ id: string; role: ChatMessage['role']; content: string; ops_json: string | null; created_at: string }>;
    return rows.map((row) => {
      const stored = row.ops_json ? JSON.parse(row.ops_json) as Operation[] | {
        ops?: Operation[]; trace?: AgentTraceStep[]; runId?: string;
      } : undefined;
      const ops = Array.isArray(stored) ? stored : stored?.ops;
      const trace = Array.isArray(stored) ? undefined : stored?.trace;
      const runId = Array.isArray(stored) ? undefined : stored?.runId;
      return {
        id: row.id, role: row.role, content: row.content,
        ...(ops ? { ops } : {}),
        ...(trace ? { trace } : {}),
        ...(runId ? { runId } : {}),
        createdAt: row.created_at,
      };
    });
  }
}
