CREATE TYPE "public"."api_key_status" AS ENUM('ACTIVE', 'REVOKED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."credential_kind" AS ENUM('API_KEY', 'BASIC', 'BEARER', 'HMAC_SECRET', 'WEBHOOK_SECRET', 'OAUTH_TOKENS');--> statement-breakpoint
CREATE TYPE "public"."integration_auth_type" AS ENUM('NONE', 'API_KEY', 'OAUTH2', 'OIDC', 'BASIC', 'HMAC', 'BEARER');--> statement-breakpoint
CREATE TYPE "public"."integration_category" AS ENUM('BANKING', 'PAYMENT', 'ECOMMERCE', 'TAX', 'PAYROLL', 'CRM', 'STORAGE', 'COMMUNICATION', 'IDENTITY', 'ANALYTICS');--> statement-breakpoint
CREATE TYPE "public"."integration_direction" AS ENUM('INBOUND', 'OUTBOUND');--> statement-breakpoint
CREATE TYPE "public"."integration_event_status" AS ENUM('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DUPLICATE', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."integration_health" AS ENUM('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."integration_log_status" AS ENUM('SUCCESS', 'FAILURE', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('CONNECTED', 'DISCONNECTED', 'CONNECTING', 'SYNCING', 'ERROR', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."notification_severity" AS ENUM('INFO', 'WARNING', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."oauth_connection_status" AS ENUM('PENDING', 'CONNECTED', 'EXPIRED', 'REVOKED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."sync_job_status" AS ENUM('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED');--> statement-breakpoint
CREATE TYPE "public"."sync_mode" AS ENUM('INCREMENTAL', 'FULL');--> statement-breakpoint
CREATE TYPE "public"."sync_trigger" AS ENUM('MANUAL', 'SCHEDULED', 'RETRY', 'RESUME', 'WEBHOOK');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('PENDING', 'DELIVERED', 'FAILED', 'RETRYING', 'EXHAUSTED', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."webhook_subscription_status" AS ENUM('ACTIVE', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."delegation_approval_policy" AS ENUM('SELF_SERVICE', 'MANAGER_APPROVAL', 'ADMIN_APPROVAL', 'DUAL_APPROVAL');--> statement-breakpoint
CREATE TYPE "public"."delegation_decision" AS ENUM('APPROVE', 'REJECT');--> statement-breakpoint
CREATE TYPE "public"."delegation_status" AS ENUM('PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED', 'CANCELLED', 'REJECTED');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'CONNECT';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'DISCONNECT';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'ROTATE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'REVOKE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'SYNC_START';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'SYNC_COMPLETE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'SYNC_FAIL';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'DELEGATION_USE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'EXPIRE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'CANCEL';--> statement-breakpoint
CREATE TABLE "api_key_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"status" "api_key_status" DEFAULT 'ACTIVE' NOT NULL,
	"company_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rate_limit_per_minute" integer DEFAULT 300 NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"rotated_from_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" char(64) NOT NULL,
	"status" text DEFAULT 'IN_PROGRESS' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_status_chk" CHECK ("idempotency_keys"."status" IN ('IN_PROGRESS', 'COMPLETED'))
);
--> statement-breakpoint
CREATE TABLE "integration_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"kind" "credential_kind" NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid,
	"integration_id" uuid,
	"direction" "integration_direction" NOT NULL,
	"event_type" text NOT NULL,
	"external_event_id" text,
	"dedupe_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "integration_event_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"correlation_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_external_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"entity_type" text NOT NULL,
	"external_id" text NOT NULL,
	"internal_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"integration_id" uuid,
	"direction" "integration_direction" NOT NULL,
	"request_id" text,
	"correlation_id" text,
	"external_event_id" text,
	"operation" text NOT NULL,
	"status" "integration_log_status" NOT NULL,
	"http_status" integer,
	"error_code" text,
	"duration_ms" integer,
	"message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"direction" "integration_direction" DEFAULT 'INBOUND' NOT NULL,
	"name" text NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lookups" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_sync_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"cursor" text,
	"last_synced_at" timestamp with time zone,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"entity" text,
	"mode" "sync_mode" DEFAULT 'INCREMENTAL' NOT NULL,
	"trigger" "sync_trigger" DEFAULT 'MANUAL' NOT NULL,
	"status" "sync_job_status" DEFAULT 'QUEUED' NOT NULL,
	"queue_job_id" text,
	"requested_by" uuid,
	"resumed_from_job_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"records_processed" integer DEFAULT 0 NOT NULL,
	"records_created" integer DEFAULT 0 NOT NULL,
	"records_updated" integer DEFAULT 0 NOT NULL,
	"records_skipped" integer DEFAULT 0 NOT NULL,
	"records_failed" integer DEFAULT 0 NOT NULL,
	"start_cursor" text,
	"last_cursor" text,
	"next_cursor" text,
	"error_code" text,
	"error_message" text,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_http_status" integer,
	"last_error" text,
	"response_time_ms" integer,
	"delivered_at" timestamp with time zone,
	"replay_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid,
	"integration_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"status" "webhook_subscription_status" DEFAULT 'ACTIVE' NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"disabled_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid,
	"provider" text NOT NULL,
	"category" "integration_category" NOT NULL,
	"name" text NOT NULL,
	"status" "integration_status" DEFAULT 'DISCONNECTED' NOT NULL,
	"health_status" "integration_health" DEFAULT 'UNKNOWN' NOT NULL,
	"health_score" integer,
	"auth_type" "integration_auth_type" DEFAULT 'NONE' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sync_schedule" text,
	"created_by" uuid,
	"connected_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"health_checked_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_health_score_chk" CHECK ("integrations"."health_score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "notification_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"throttle_minutes" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"severity" "notification_severity" DEFAULT 'INFO' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"entity_type" text,
	"entity_id" text,
	"dedupe_key" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" "oauth_connection_status" DEFAULT 'PENDING' NOT NULL,
	"state_hash" text,
	"state_expires_at" timestamp with time zone,
	"code_verifier_ciphertext" text,
	"redirect_uri" text,
	"return_to" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_account_id" text,
	"token_type" text,
	"access_expires_at" timestamp with time zone,
	"connected_by" uuid,
	"connected_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegation_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delegation_id" uuid NOT NULL,
	"approver_user_id" uuid NOT NULL,
	"decision" "delegation_decision" NOT NULL,
	"comment" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"approval_policy" "delegation_approval_policy" DEFAULT 'MANAGER_APPROVAL' NOT NULL,
	"max_duration_days" integer DEFAULT 90 NOT NULL,
	"expiry_warning_days" integer DEFAULT 2 NOT NULL,
	"revalidate_at_use" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegation_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delegation_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"branch_id" uuid,
	"max_amount" numeric(19, 4),
	"currency" char(3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delegation_scopes_amount_chk" CHECK ("delegation_scopes"."max_amount" IS NULL OR "delegation_scopes"."max_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "delegation_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delegation_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"delegate_user_id" uuid NOT NULL,
	"delegator_user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"action" text NOT NULL,
	"document_type" text NOT NULL,
	"document_id" uuid NOT NULL,
	"document_number" text,
	"amount" numeric(19, 4),
	"currency" char(3),
	"correlation_id" text,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"delegation_number" text NOT NULL,
	"delegator_user_id" uuid NOT NULL,
	"delegate_user_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"status" "delegation_status" DEFAULT 'PENDING' NOT NULL,
	"reason" text NOT NULL,
	"required_approvals" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"revoked_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"cancelled_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"expiry_notified_at" timestamp with time zone,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delegations_window_chk" CHECK ("delegations"."end_at" > "delegations"."start_at"),
	CONSTRAINT "delegations_self_chk" CHECK ("delegations"."delegator_user_id" <> "delegations"."delegate_user_id")
);
--> statement-breakpoint
ALTER TABLE "api_key_scopes" ADD CONSTRAINT "api_key_scopes_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_external_references" ADD CONSTRAINT "integration_external_references_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_logs" ADD CONSTRAINT "integration_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_logs" ADD CONSTRAINT "integration_logs_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_mappings" ADD CONSTRAINT "integration_mappings_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_mappings" ADD CONSTRAINT "integration_mappings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_scopes" ADD CONSTRAINT "integration_scopes_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_cursors" ADD CONSTRAINT "integration_sync_cursors_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_jobs" ADD CONSTRAINT "integration_sync_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_jobs" ADD CONSTRAINT "integration_sync_jobs_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_jobs" ADD CONSTRAINT "integration_sync_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_webhook_deliveries" ADD CONSTRAINT "integration_webhook_deliveries_webhook_id_integration_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."integration_webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_webhook_deliveries" ADD CONSTRAINT "integration_webhook_deliveries_event_id_integration_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."integration_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_webhooks" ADD CONSTRAINT "integration_webhooks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_webhooks" ADD CONSTRAINT "integration_webhooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_webhooks" ADD CONSTRAINT "integration_webhooks_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_webhooks" ADD CONSTRAINT "integration_webhooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_policies" ADD CONSTRAINT "notification_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_approvals" ADD CONSTRAINT "delegation_approvals_delegation_id_delegations_id_fk" FOREIGN KEY ("delegation_id") REFERENCES "public"."delegations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_approvals" ADD CONSTRAINT "delegation_approvals_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_policies" ADD CONSTRAINT "delegation_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_policies" ADD CONSTRAINT "delegation_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_scopes" ADD CONSTRAINT "delegation_scopes_delegation_id_delegations_id_fk" FOREIGN KEY ("delegation_id") REFERENCES "public"."delegations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_scopes" ADD CONSTRAINT "delegation_scopes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_usage" ADD CONSTRAINT "delegation_usage_delegation_id_delegations_id_fk" FOREIGN KEY ("delegation_id") REFERENCES "public"."delegations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_usage" ADD CONSTRAINT "delegation_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_usage" ADD CONSTRAINT "delegation_usage_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_usage" ADD CONSTRAINT "delegation_usage_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_usage" ADD CONSTRAINT "delegation_usage_delegate_user_id_users_id_fk" FOREIGN KEY ("delegate_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation_usage" ADD CONSTRAINT "delegation_usage_delegator_user_id_users_id_fk" FOREIGN KEY ("delegator_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_delegator_user_id_users_id_fk" FOREIGN KEY ("delegator_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_delegate_user_id_users_id_fk" FOREIGN KEY ("delegate_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_scopes_uq" ON "api_key_scopes" USING btree ("api_key_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_prefix_idx" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_org_status_idx" ON "api_keys" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_uq" ON "idempotency_keys" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_credentials_kind_uq" ON "integration_credentials" USING btree ("integration_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_events_external_uq" ON "integration_events" USING btree ("integration_id","external_event_id") WHERE "integration_events"."external_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_events_dedupe_uq" ON "integration_events" USING btree ("organization_id","dedupe_key") WHERE "integration_events"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "integration_events_pending_idx" ON "integration_events" USING btree ("direction","status","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_external_refs_external_uq" ON "integration_external_references" USING btree ("integration_id","entity_type","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_external_refs_internal_uq" ON "integration_external_references" USING btree ("integration_id","entity_type","internal_id");--> statement-breakpoint
CREATE INDEX "integration_logs_integration_idx" ON "integration_logs" USING btree ("integration_id","occurred_at");--> statement-breakpoint
CREATE INDEX "integration_logs_org_idx" ON "integration_logs" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_mappings_uq" ON "integration_mappings" USING btree ("integration_id","entity","direction");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_scopes_uq" ON "integration_scopes" USING btree ("integration_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_sync_cursors_uq" ON "integration_sync_cursors" USING btree ("integration_id","entity");--> statement-breakpoint
CREATE INDEX "integration_sync_jobs_integration_idx" ON "integration_sync_jobs" USING btree ("integration_id","created_at");--> statement-breakpoint
CREATE INDEX "integration_sync_jobs_status_idx" ON "integration_sync_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_webhook_deliveries_uq" ON "integration_webhook_deliveries" USING btree ("webhook_id","event_id") WHERE "integration_webhook_deliveries"."replay_of_id" IS NULL;--> statement-breakpoint
CREATE INDEX "integration_webhook_deliveries_due_idx" ON "integration_webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "integration_webhook_deliveries_webhook_idx" ON "integration_webhook_deliveries" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_webhooks_org_name_uq" ON "integration_webhooks" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "integration_webhooks_org_status_idx" ON "integration_webhooks" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_org_name_uq" ON "integrations" USING btree ("organization_id","name") WHERE "integrations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "integrations_org_status_idx" ON "integrations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "integrations_next_sync_idx" ON "integrations" USING btree ("next_sync_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_policies_uq" ON "notification_policies" USING btree ("organization_id","event_type");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "notifications_dedupe_idx" ON "notifications" USING btree ("user_id","dedupe_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_connections_integration_uq" ON "oauth_connections" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX "oauth_connections_state_idx" ON "oauth_connections" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "delegation_approvals_uq" ON "delegation_approvals" USING btree ("delegation_id","approver_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delegation_policies_org_uq" ON "delegation_policies" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delegation_scopes_uq" ON "delegation_scopes" USING btree ("delegation_id","permission","branch_id");--> statement-breakpoint
CREATE INDEX "delegation_usage_delegation_idx" ON "delegation_usage" USING btree ("delegation_id","used_at");--> statement-breakpoint
CREATE INDEX "delegation_usage_document_idx" ON "delegation_usage" USING btree ("document_type","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delegations_number_uq" ON "delegations" USING btree ("organization_id","delegation_number");--> statement-breakpoint
CREATE INDEX "delegations_delegate_idx" ON "delegations" USING btree ("delegate_user_id","status","company_id");--> statement-breakpoint
CREATE INDEX "delegations_delegator_idx" ON "delegations" USING btree ("delegator_user_id","status");--> statement-breakpoint
CREATE INDEX "delegations_window_idx" ON "delegations" USING btree ("status","end_at");