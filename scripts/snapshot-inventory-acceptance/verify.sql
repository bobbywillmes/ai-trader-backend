SELECT count(*) AS tracked_position_count FROM "TrackedPosition";
SELECT md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY row_to_json(t)::text), '')) AS tracked_position_digest FROM "TrackedPosition" t;
