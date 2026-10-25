-- Earlier checks treated network errors, auth walls and bot blocking as dead links.
-- Their evidence cannot be distinguished reliably, so clear those classifications.
UPDATE `bookmark_meta`
SET `health` = 'unverified', `consecutive_failures` = 0
WHERE `health` IN ('failing', 'dead');
