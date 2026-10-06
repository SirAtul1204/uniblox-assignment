ALTER TABLE `orders` ADD `reward_every_n` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `reward_percent` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
-- Preserve the initialized legacy policy before removing the active settings table.
UPDATE `orders` SET
  `reward_every_n` = COALESCE((SELECT `every_n` FROM `reward_policy` WHERE `id` = 1), 5),
  `reward_percent` = COALESCE((SELECT `percent` FROM `reward_policy` WHERE `id` = 1), 10);--> statement-breakpoint
DROP TABLE `reward_policy`;
