import { Pool, type PoolClient, type QueryResultRow } from "pg";

/** The minimal query surface the repositories need. Satisfied by a pg Pool or a checked-out client. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** A pool that can also hand out a client for transactions. */
export interface Database extends Queryable {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

/**
 * With no URL, node-postgres reads PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT and PGSSLMODE.
 */
export function createPool(databaseUrl?: string): Database {
  return new Pool({ ...(databaseUrl ? { connectionString: databaseUrl } : {}), max: 10 });
}

export async function withTransaction<T>(db: Database, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
