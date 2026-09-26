import { Pool } from 'pg';

/** The two logger methods the pool needs (a PinoLogger in the app, a stub in tests). */
export interface PoolLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface PoolOptions {
  connectionString: string;
  max: number;
  applicationName?: string;
}

/**
 * The API's node-postgres pool. A connection the server drops (restart,
 * failover, admin kill, idle-in-transaction timeout) emits 'error' on its
 * client; with no listener Node treats that as unhandled and exits the whole
 * process, taking every in-flight request and the in-process job workers with
 * it. The pool only listens while a client is idle, so every client also gets
 * its own listener for the time it is checked out: the query in flight still
 * rejects, the transaction rolls back, and the pool discards the broken client.
 */
export function createPool(options: PoolOptions, logger: PoolLogger): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max,
    // Idle sockets through a Docker / NAT port proxy get silently dropped; keepalives keep
    // the mapping alive and a short idle timeout retires clients before that happens.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: options.applicationName ?? 'accounting-api',
  });
  pool.on('error', (err) => logger.error({ err }, 'Idle database connection lost'));
  pool.on('connect', (client) => {
    client.on('error', (err) =>
      logger.warn({ err }, 'Database connection lost while in use; its request fails'),
    );
  });
  return pool;
}
