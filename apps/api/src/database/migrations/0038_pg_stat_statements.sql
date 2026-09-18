-- Statement statistics for the operations console (GET /operations/statements).
-- Best effort: the extension needs shared_preload_libraries on the server and
-- CREATE privilege on the database. Where either is missing (a managed
-- PostgreSQL without it enabled) the migration still succeeds and the console
-- reports the extension as unavailable with the statement to run.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_stat_statements not enabled: %', SQLERRM;
END $$;
