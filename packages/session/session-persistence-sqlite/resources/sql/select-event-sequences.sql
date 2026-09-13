SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
FROM events
WHERE session_id = ? AND type = ? AND seq < ?
  AND (? IS NULL OR surface_op = ?)
ORDER BY seq DESC
LIMIT ?;
