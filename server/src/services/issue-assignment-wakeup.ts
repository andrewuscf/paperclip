import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  wakeupInTransaction?: (
    agentId: string,
    opts: {
      companyId: string;
      responsibleUserId: string | null;
      source: WakeupSource;
      triggerDetail: WakeupTriggerDetail;
      reason: string;
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      idempotencyKey: string;
    },
    executor: Db,
  ) => Promise<unknown>;
  resumeQueuedRuns?: () => Promise<void>;
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  taskKey?: string | null;
  rethrowOnError?: boolean;
  executor?: Db;
  companyId?: string;
  responsibleUserId?: string | null;
  idempotencyKey?: string;
  postCommitCallbacks?: Array<() => void | Promise<void>>;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

  const wakeOpts = {
    source: "assignment" as const,
    triggerDetail: "system" as const,
    reason: input.reason,
    payload: {
      issueId: input.issue.id,
      mutation: input.mutation,
      ...(input.taskKey ? { taskKey: input.taskKey } : {}),
    },
    requestedByActorType: input.requestedByActorType,
    requestedByActorId: input.requestedByActorId ?? null,
    contextSnapshot: {
      issueId: input.issue.id,
      source: input.contextSource,
      ...(input.taskKey ? { taskKey: input.taskKey } : {}),
    },
  };

  if (input.executor) {
    if (
      !input.heartbeat.wakeupInTransaction ||
      !input.companyId ||
      input.responsibleUserId === undefined ||
      !input.idempotencyKey ||
      !input.postCommitCallbacks
    ) {
      throw new Error("Transactional issue wakeup requires a durable enqueue and post-commit delivery contract");
    }
    const result = input.heartbeat.wakeupInTransaction(
      input.issue.assigneeAgentId,
      {
        ...wakeOpts,
        companyId: input.companyId,
        responsibleUserId: input.responsibleUserId,
        idempotencyKey: input.idempotencyKey,
      },
      input.executor,
    );
    input.postCommitCallbacks.push(async () => {
      await input.heartbeat.resumeQueuedRuns?.();
    });
    return result;
  }

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, wakeOpts)
    .catch((err) => {
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}
