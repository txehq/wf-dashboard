CREATE TABLE `artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`location` text NOT NULL,
	`snapshot` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_run_kind_idx` ON `artifacts` (`run_id`,`kind`);--> statement-breakpoint
CREATE TABLE `batch_tasks` (
	`batch_id` text NOT NULL,
	`task_id` text NOT NULL,
	PRIMARY KEY(`batch_id`, `task_id`),
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `batch_tasks_task_idx` ON `batch_tasks` (`task_id`);--> statement-breakpoint
CREATE TABLE `batch_variants` (
	`batch_id` text NOT NULL,
	`variant_id` text NOT NULL,
	PRIMARY KEY(`batch_id`, `variant_id`),
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `batch_variants_variant_idx` ON `batch_variants` (`variant_id`);--> statement-breakpoint
CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`repeats` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `grade_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`grade_id` integer NOT NULL,
	`item_id` text NOT NULL,
	`criterion` text NOT NULL,
	`score` integer NOT NULL,
	`max_score` integer NOT NULL,
	`reasoning` text NOT NULL,
	FOREIGN KEY (`grade_id`) REFERENCES `grades`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grade_items_grade_item_idx` ON `grade_items` (`grade_id`,`item_id`);--> statement-breakpoint
CREATE TABLE `grades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`artifact` text,
	`artifact_id` integer,
	`judge_model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`tests_passed` integer,
	`tests_declared` integer,
	`reached_end` integer,
	`ic_detail` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `grades_run_idx` ON `grades` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `grades_run_artifact_idx` ON `grades` (`run_id`,`artifact`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`seq` integer NOT NULL,
	`agent_id` text,
	`timestamp` integer NOT NULL,
	`trigger_at` integer,
	`model` text NOT NULL,
	`thinking` text,
	`text` text,
	`tool_calls` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_creation_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`duration_ms` integer,
	`attribution_skill` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requests_session_message_idx` ON `requests` (`session_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `requests_session_agent_seq_idx` ON `requests` (`session_id`,`agent_id`,`seq`);--> statement-breakpoint
CREATE TABLE `run_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_messages_run_seq_idx` ON `run_messages` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`task_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`repeat_index` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`human_intervened` integer DEFAULT false NOT NULL,
	`session_id` text NOT NULL,
	`workspace_path` text NOT NULL,
	`linear_issue_id` text,
	`linear_issue_identifier` text,
	`github_repo` text,
	`pr_url` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_session_id_unique` ON `runs` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_batch_task_variant_repeat_idx` ON `runs` (`batch_id`,`task_id`,`variant_id`,`repeat_index`);--> statement-breakpoint
CREATE INDEX `runs_task_variant_idx` ON `runs` (`task_id`,`variant_id`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` integer,
	`run_id` text,
	`file_path` text NOT NULL,
	`cwd` text,
	`title` text,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`has_lfg` integer DEFAULT false NOT NULL,
	`has_ic` integer DEFAULT false NOT NULL,
	`parse_offset` integer DEFAULT 0 NOT NULL,
	`parse_state` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_file_path_unique` ON `sessions` (`file_path`);--> statement-breakpoint
CREATE INDEX `sessions_source_idx` ON `sessions` (`source_id`);--> statement-breakpoint
CREATE INDEX `sessions_run_idx` ON `sessions` (`run_id`);--> statement-breakpoint
CREATE INDEX `sessions_started_at_idx` ON `sessions` (`started_at`,`id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`variant` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_path_unique` ON `sources` (`path`);--> statement-breakpoint
CREATE TABLE `stage_analyses` (
	`session_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`has_lfg` integer NOT NULL,
	`has_ic` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stage_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`workflow` text NOT NULL,
	`version` integer DEFAULT 2 NOT NULL,
	`current_stage` text NOT NULL,
	`next_stage` text NOT NULL,
	`from_seq` integer NOT NULL,
	`to_seq` integer NOT NULL,
	`input_chars` integer NOT NULL,
	`entered` integer NOT NULL,
	`entered_at_seq` integer,
	`answer` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stage_checks_session_idx` ON `stage_checks` (`session_id`,`workflow`);--> statement-breakpoint
CREATE TABLE `stage_cycles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`workflow` text NOT NULL,
	`cycle` integer NOT NULL,
	`label` text NOT NULL,
	`start_seq` integer NOT NULL,
	`end_seq` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stage_cycles_session_workflow_cycle_idx` ON `stage_cycles` (`session_id`,`workflow`,`cycle`);--> statement-breakpoint
CREATE TABLE `stage_spans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`workflow` text NOT NULL,
	`cycle` integer NOT NULL,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`start_seq` integer,
	`end_seq` integer,
	`method` text NOT NULL,
	`evidence` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stage_spans_session_workflow_cycle_stage_idx` ON `stage_spans` (`session_id`,`workflow`,`cycle`,`stage`);--> statement-breakpoint
CREATE TABLE `subagents` (
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`file_path` text NOT NULL,
	`parent_tool_use_id` text NOT NULL,
	`agent_type` text NOT NULL,
	`description` text,
	`parse_offset` integer DEFAULT 0 NOT NULL,
	`parse_state` text NOT NULL,
	PRIMARY KEY(`session_id`, `agent_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subagents_file_path_unique` ON `subagents` (`file_path`);--> statement-breakpoint
CREATE INDEX `subagents_parent_tool_use_idx` ON `subagents` (`session_id`,`parent_tool_use_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`persona` text NOT NULL,
	`hidden_requirements` text NOT NULL,
	`input` text,
	`rubric` text,
	`ticket_title` text,
	`ticket_body` text,
	`acceptance_criteria` text,
	`repo_path` text,
	`repo_commit` text,
	`hidden_tests_dir` text,
	`test_command` text,
	`hidden_tests_manifest` text,
	`dir` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_kind_idx` ON `tasks` (`kind`);--> statement-breakpoint
CREATE TABLE `user_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text,
	`uuid` text NOT NULL,
	`kind` text NOT NULL,
	`timestamp` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_messages_session_uuid_idx` ON `user_messages` (`session_id`,`uuid`);--> statement-breakpoint
CREATE INDEX `user_messages_session_agent_time_idx` ON `user_messages` (`session_id`,`agent_id`,`timestamp`);--> statement-breakpoint
CREATE TABLE `variants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`base_commit` text NOT NULL,
	`skills_hash` text NOT NULL,
	`version` text NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`install_dir` text,
	`build_status` text DEFAULT 'none' NOT NULL,
	`built_hash` text,
	`build_error` text,
	`built_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`frozen_at` integer,
	FOREIGN KEY (`parent_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variants_name_unique` ON `variants` (`name`);--> statement-breakpoint
CREATE INDEX `variants_skills_hash_idx` ON `variants` (`skills_hash`);