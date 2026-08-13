import { z } from "zod";

export const routineRunDispositionCapability = {
  capability: "routine_run_disposition",
  version: 1,
  requestSchema: "paperclip.routine-run-disposition.apply.v1",
  receiptSchema: "paperclip.routine-run-disposition.receipt.v1",
} as const;

const dispositionCommentSchema = z.string().trim().min(1).max(24_000);
const dispositionFailureReasonSchema = z.string().trim().min(1).max(4_000);

const expectedRoutineRunDispositionSchema = z.object({
  issueStatus: z.literal("in_progress"),
  assigneeAgentId: z.string().uuid(),
  checkoutRunId: z.string().uuid().nullable(),
  executionRunId: z.string().uuid(),
  routineRunId: z.string().uuid(),
}).strict();

const completedRoutineRunDispositionSchema = z.object({
  kind: z.literal("completed"),
  comment: dispositionCommentSchema,
}).strict();

const blockedRoutineRunDispositionSchema = z.object({
  kind: z.literal("blocked"),
  comment: dispositionCommentSchema,
  failureReason: dispositionFailureReasonSchema,
  assigneeAgentId: z.string().uuid(),
  unblockAction: z.string().trim().min(1).max(2_000),
}).strict();

const escalatedRoutineRunDispositionSchema = z.object({
  kind: z.literal("escalated"),
  comment: dispositionCommentSchema,
  failureReason: dispositionFailureReasonSchema,
  assigneeAgentId: z.string().uuid(),
}).strict();

/**
 * A deliberately narrow mutation contract for deterministic routine runners.
 * The server derives issue/routine terminal statuses from `kind`, preventing
 * callers from requesting contradictory partial outcomes.
 */
export const applyRoutineRunDispositionSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  expected: expectedRoutineRunDispositionSchema,
  disposition: z.discriminatedUnion("kind", [
    completedRoutineRunDispositionSchema,
    blockedRoutineRunDispositionSchema,
    escalatedRoutineRunDispositionSchema,
  ]),
}).strict();

export type ApplyRoutineRunDisposition = z.infer<typeof applyRoutineRunDispositionSchema>;
