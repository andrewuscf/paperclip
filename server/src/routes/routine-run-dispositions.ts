import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  applyRoutineRunDispositionSchema,
  routineRunDispositionCapability,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { publishActivity, routineRunDispositionService } from "../services/index.js";

function requireRunBoundActor(actor: Express.Request["actor"]) {
  if (
    actor.type !== "agent" ||
    !actor.companyId ||
    !actor.agentId ||
    !actor.runId
  ) {
    throw forbidden("A run-bound agent is required");
  }
  return {
    companyId: actor.companyId,
    agentId: actor.agentId,
    heartbeatRunId: actor.runId,
  };
}

export function routineRunDispositionRoutes(db: Db) {
  const router = Router();
  const svc = routineRunDispositionService(db);

  router.get("/issues/:issueId/runner-disposition/capability", async (req, res) => {
    const actor = requireRunBoundActor(req.actor);
    const preflight = await svc.preflight(req.params.issueId as string, actor);
    res.json({
      ...routineRunDispositionCapability,
      mutation: {
        method: "POST",
        path: `/api/issues/${req.params.issueId as string}/runner-disposition`,
      },
      actorBinding: actor,
      expected: preflight.expected,
      dispositions: {
        completed: {
          issueStatus: "done",
          routineRunStatus: "completed",
        },
        blocked: {
          issueStatus: "blocked",
          routineRunStatus: "failed",
          requiresIndependentAssignee: true,
          requiresUnblockAction: true,
        },
        escalated: {
          issueStatus: "in_review",
          routineRunStatus: "failed",
          requiresIndependentAssignee: true,
        },
      },
      idempotency: {
        required: true,
        firstApplyStatus: 201,
        replayStatus: 200,
        mismatchStatus: 409,
      },
    });
  });

  router.post(
    "/issues/:issueId/runner-disposition",
    validate(applyRoutineRunDispositionSchema),
    async (req, res) => {
      const actor = requireRunBoundActor(req.actor);

      const result = await svc.apply(
        req.params.issueId as string,
        req.body,
        actor,
      );
      for (const publication of result.activityPublications) publishActivity(publication);
      res.status(result.replayed ? 200 : 201).json({
        receipt: result.receipt,
        replayed: result.replayed,
      });
    },
  );

  return router;
}
