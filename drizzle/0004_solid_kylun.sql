ALTER TABLE `opportunity_records` ADD `trade_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `opportunity_owner_trade_unique` ON `opportunity_records` (`owner_id`,`trade_id`);