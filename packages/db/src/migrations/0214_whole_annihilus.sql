CREATE TABLE "routine_run_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_run_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"heartbeat_run_id" uuid NOT NULL,
	"actor_agent_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_sha256" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "routine_runs_trigger_idempotency_idx";--> statement-breakpoint
ALTER TABLE "routine_run_dispositions" ADD CONSTRAINT "routine_run_dispositions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_run_dispositions_routine_run_uq" ON "routine_run_dispositions" USING btree ("routine_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_run_dispositions_heartbeat_key_uq" ON "routine_run_dispositions" USING btree ("heartbeat_run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "routine_run_dispositions_company_issue_idx" ON "routine_run_dispositions" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; this partial uniqueness index covers only the newly introduced routine-dispatch key namespace and is required for atomic durable wake enqueue.
CREATE UNIQUE INDEX "agent_wakeup_requests_routine_dispatch_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'routine-dispatch:%';--> statement-breakpoint
CREATE UNIQUE INDEX "routine_runs_trigger_idempotency_uq" ON "routine_runs" USING btree ("trigger_id","idempotency_key") WHERE "routine_runs"."trigger_id" IS NOT NULL AND "routine_runs"."idempotency_key" IS NOT NULL;
