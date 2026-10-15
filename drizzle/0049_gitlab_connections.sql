CREATE TABLE "gitlab_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"namespace_id" bigint NOT NULL,
	"namespace_kind" text NOT NULL,
	"namespace_full_path" text NOT NULL,
	"namespace_name" text NOT NULL,
	"provider_application_id" text,
	"slug" text NOT NULL,
	"gitlab_user_id" bigint NOT NULL,
	"gitlab_username" text NOT NULL,
	"gitlab_user_name" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"connected_by_user_id" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gitlab_connections_namespace_id_unique" UNIQUE("namespace_id"),
	CONSTRAINT "gitlab_connections_namespace_kind_check" CHECK ("gitlab_connections"."namespace_kind" in ('group', 'user'))
);
--> statement-breakpoint
CREATE TABLE "gitlab_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"project_id" bigint NOT NULL,
	"path_with_namespace" text NOT NULL,
	"default_branch" text,
	"web_url" text NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" DROP CONSTRAINT "organization_connection_attempts_provider_check";--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" DROP CONSTRAINT "organization_connection_attempts_phase_check";--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" DROP CONSTRAINT "organization_connection_attempts_shape_check";--> statement-breakpoint
ALTER TABLE "project_trigger_routes" DROP CONSTRAINT "project_trigger_routes_provider_check";--> statement-breakpoint
ALTER TABLE "provider_event_receipts" DROP CONSTRAINT "provider_event_receipts_provider_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" DROP CONSTRAINT "runtime_provider_activation_provider_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" DROP CONSTRAINT "runtime_provider_configuration_provider_check";--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" ADD COLUMN "candidate_grant" jsonb;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_connections_id_organization_unique" ON "gitlab_connections" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_connections_organization_slug_unique" ON "gitlab_connections" USING btree ("organization_id","slug");--> statement-breakpoint
ALTER TABLE "gitlab_projects" ADD CONSTRAINT "gitlab_projects_connection_organization_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."gitlab_connections"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_projects_connection_project_unique" ON "gitlab_projects" USING btree ("connection_id","project_id");--> statement-breakpoint
CREATE INDEX "gitlab_projects_organization_project_idx" ON "gitlab_projects" USING btree ("organization_id","project_id");--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" ADD CONSTRAINT "organization_connection_attempts_provider_check" CHECK ("organization_connection_attempts"."provider" in ('github', 'discord', 'slack', 'linear', 'gitlab'));--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" ADD CONSTRAINT "organization_connection_attempts_phase_check" CHECK ("organization_connection_attempts"."phase" in ('github_setup', 'github_user_authorization', 'discord_authorization', 'slack_authorization', 'linear_authorization', 'gitlab_authorization', 'gitlab_namespace_selection'));--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" ADD CONSTRAINT "organization_connection_attempts_shape_check" CHECK (("organization_connection_attempts"."phase" = 'github_setup' and "organization_connection_attempts"."provider" = 'github' and "organization_connection_attempts"."candidate_external_id" is null and "organization_connection_attempts"."pkce_verifier" is null)
        or ("organization_connection_attempts"."phase" = 'github_user_authorization' and "organization_connection_attempts"."provider" = 'github' and "organization_connection_attempts"."candidate_external_id" is not null and ("organization_connection_attempts"."pkce_verifier" is not null or "organization_connection_attempts"."consumed_at" is not null))
        or ("organization_connection_attempts"."phase" = 'discord_authorization' and "organization_connection_attempts"."provider" = 'discord' and "organization_connection_attempts"."candidate_external_id" is null and "organization_connection_attempts"."pkce_verifier" is null)
        or ("organization_connection_attempts"."phase" = 'slack_authorization' and "organization_connection_attempts"."provider" = 'slack' and "organization_connection_attempts"."candidate_external_id" is null and "organization_connection_attempts"."pkce_verifier" is null)
        or ("organization_connection_attempts"."phase" = 'linear_authorization' and "organization_connection_attempts"."provider" = 'linear' and "organization_connection_attempts"."candidate_external_id" is null and "organization_connection_attempts"."pkce_verifier" is null)
        or ("organization_connection_attempts"."phase" = 'gitlab_authorization' and "organization_connection_attempts"."provider" = 'gitlab' and "organization_connection_attempts"."candidate_external_id" is null and "organization_connection_attempts"."candidate_grant" is null and ("organization_connection_attempts"."pkce_verifier" is not null or "organization_connection_attempts"."consumed_at" is not null))
        or ("organization_connection_attempts"."phase" = 'gitlab_namespace_selection' and "organization_connection_attempts"."provider" = 'gitlab' and "organization_connection_attempts"."candidate_external_id" is null and "organization_connection_attempts"."pkce_verifier" is null and ("organization_connection_attempts"."candidate_grant" is not null or "organization_connection_attempts"."consumed_at" is not null)));--> statement-breakpoint
ALTER TABLE "project_trigger_routes" ADD CONSTRAINT "project_trigger_routes_provider_check" CHECK ("project_trigger_routes"."provider" in ('github', 'slack', 'discord', 'linear', 'gitlab'));--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD CONSTRAINT "provider_event_receipts_provider_check" CHECK ("provider_event_receipts"."provider" in ('github', 'slack', 'discord', 'linear', 'gitlab', 'manual', 'schedule'));--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" ADD CONSTRAINT "runtime_provider_activation_provider_check" CHECK ("runtime_provider_activation"."provider" in ('github', 'slack', 'discord', 'linear', 'gitlab'));--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" ADD CONSTRAINT "runtime_provider_configuration_provider_check" CHECK ("runtime_provider_configuration"."provider" in ('github', 'slack', 'discord', 'linear', 'gitlab'));