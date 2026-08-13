import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routineRunDispositionCapability } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { routineRunDispositionRoutes } from "../routes/routine-run-dispositions.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const heartbeatRunId = "33333333-3333-4333-8333-333333333333";
const routineRunId = "44444444-4444-4444-8444-444444444444";
const issueId = "55555555-5555-4555-8555-555555555555";
const commentId = "66666666-6666-4666-8666-666666666666";
const receiptId = "77777777-7777-4777-8777-777777777777";

const mockApply = vi.hoisted(() => vi.fn());
const mockPreflight = vi.hoisted(() => vi.fn());
const mockPublishActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...original,
    publishActivity: mockPublishActivity,
    routineRunDispositionService: () => ({ apply: mockApply, preflight: mockPreflight }),
  };
});

const payload = {
  idempotencyKey: `runner:${heartbeatRunId}:terminal`,
  expected: {
    issueStatus: "in_progress",
    assigneeAgentId: agentId,
    checkoutRunId: heartbeatRunId,
    executionRunId: heartbeatRunId,
    routineRunId,
  },
  disposition: {
    kind: "completed",
    comment: "Deterministic automation completed.",
  },
};

const receipt = {
  id: receiptId,
  idempotencyKey: payload.idempotencyKey,
  companyId,
  issueId,
  routineRunId,
  heartbeatRunId,
  actorAgentId: agentId,
  outcome: "completed",
  issueStatus: "done",
  issueAssigneeAgentId: agentId,
  routineRunStatus: "completed",
  commentId,
  appliedAt: "2026-08-13T12:00:00.000Z",
};

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", routineRunDispositionRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("routine run disposition route", () => {
  beforeEach(() => {
    mockApply.mockReset();
    mockPreflight.mockReset();
    mockPublishActivity.mockReset();
  });

  it("rejects a board actor capability probe without reading disposition state", async () => {
    const response = await request(createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [companyId],
    })).get(`/api/issues/${issueId}/runner-disposition/capability`);

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/run-bound agent/i);
    expect(mockPreflight).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("returns the versioned read-only contract and exact authenticated preflight snapshot", async () => {
    mockPreflight.mockResolvedValue({ expected: payload.expected });
    const response = await request(createApp({
      type: "agent",
      source: "agent_key",
      companyId,
      agentId,
      runId: heartbeatRunId,
    })).get(`/api/issues/${issueId}/runner-disposition/capability`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ...routineRunDispositionCapability,
      mutation: {
        method: "POST",
        path: `/api/issues/${issueId}/runner-disposition`,
      },
      actorBinding: { companyId, agentId, heartbeatRunId },
      expected: payload.expected,
      dispositions: {
        blocked: {
          issueStatus: "blocked",
          routineRunStatus: "failed",
          requiresIndependentAssignee: true,
          requiresUnblockAction: true,
        },
      },
      idempotency: {
        required: true,
        firstApplyStatus: 201,
        replayStatus: 200,
        mismatchStatus: 409,
      },
    });
    expect(mockPreflight).toHaveBeenCalledWith(issueId, {
      companyId,
      agentId,
      heartbeatRunId,
    });
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockPublishActivity).not.toHaveBeenCalled();
  });

  it("rejects board actors before calling the mutation service", async () => {
    const response = await request(createApp({
      type: "board",
      source: "local_implicit",
      userId: "board-user",
      companyIds: [companyId],
    }))
      .post(`/api/issues/${issueId}/runner-disposition`)
      .send(payload);

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/run-bound agent/i);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it.each([
    { type: "agent", companyId, agentId, runId: null },
    { type: "agent", companyId, agentId: null, runId: heartbeatRunId },
    { type: "agent", companyId: null, agentId, runId: heartbeatRunId },
  ])("rejects an incomplete agent binding %#", async (actor) => {
    const response = await request(createApp(actor))
      .post(`/api/issues/${issueId}/runner-disposition`)
      .send(payload);

    expect(response.status).toBe(403);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("validates the strict disposition body before the service", async () => {
    const response = await request(createApp({
      type: "agent",
      companyId,
      agentId,
      runId: heartbeatRunId,
    }))
      .post(`/api/issues/${issueId}/runner-disposition`)
      .send({ ...payload, unexpected: true });

    expect(response.status).toBe(400);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("binds service application to the authenticated company, agent, and heartbeat run", async () => {
    const publication = { companyId, payload: { action: "issue.updated" }, pluginEvent: null };
    mockApply.mockResolvedValue({ receipt, replayed: false, activityPublications: [publication] });
    const response = await request(createApp({
      type: "agent",
      source: "agent_key",
      companyId,
      agentId,
      runId: heartbeatRunId,
    }))
      .post(`/api/issues/${issueId}/runner-disposition`)
      .send(payload);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ receipt, replayed: false });
    expect(mockApply).toHaveBeenCalledWith(issueId, payload, {
      companyId,
      agentId,
      heartbeatRunId,
    });
    expect(mockPublishActivity).toHaveBeenCalledWith(publication);
  });

  it("returns a replay without publishing duplicate activity", async () => {
    mockApply.mockResolvedValue({ receipt, replayed: true, activityPublications: [] });
    const response = await request(createApp({
      type: "agent",
      companyId,
      agentId,
      runId: heartbeatRunId,
    }))
      .post(`/api/issues/${issueId}/runner-disposition`)
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ receipt, replayed: true });
    expect(mockPublishActivity).not.toHaveBeenCalled();
  });
});
