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
ALTER TABLE "routine_run_dispositions" ADD CONSTRAINT "routine_run_dispositions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_run_dispositions" ADD CONSTRAINT "routine_run_dispositions_routine_run_id_routine_runs_id_fk" FOREIGN KEY ("routine_run_id") REFERENCES "public"."routine_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_run_dispositions" ADD CONSTRAINT "routine_run_dispositions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_run_dispositions" ADD CONSTRAINT "routine_run_dispositions_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_run_dispositions" ADD CONSTRAINT "routine_run_dispositions_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_run_dispositions_routine_run_uq" ON "routine_run_dispositions" USING btree ("routine_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_run_dispositions_heartbeat_key_uq" ON "routine_run_dispositions" USING btree ("heartbeat_run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "routine_run_dispositions_company_issue_idx" ON "routine_run_dispositions" USING btree ("company_id","issue_id","created_at");