CREATE TABLE `paid_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`ok` integer NOT NULL,
	`detail` text NOT NULL,
	`fix` text NOT NULL,
	`checked_at` integer NOT NULL
);
