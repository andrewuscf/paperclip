import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  routineRunDispositions,
  routineRuns,
  routines,
} from "@paperclipai/db";
import type { ApplyRoutineRunDisposition } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { routineRunDispositionService } from "../services/routine-run-dispositions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping routine disposition service tests: ${embeddedPostgresSupport.reason ?? "embedded Postgres unavailable"}`,
  );
}

describeEmbeddedPostgres("atomic routine run disposition service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-disposition-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineRunDispositions);
    await db.delete(issueComments);
    await db.delete(routineRuns);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input: { checkoutRunId?: "actor" | null } = {}) {
    const companyId = randomUUID();
    const actorAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const routineId = randomUUID();
    const routineRunId = randomUUID();
    const issueId = randomUUID();
    const heartbeatRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Disposition Co",
      issuePrefix: `D${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: actorAgentId,
        companyId,
        name: "Automation Runner",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
      },
      {
        id: qaAgentId,
        companyId,
        name: "QA",
        role: "qa",
        status: "idle",
        adapterType: "codex_local",
      },
    ]);
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Deterministic automation",
      assigneeAgentId: actorAgentId,
      status: "active",
    });
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId: actorAgentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot: { issueId, taskId: issueId },
      startedAt: new Date(),
    });
    await db.insert(routineRuns).values({
      id: routineRunId,
      companyId,
      routineId,
      source: "schedule",
      status: "issue_created",
    });
    const checkoutRunId = input.checkoutRunId === null ? null : heartbeatRunId;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Execute the deterministic routine",
      status: "in_progress",
      assigneeAgentId: actorAgentId,
      checkoutRunId,
      executionRunId: heartbeatRunId,
      executionLockedAt: new Date(),
      identifier: `D-${issueId}`,
      originKind: "routine_execution",
      originId: routineId,
      originRunId: routineRunId,
      originFingerprint: randomUUID(),
    });
    await db
      .update(routineRuns)
      .set({ linkedIssueId: issueId })
      .where(eq(routineRuns.id, routineRunId));

    const actor = { companyId, agentId: actorAgentId, heartbeatRunId };
    const request: ApplyRoutineRunDisposition = {
      idempotencyKey: `runner:${heartbeatRunId}:terminal`,
      expected: {
        issueStatus: "in_progress",
        assigneeAgentId: actorAgentId,
        checkoutRunId,
        executionRunId: heartbeatRunId,
        routineRunId,
      },
      disposition: {
        kind: "completed",
        comment: "Deterministic automation completed successfully.",
      },
    };
    return {
      actor,
      actorAgentId,
      companyId,
      heartbeatRunId,
      issueId,
      qaAgentId,
      request,
      routineId,
      routineRunId,
    };
  }

  async function expectNoDispositionWrites() {
    await expect(db.select().from(issueComments)).resolves.toHaveLength(0);
    await expect(db.select().from(routineRunDispositions)).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog)).resolves.toHaveLength(0);
  }

  it("preflights the exact run binding without writing or locking in a disposition", async () => {
    const fixture = await seedFixture();
    const result = await routineRunDispositionService(db).preflight(
      fixture.issueId,
      fixture.actor,
    );

    expect(result).toEqual({ expected: fixture.request.expected });
    await expectNoDispositionWrites();
    await expect(db.select().from(issues).where(eq(issues.id, fixture.issueId))).resolves.toMatchObject([
      {
        status: "in_progress",
        assigneeAgentId: fixture.actorAgentId,
        checkoutRunId: fixture.heartbeatRunId,
        executionRunId: fixture.heartbeatRunId,
      },
    ]);
    await expect(db.select().from(routineRuns).where(eq(routineRuns.id, fixture.routineRunId))).resolves.toMatchObject([
      { status: "issue_created", completedAt: null },
    ]);
  });

  it("rejects a stale preflight binding without writes", async () => {
    const fixture = await seedFixture();
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, fixture.heartbeatRunId));

    await expect(routineRunDispositionService(db).preflight(fixture.issueId, fixture.actor))
      .rejects.toMatchObject({ status: 409 });
    await expectNoDispositionWrites();
  });

  it("atomically completes, comments, terminalizes the routine run, and replays the same receipt", async () => {
    const fixture = await seedFixture();
    const svc = routineRunDispositionService(db);

    const applied = await svc.apply(fixture.issueId, fixture.request, fixture.actor);
    expect(applied.replayed).toBe(false);
    expect(applied.receipt).toMatchObject({
      issueId: fixture.issueId,
      routineRunId: fixture.routineRunId,
      heartbeatRunId: fixture.heartbeatRunId,
      actorAgentId: fixture.actorAgentId,
      outcome: "completed",
      issueStatus: "done",
      routineRunStatus: "completed",
    });
    await expect(db.select().from(issues).where(eq(issues.id, fixture.issueId))).resolves.toMatchObject([
      {
        status: "done",
        assigneeAgentId: fixture.actorAgentId,
        checkoutRunId: null,
        executionRunId: null,
      },
    ]);
    await expect(db.select().from(routineRuns).where(eq(routineRuns.id, fixture.routineRunId))).resolves.toMatchObject([
      { status: "completed", failureReason: null, completedAt: expect.any(Date) },
    ]);
    await expect(db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId))).resolves.toHaveLength(1);
    await expect(db.select().from(routineRunDispositions)).resolves.toHaveLength(1);
    await expect(db.select().from(activityLog)).resolves.toHaveLength(3);

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, fixture.heartbeatRunId));
    const replay = await svc.apply(fixture.issueId, fixture.request, fixture.actor);
    expect(replay).toMatchObject({ replayed: true, receipt: applied.receipt });
    await expect(db.select().from(issueComments)).resolves.toHaveLength(1);
    await expect(db.select().from(routineRunDispositions)).resolves.toHaveLength(1);
    await expect(db.select().from(activityLog)).resolves.toHaveLength(3);
  });

  it("reassigns a failed weekly execution to QA in the same transaction", async () => {
    const fixture = await seedFixture({ checkoutRunId: null });
    const request: ApplyRoutineRunDisposition = {
      ...fixture.request,
      disposition: {
        kind: "escalated",
        comment: "Weekly QA failed; review the private evidence receipt.",
        failureReason: "weekly_qa_failed",
        assigneeAgentId: fixture.qaAgentId,
      },
    };
    const result = await routineRunDispositionService(db).apply(fixture.issueId, request, fixture.actor);

    expect(result.receipt).toMatchObject({
      outcome: "escalated",
      issueStatus: "in_review",
      issueAssigneeAgentId: fixture.qaAgentId,
      routineRunStatus: "failed",
    });
    await expect(db.select().from(issues).where(eq(issues.id, fixture.issueId))).resolves.toMatchObject([
      {
        status: "in_review",
        assigneeAgentId: fixture.qaAgentId,
        checkoutRunId: null,
        executionRunId: null,
      },
    ]);
    await expect(db.select().from(routineRuns).where(eq(routineRuns.id, fixture.routineRunId))).resolves.toMatchObject([
      { status: "failed", failureReason: "weekly_qa_failed" },
    ]);
  });

  it("blocks and hands failed work to an independent QA owner with an unblock descriptor", async () => {
    const fixture = await seedFixture();
    const request: ApplyRoutineRunDisposition = {
      ...fixture.request,
      disposition: {
        kind: "blocked",
        comment: "The deterministic command failed; QA must review the evidence.",
        failureReason: "command_failed",
        assigneeAgentId: fixture.qaAgentId,
        unblockAction: "Review the bounded failure evidence and decide the recovery action.",
      },
    };
    const result = await routineRunDispositionService(db).apply(fixture.issueId, request, fixture.actor);

    expect(result.receipt).toMatchObject({
      outcome: "blocked",
      issueStatus: "blocked",
      issueAssigneeAgentId: fixture.qaAgentId,
      routineRunStatus: "failed",
    });
    await expect(db.select().from(issues).where(eq(issues.id, fixture.issueId))).resolves.toMatchObject([
      {
        status: "blocked",
        assigneeAgentId: fixture.qaAgentId,
        checkoutRunId: null,
        executionRunId: null,
        unblockDescriptor: {
          owner: { agentId: fixture.qaAgentId },
          action: "Review the bounded failure evidence and decide the recovery action.",
        },
      },
    ]);
  });

  it("rejects a self-review handoff without writes", async () => {
    const fixture = await seedFixture();
    const request: ApplyRoutineRunDisposition = {
      ...fixture.request,
      disposition: {
        kind: "blocked",
        comment: "Failed.",
        failureReason: "command_failed",
        assigneeAgentId: fixture.actorAgentId,
        unblockAction: "Review the failure.",
      },
    };

    await expect(routineRunDispositionService(db).apply(fixture.issueId, request, fixture.actor))
      .rejects.toMatchObject({ status: 409 });
    await expectNoDispositionWrites();
  });

  it("rejects an unassignable review target without writes", async () => {
    const fixture = await seedFixture();
    await db
      .update(agents)
      .set({ status: "terminated" })
      .where(eq(agents.id, fixture.qaAgentId));
    const request: ApplyRoutineRunDisposition = {
      ...fixture.request,
      disposition: {
        kind: "blocked",
        comment: "Failed and requires independent review.",
        failureReason: "command_failed",
        assigneeAgentId: fixture.qaAgentId,
        unblockAction: "Review the failure evidence.",
      },
    };

    await expect(routineRunDispositionService(db).apply(fixture.issueId, request, fixture.actor))
      .rejects.toMatchObject({ status: 409 });
    await expectNoDispositionWrites();
  });

  it("normalizes a missing review target to a zero-write 409 precondition conflict", async () => {
    const fixture = await seedFixture();
    const request: ApplyRoutineRunDisposition = {
      ...fixture.request,
      disposition: {
        kind: "escalated",
        comment: "Failed and requires independent review.",
        failureReason: "command_failed",
        assigneeAgentId: randomUUID(),
      },
    };

    await expect(routineRunDispositionService(db).apply(fixture.issueId, request, fixture.actor))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "routine_run_disposition_precondition_failed" },
      });
    await expectNoDispositionWrites();
  });

  it("rejects changed-payload and changed-key replays without additional writes", async () => {
    const fixture = await seedFixture();
    const svc = routineRunDispositionService(db);
    await svc.apply(fixture.issueId, fixture.request, fixture.actor);
    const countsBefore = await Promise.all([
      db.select().from(issueComments),
      db.select().from(routineRunDispositions),
      db.select().from(activityLog),
    ]);

    await expect(svc.apply(fixture.issueId, {
      ...fixture.request,
      disposition: { kind: "completed", comment: "A different completion payload." },
    }, fixture.actor)).rejects.toMatchObject({ status: 409 });
    await expect(svc.apply(fixture.issueId, {
      ...fixture.request,
      idempotencyKey: `${fixture.request.idempotencyKey}:changed`,
    }, fixture.actor)).rejects.toMatchObject({ status: 409 });
    const countsAfter = await Promise.all([
      db.select().from(issueComments),
      db.select().from(routineRunDispositions),
      db.select().from(activityLog),
    ]);
    expect(countsAfter.map((rows) => rows.length)).toEqual(countsBefore.map((rows) => rows.length));
  });

  const mismatchCases: Array<{
    name: string;
    mutate: (fixture: Awaited<ReturnType<typeof seedFixture>>) => Promise<void>;
  }> = [
    {
      name: "issue status",
      mutate: async ({ issueId }) => {
        await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
      },
    },
    {
      name: "issue assignee",
      mutate: async ({ issueId, qaAgentId }) => {
        await db.update(issues).set({ assigneeAgentId: qaAgentId }).where(eq(issues.id, issueId));
      },
    },
    {
      name: "checkout run",
      mutate: async ({ issueId }) => {
        await db.update(issues).set({ checkoutRunId: null }).where(eq(issues.id, issueId));
      },
    },
    {
      name: "execution run",
      mutate: async ({ issueId, companyId, actorAgentId }) => {
        const otherRunId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: otherRunId,
          companyId,
          agentId: actorAgentId,
          status: "running",
          contextSnapshot: { issueId },
        });
        await db.update(issues).set({ executionRunId: otherRunId }).where(eq(issues.id, issueId));
      },
    },
    {
      name: "routine run status",
      mutate: async ({ routineRunId }) => {
        await db.update(routineRuns).set({ status: "failed" }).where(eq(routineRuns.id, routineRunId));
      },
    },
    {
      name: "heartbeat liveness",
      mutate: async ({ heartbeatRunId }) => {
        await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, heartbeatRunId));
      },
    },
    {
      name: "heartbeat issue context",
      mutate: async ({ heartbeatRunId }) => {
        await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: randomUUID() } })
          .where(eq(heartbeatRuns.id, heartbeatRunId));
      },
    },
    {
      name: "routine run issue link",
      mutate: async ({ routineRunId }) => {
        await db.update(routineRuns).set({ linkedIssueId: null }).where(eq(routineRuns.id, routineRunId));
      },
    },
  ];

  it.each(mismatchCases)("returns a zero-write 409 for a stale $name precondition", async ({ mutate }) => {
    const fixture = await seedFixture();
    await mutate(fixture);
    const issueBefore = await db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]);
    const routineRunBefore = await db.select().from(routineRuns)
      .where(eq(routineRuns.id, fixture.routineRunId)).then((rows) => rows[0]);

    const error = await routineRunDispositionService(db)
      .apply(fixture.issueId, fixture.request, fixture.actor)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 409 });
    await expectNoDispositionWrites();
    await expect(db.select().from(issues).where(eq(issues.id, fixture.issueId))).resolves.toMatchObject([issueBefore]);
    await expect(db.select().from(routineRuns).where(eq(routineRuns.id, fixture.routineRunId))).resolves.toMatchObject([
      routineRunBefore,
    ]);
  });

  it("rolls back issue, comment, routine, activity, and receipt writes on a late failure", async () => {
    const fixture = await seedFixture();
    const svc = routineRunDispositionService(db, {
      beforeReceiptInsert: () => {
        throw new Error("injected receipt failure");
      },
    });

    await expect(svc.apply(fixture.issueId, fixture.request, fixture.actor)).rejects.toThrow("injected receipt failure");
    await expectNoDispositionWrites();
    await expect(db.select().from(issues).where(eq(issues.id, fixture.issueId))).resolves.toMatchObject([
      {
        status: "in_progress",
        assigneeAgentId: fixture.actorAgentId,
        checkoutRunId: fixture.heartbeatRunId,
        executionRunId: fixture.heartbeatRunId,
      },
    ]);
    await expect(db.select().from(routineRuns).where(eq(routineRuns.id, fixture.routineRunId))).resolves.toMatchObject([
      { status: "issue_created", completedAt: null },
    ]);
  });

  it("coalesces concurrent identical calls into one receipt and one comment", async () => {
    const fixture = await seedFixture();
    const svc = routineRunDispositionService(db);
    const results = await Promise.all([
      svc.apply(fixture.issueId, fixture.request, fixture.actor),
      svc.apply(fixture.issueId, fixture.request, fixture.actor),
    ]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0]?.receipt).toEqual(results[1]?.receipt);
    await expect(db.select().from(issueComments)).resolves.toHaveLength(1);
    await expect(db.select().from(routineRunDispositions)).resolves.toHaveLength(1);
    await expect(db.select().from(activityLog)).resolves.toHaveLength(3);
  });

  it("retries a deterministic opposite heartbeat/issue lock-order deadlock without partial writes", async () => {
    const fixture = await seedFixture();
    let issueLocked!: () => void;
    const issueLockHeld = new Promise<void>((resolve) => { issueLocked = resolve; });
    let heartbeatLocked!: () => void;
    const heartbeatLockHeld = new Promise<void>((resolve) => { heartbeatLocked = resolve; });
    let oppositeAttempted!: () => void;
    const oppositeLockAttempted = new Promise<void>((resolve) => { oppositeAttempted = resolve; });

    const oppositeTransaction = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, fixture.issueId)).for("update");
      issueLocked();
      await heartbeatLockHeld;
      oppositeAttempted();
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, fixture.heartbeatRunId)).for("update");
    });
    await issueLockHeld;

    const resultPromise = routineRunDispositionService(db, {
      afterHeartbeatLock: async () => {
        heartbeatLocked();
        await oppositeLockAttempted;
      },
    }).apply(fixture.issueId, fixture.request, fixture.actor);
    const [result] = await Promise.all([
      resultPromise,
      oppositeTransaction.catch((error) => {
        const pgError = (error as { cause?: { code?: string } }).cause ?? error as { code?: string };
        if (pgError.code !== "40P01") throw error;
      }),
    ]);

    expect(result.replayed).toBe(false);
    await expect(db.select().from(issueComments)).resolves.toHaveLength(1);
    await expect(db.select().from(routineRunDispositions)).resolves.toHaveLength(1);
    await expect(db.select().from(activityLog)).resolves.toHaveLength(3);
    await expect(db.select().from(issues).where(and(
      eq(issues.id, fixture.issueId),
      eq(issues.status, "done"),
    ))).resolves.toHaveLength(1);
  });
});
