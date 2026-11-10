import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export const retentionDays = () =>
  Number(process.env.CONVERSATION_RETENTION_DAYS ?? 90);

// Small batches keep each DELETE short, so turn writes never wait long on row locks.
const BATCH = 1000;
// Any constant works; it only has to match on every replica.
const LOCK_KEY = 7_340_090;

// Table → the timestamp it expires by. Agent memory episodes live as long as transcripts.
const TABLES = [
  ['conversations', 'updated_at'],
  ['memory_episodes', 'created_at'],
] as const;

/**
 * Deletes transcripts not touched, and memory episodes not written, for
 * `CONVERSATION_RETENTION_DAYS` (PRD: 90 days). Memory facts stay until the shopper deletes them.
 * Runs on every replica; the advisory lock lets one of them do the work.
 */
@Injectable()
export class ConversationRetentionJob {
  private readonly log = new Logger(ConversationRetentionJob.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'conversation-retention' })
  async run(): Promise<number> {
    const days = retentionDays();
    if (!Number.isFinite(days) || days < 1) {
      this.log.warn(`CONVERSATION_RETENTION_DAYS=${days} is invalid; skipping`);
      return 0;
    }
    // Session-level lock, so take and release it on one connection.
    const runner = this.db.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }]: { locked: boolean }[] = await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [LOCK_KEY],
      );
      if (!locked) return 0;
      try {
        let total = 0;
        for (const [table, column] of TABLES) {
          let deleted = 0;
          for (;;) {
            // Uses the timestamp index; ctid avoids a second index lookup per row.
            const [, count]: [unknown, number] = await runner.query(
              `DELETE FROM "${table}" WHERE ctid IN (
                 SELECT ctid FROM "${table}"
                 WHERE "${column}" < now() - make_interval(days => $1)
                 LIMIT $2)`,
              [days, BATCH],
            );
            deleted += count;
            if (count < BATCH) break;
          }
          if (deleted)
            this.log.log(`Deleted ${deleted} ${table} older than ${days} days`);
          total += deleted;
        }
        return total;
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
      }
    } finally {
      await runner.release();
    }
  }
}
