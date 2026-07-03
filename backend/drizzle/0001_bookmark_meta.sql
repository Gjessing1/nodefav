CREATE TABLE `bookmark_meta` (
	`uuid` text PRIMARY KEY NOT NULL,
	`health` text NOT NULL,
	`http_status` integer,
	`page_title` text,
	`favicon_url` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`checked_at` integer NOT NULL,
	`ok_at` integer,
	FOREIGN KEY (`uuid`) REFERENCES `bookmarks`(`uuid`) ON UPDATE no action ON DELETE cascade
);
