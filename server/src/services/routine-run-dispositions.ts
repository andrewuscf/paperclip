import { createHash, randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import type { Db, RoutineRunDispositionReceipt } from "@paperclipai/db";
import {
  heartbeatRuns,
  issues,
  routineRunDispositions,
  routineRuns,
} from "@paperclipai/db";
import type { ApplyRoutineRunDisposition } from "@paperclipai/shared";
import { conflict, HttpError } from "../errors.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import {
  persistActivity,
  type ActivityPublication,
} from "./activity-log.js";
import { issueService } from "./issues.js";

type RoutineRunDispositionActor = {
  companyId: string;
  agentId: string;
  heartbeatRunId: string;
};

type RoutineRunDispositionHooks = {
  /** Test-only rollback seam. Production callers must not supply hooks. */
  afterHeartbeatLock?: () => void | Promise<void>;
  beforeReceiptInsert?: () => void | Promise<void>;
};

type RoutineRunDispositionResult = {
  receipt: RoutineRunDispositionReceipt;
  replayed: boolean;
  activityPublications: ActivityPublication[];
};

type BoundDispositionState = {
  heartbeat: typeof heartbeatRuns.$inferSelect;
  issue: typeof issues.$inferSelect;
  routineRun: typeof routineRuns.$inferSelect;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function dispositionRequestSha256(input: {
  issueId: string;
  actor: RoutineRunDispositionActor;
  request: ApplyRoutineRunDisposition;
}) {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function readContextIssueIds(contextSnapshot: Record<string, unknown> | null) {
  const issueId = typeof contextSnapshot?.issueId === "string" ? contextSnapshot.issueId : null;
  const taskId = typeof contextSnapshot?.taskId === "string" ? contextSnapshot.taskId : null;
  return { issueId, taskId };
}

function preconditionConflict(
  field: string,
  expected: unknown,
  actual: unknown,
) {
  return conflict("Routine run disposition precondition failed", {
    code: "routine_run_disposition_precondition_failed",
    field,
    expected,
    actual,
  });
}

function assertBoundDispositionState(
  state: BoundDispositionState,
  actor: RoutineRunDispositionActor,
) {
  const { heartbeat, issue, routineRun } = state;
  if (heartbeat.status !== "running") {
    throw preconditionConflict("heartbeatRunStatus", "running", heartbeat.status);
  }
  const contextIds = readContextIssueIds(heartbeat.contextSnapshot ?? null);
  if (
    (!contextIds.issueId && !contextIds.taskId) ||
    (contextIds.issueId !== null && contextIds.issueId !== issue.id) ||
    (contextIds.taskId !== null && contextIds.taskId !== issue.id)
  ) {
    throw preconditionConflict("heartbeatRunIssueId", issue.id, contextIds);
  }
  if (issue.status !== "in_progress") {
    throw preconditionConflict("issue.status", "in_progress", issue.status);
  }
  if (issue.assigneeAgentId !== actor.agentId) {
    throw preconditionConflict("issue.assigneeAgentId", actor.agentId, issue.assigneeAgentId);
  }
  if (issue.checkoutRunId !== null && issue.checkoutRunId !== actor.heartbeatRunId) {
    throw preconditionConflict("issue.checkoutRunId", actor.heartbeatRunId, issue.checkoutRunId);
  }
  if (issue.executionRunId !== actor.heartbeatRunId) {
    throw preconditionConflict("issue.executionRunId", actor.heartbeatRunId, issue.executionRunId);
  }
  if (issue.originKind !== "routine_execution") {
    throw preconditionConflict("issue.originKind", "routine_execution", issue.originKind);
  }
  if (issue.originRunId !== routineRun.id) {
    throw preconditionConflict("issue.originRunId", routineRun.id, issue.originRunId);
  }
  if (issue.originId !== routineRun.routineId) {
    throw preconditionConflict("issue.originId", routineRun.routineId, issue.originId);
  }
  if (routineRun.linkedIssueId !== issue.id) {
    throw preconditionConflict("routineRun.linkedIssueId", issue.id, routineRun.linkedIssueId);
  }
  if (routineRun.status !== "issue_created") {
    throw preconditionConflict("routineRun.status", "issue_created", routineRun.status);
  }
}

function assertReplayMatches(
  row: typeof routineRunDispositions.$inferSelect,
  input: {
    issueId: string;
    actor: RoutineRunDispositionActor;
    request: ApplyRoutineRunDisposition;
    requestSha256: string;
  },
) {
  const matches =
    row.companyId === input.actor.companyId &&
    row.issueId === input.issueId &&
    row.routineRunId === input.request.expected.routineRunId &&
    row.heartbeatRunId === input.actor.heartbeatRunId &&
    row.actorAgentId === input.actor.agentId &&
    row.idempotencyKey === input.request.idempotencyKey &&
    row.requestSha256 === input.requestSha256;
  if (!matches) {
    throw conflict("Routine run already has a different disposition receipt", {
      code: "routine_run_disposition_idempotency_conflict",
      routineRunId: input.request.expected.routineRunId,
      heartbeatRunId: input.actor.heartbeatRunId,
      idempotencyKey: input.request.idempotencyKey,
    });
  }
  return row.receipt;
}

function isRetryableTransactionConflict(error: unknown) {
  let candidate = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!candidate || typeof candidate !== "object") return false;
    if ("code" in candidate && typeof (candidate as { code?: unknown }).code === "string") break;
    candidate = "cause" in candidate ? (candidate as { cause?: unknown }).cause : null;
  }
  if (!candidate || typeof candidate !== "object") return false;
  const code = (candidate as { code?: unknown }).code;
  if (code === "40P01" || code === "40001") return true;
  if (code !== "23505" || !("constraint" in candidate)) return false;
  const constraint = (candidate as { constraint?: unknown }).constraint;
  return constraint === "routine_run_dispositions_routine_run_uq" ||
    constraint === "routine_run_dispositions_heartbeat_key_uq";
}

export function routineRunDispositionService(
  db: Db,
  hooks: RoutineRunDispositionHooks = {},
) {
  const issueSvc = issueService(db);

  async function applyOnce(
    issueId: string,
    request: ApplyRoutineRunDisposition,
    actor: RoutineRunDispositionActor,
  ): Promise<RoutineRunDispositionResult> {
    const requestSha256 = dispositionRequestSha256({ issueId, actor, request });

    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      // Heartbeat -> issue -> routine_run is the canonical acquisition order.
      // Holding the heartbeat row makes identical calls and run finalization
      // serialize before any issue/comment/routine mutation is attempted.
      const heartbeat = await txDb
        .select()
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.id, actor.heartbeatRunId),
          eq(heartbeatRuns.companyId, actor.companyId),
          eq(heartbeatRuns.agentId, actor.agentId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!heartbeat) {
        throw preconditionConflict("heartbeatRunId", actor.heartbeatRunId, null);
      }
      await hooks.afterHeartbeatLock?.();

      const replayByKey = await txDb
        .select()
        .from(routineRunDispositions)
        .where(and(
          eq(routineRunDispositions.heartbeatRunId, actor.heartbeatRunId),
          eq(routineRunDispositions.idempotencyKey, request.idempotencyKey),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (replayByKey) {
        return {
          receipt: assertReplayMatches(replayByKey, { issueId, actor, request, requestSha256 }),
          replayed: true,
          activityPublications: [],
        };
      }

      const issue = await txDb
        .select()
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, actor.companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!issue) throw preconditionConflict("issueId", issueId, null);

      const routineRun = await txDb
        .select()
        .from(routineRuns)
        .where(and(
          eq(routineRuns.id, request.expected.routineRunId),
          eq(routineRuns.companyId, actor.companyId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!routineRun) {
        throw preconditionConflict("routineRunId", request.expected.routineRunId, null);
      }

      // A different heartbeat can race with this one for the same routine run.
      // Re-check after holding both domain rows so the committed receipt wins
      // deterministically and every mismatch remains a zero-write 409.
      const replayByRoutineRun = await txDb
        .select()
        .from(routineRunDispositions)
        .where(eq(routineRunDispositions.routineRunId, routineRun.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (replayByRoutineRun) {
        return {
          receipt: assertReplayMatches(replayByRoutineRun, { issueId, actor, request, requestSha256 }),
          replayed: true,
          activityPublications: [],
        };
      }

      assertBoundDispositionState({ heartbeat, issue, routineRun }, actor);
      if (request.expected.assigneeAgentId !== actor.agentId) {
        throw preconditionConflict("expected.assigneeAgentId", actor.agentId, request.expected.assigneeAgentId);
      }
      if (request.expected.executionRunId !== actor.heartbeatRunId) {
        throw preconditionConflict("expected.executionRunId", actor.heartbeatRunId, request.expected.executionRunId);
      }
      if (
        request.expected.checkoutRunId !== null &&
        request.expected.checkoutRunId !== actor.heartbeatRunId
      ) {
        throw preconditionConflict("expected.checkoutRunId", actor.heartbeatRunId, request.expected.checkoutRunId);
      }
      if (issue.status !== request.expected.issueStatus) {
        throw preconditionConflict("issue.status", request.expected.issueStatus, issue.status);
      }
      if (issue.assigneeAgentId !== request.expected.assigneeAgentId) {
        throw preconditionConflict("issue.assigneeAgentId", request.expected.assigneeAgentId, issue.assigneeAgentId);
      }
      if (issue.checkoutRunId !== request.expected.checkoutRunId) {
        throw preconditionConflict("issue.checkoutRunId", request.expected.checkoutRunId, issue.checkoutRunId);
      }
      if (issue.executionRunId !== request.expected.executionRunId) {
        throw preconditionConflict("issue.executionRunId", request.expected.executionRunId, issue.executionRunId);
      }
      const nextIssueStatus = request.disposition.kind === "completed"
        ? "done" as const
        : request.disposition.kind === "blocked"
          ? "blocked" as const
          : "in_review" as const;
      const nextRoutineRunStatus = request.disposition.kind === "completed"
        ? "completed" as const
        : "failed" as const;
      const nextAssigneeAgentId = request.disposition.kind === "escalated" || request.disposition.kind === "blocked"
        ? request.disposition.assigneeAgentId
        : issue.assigneeAgentId;
      if (request.disposition.kind === "escalated" || request.disposition.kind === "blocked") {
        if (nextAssigneeAgentId === actor.agentId) {
          throw preconditionConflict("disposition.assigneeAgentId", "independent reviewer", nextAssigneeAgentId);
        }
        try {
          await assertAssignableAgent(txDb, issue.companyId, nextAssigneeAgentId, { kind: "work" });
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          throw preconditionConflict(
            "disposition.assigneeAgentId",
            "assignable independent reviewer",
            "not_assignable",
          );
        }
      }

      const updatedIssue = await issueSvc.update(
        issue.id,
        {
          status: nextIssueStatus,
          ...(request.disposition.kind === "escalated" || request.disposition.kind === "blocked"
            ? { assigneeAgentId: request.disposition.assigneeAgentId }
            : {}),
          ...(request.disposition.kind === "blocked"
            ? {
                unblockDescriptor: {
                  owner: { agentId: request.disposition.assigneeAgentId },
                  action: request.disposition.unblockAction,
                },
              }
            : {}),
          actorAgentId: actor.agentId,
        },
        txDb,
      );
      if (!updatedIssue) throw preconditionConflict("issueId", issue.id, null);

      const comment = await issueSvc.addComment(
        issue.id,
        request.disposition.comment,
        { agentId: actor.agentId, runId: actor.heartbeatRunId },
        { authorizationReason: "routine_run_disposition" },
        txDb,
      );
      const now = new Date();
      const updatedRoutineRun = await txDb
        .update(routineRuns)
        .set({
          status: nextRoutineRunStatus,
          failureReason: request.disposition.kind === "completed"
            ? null
            : request.disposition.failureReason,
          completedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(routineRuns.id, routineRun.id),
          eq(routineRuns.status, "issue_created"),
          eq(routineRuns.linkedIssueId, issue.id),
        ))
        .returning({ id: routineRuns.id })
        .then((rows) => rows[0] ?? null);
      if (!updatedRoutineRun) {
        throw preconditionConflict("routineRun.status", "issue_created", "changed");
      }

      const activityPublications: ActivityPublication[] = [];
      const activityBase = {
        companyId: issue.companyId,
        actorType: "agent" as const,
        actorId: actor.agentId,
        agentId: actor.agentId,
        runId: actor.heartbeatRunId,
      };
      const issueChanges = updatedIssue.changes ?? {};
      activityPublications.push((await persistActivity(txDb, {
        ...activityBase,
        action: "issue.updated",
        entityType: "issue",
        entityId: issue.id,
        issueId: issue.id,
        details: {
          identifier: issue.identifier,
          source: "routine_run_disposition",
          outcome: request.disposition.kind,
          changes: issueChanges,
          _previous: Object.fromEntries(
            Object.entries(issueChanges).map(([field, change]) => [field, change.from]),
          ),
        },
      })).publication);
      activityPublications.push((await persistActivity(txDb, {
        ...activityBase,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        issueId: issue.id,
        details: {
          identifier: issue.identifier,
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          authorizationReason: "routine_run_disposition",
        },
      })).publication);
      activityPublications.push((await persistActivity(txDb, {
        ...activityBase,
        action: "routine.run_disposed",
        entityType: "routine_run",
        entityId: routineRun.id,
        issueId: issue.id,
        details: {
          routineId: routineRun.routineId,
          issueId: issue.id,
          outcome: request.disposition.kind,
          issueStatus: nextIssueStatus,
          routineRunStatus: nextRoutineRunStatus,
        },
      })).publication);

      await hooks.beforeReceiptInsert?.();

      const receiptId = randomUUID();
      const receipt: RoutineRunDispositionReceipt = {
        id: receiptId,
        idempotencyKey: request.idempotencyKey,
        companyId: issue.companyId,
        issueId: issue.id,
        routineRunId: routineRun.id,
        heartbeatRunId: actor.heartbeatRunId,
        actorAgentId: actor.agentId,
        outcome: request.disposition.kind,
        issueStatus: nextIssueStatus,
        issueAssigneeAgentId: nextAssigneeAgentId,
        routineRunStatus: nextRoutineRunStatus,
        commentId: comment.id,
        appliedAt: now.toISOString(),
      };
      await txDb.insert(routineRunDispositions).values({
        id: receiptId,
        companyId: issue.companyId,
        routineRunId: routineRun.id,
        issueId: issue.id,
        heartbeatRunId: actor.heartbeatRunId,
        actorAgentId: actor.agentId,
        idempotencyKey: request.idempotencyKey,
        requestSha256,
        receipt,
        createdAt: now,
      });

      return { receipt, replayed: false, activityPublications };
    });
  }

  return {
    preflight: async (
      issueId: string,
      actor: RoutineRunDispositionActor,
    ) => {
      // Deliberately read-only: this lets a runner prove the installed server
      // supports the atomic contract before launching any effectful child work.
      // The returned snapshot is still re-checked under row locks by apply().
      const heartbeat = await db
        .select()
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.id, actor.heartbeatRunId),
          eq(heartbeatRuns.companyId, actor.companyId),
          eq(heartbeatRuns.agentId, actor.agentId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!heartbeat) {
        throw preconditionConflict("heartbeatRunId", actor.heartbeatRunId, null);
      }
      const issue = await db
        .select()
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, actor.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw preconditionConflict("issueId", issueId, null);
      if (!issue.originRunId) {
        throw preconditionConflict("issue.originRunId", "routine run id", issue.originRunId);
      }
      const routineRun = await db
        .select()
        .from(routineRuns)
        .where(and(
          eq(routineRuns.id, issue.originRunId),
          eq(routineRuns.companyId, actor.companyId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!routineRun) {
        throw preconditionConflict("routineRunId", issue.originRunId, null);
      }
      assertBoundDispositionState({ heartbeat, issue, routineRun }, actor);
      return {
        expected: {
          issueStatus: "in_progress" as const,
          assigneeAgentId: actor.agentId,
          checkoutRunId: issue.checkoutRunId,
          executionRunId: actor.heartbeatRunId,
          routineRunId: routineRun.id,
        },
      };
    },
    apply: async (
      issueId: string,
      request: ApplyRoutineRunDisposition,
      actor: RoutineRunDispositionActor,
    ) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await applyOnce(issueId, request, actor);
        } catch (error) {
          if (attempt === 2 || !isRetryableTransactionConflict(error)) throw error;
        }
      }
      throw new Error("Unreachable routine disposition retry state");
    },
  };
}
