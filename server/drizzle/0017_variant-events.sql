CREATE TABLE `variant_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`variant_id` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `variant_events_variant_idx` ON `variant_events` (`variant_id`,`id`);