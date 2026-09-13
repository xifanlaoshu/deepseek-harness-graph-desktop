SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable
FROM events
WHERE session_id = ?
  AND seq >= ?
  AND seq < ?
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(?) AS excluded
    WHERE events.type LIKE excluded.value || '%'
  )
ORDER BY seq DESC
LIMIT ?;
