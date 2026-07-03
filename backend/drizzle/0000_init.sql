CREATE TABLE `bookmarks` (
	`uuid` text PRIMARY KEY NOT NULL,
	`parent_uuid` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`sort_order` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`version` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookmarks_parent_idx` ON `bookmarks` (`parent_uuid`);--> statement-breakpoint
CREATE TABLE `operations` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_op_id` text NOT NULL,
	`device_id` text NOT NULL,
	`type` text NOT NULL,
	`bookmark_uuid` text NOT NULL,
	`payload` text NOT NULL,
	`client_timestamp` integer NOT NULL,
	`applied_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operations_client_op_id_idx` ON `operations` (`client_op_id`);--> statement-breakpoint
CREATE INDEX `operations_bookmark_uuid_idx` ON `operations` (`bookmark_uuid`);