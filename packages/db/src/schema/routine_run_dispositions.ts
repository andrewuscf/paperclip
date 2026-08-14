import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export type RoutineRunDispositionReceipt = {
  id: string;
  idempotencyKey: string;
  companyId: string;
  issueId: string;
  routineRunId: string;
  heartbeatRunId: string;
  actorAgentId: string;
  outcome: "completed" | "blocked" | "escalated";
  issueStatus: "done" | "blocked";
  issueAssigneeAgentId: string | null;
  routineRunStatus: "completed" | "failed";
  commentId: string;
  appliedAt: string;
};

/** Durable, unique receipts for the one atomic disposition allowed per routine run. */
export const routineRunDispositions = pgTable(
  "routine_run_dispositions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // These identifiers intentionally remain immutable audit references rather
    // than lifecycle foreign keys. Agents and heartbeat runs are routinely
    // pruned, and issues/routine runs may be removed by retention. Cascading
    // would destroy the receipt while RESTRICT would make ordinary lifecycle
    // cleanup fail. The receipt JSON is the durable terminal snapshot.
    routineRunId: uuid("routine_run_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    heartbeatRunId: uuid("heartbeat_run_id").notNull(),
    actorAgentId: uuid("actor_agent_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestSha256: text("request_sha256").notNull(),
    receipt: jsonb("receipt").$type<RoutineRunDispositionReceipt>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    routineRunUq: uniqueIndex("routine_run_dispositions_routine_run_uq").on(table.routineRunId),
    heartbeatKeyUq: uniqueIndex("routine_run_dispositions_heartbeat_key_uq").on(
      table.heartbeatRunId,
      table.idempotencyKey,
    ),
    companyIssueIdx: index("routine_run_dispositions_company_issue_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
  }),
);
