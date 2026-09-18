-- Aggregate counts of what the gate turned away, by day and reason. The
-- `question refused` event in PostHog carries the same reason and is easier to
-- query, so this was two systems counting the same thing. Dropping it also
-- removes a D1 write from every blocked request.
DROP TABLE IF EXISTS gate_rejections;
