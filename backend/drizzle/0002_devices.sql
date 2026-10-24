CREATE TABLE `devices` (
	`device_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`last_seen_at` integer NOT NULL
);
