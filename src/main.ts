import { buildApp, type UserStateMaintenanceScheduleOptions } from './app.ts';
import { MAX_TIMER_DELAY_MS } from './user-state.ts';

function optionalIntEnv(name: string, minimum = 0): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

const userStateMaintenance: UserStateMaintenanceScheduleOptions = {};
const supersededGraceMs = optionalIntEnv('NOREA_USER_STATE_SUPERSEDED_GRACE_MS', 0);
const operationBodyRetentionMs = optionalIntEnv('NOREA_USER_STATE_OP_BODY_RETENTION_MS', 0);
const operationFingerprintRetentionMs = optionalIntEnv('NOREA_USER_STATE_OP_FINGERPRINT_RETENTION_MS', 0);
const tombstoneGraceMs = optionalIntEnv('NOREA_USER_STATE_TOMBSTONE_GRACE_MS', 0);
const compactionIntervalMs = optionalIntEnv('NOREA_USER_STATE_COMPACTION_INTERVAL_MS', 0);
const vacuumPagesPerPass = optionalIntEnv('NOREA_USER_STATE_VACUUM_PAGES_PER_PASS', 1);
if (supersededGraceMs !== undefined) userStateMaintenance.supersededGraceMs = supersededGraceMs;
if (operationBodyRetentionMs !== undefined) userStateMaintenance.operationBodyRetentionMs = operationBodyRetentionMs;
if (operationFingerprintRetentionMs !== undefined) userStateMaintenance.operationFingerprintRetentionMs = operationFingerprintRetentionMs;
if (tombstoneGraceMs !== undefined) userStateMaintenance.tombstoneGraceMs = tombstoneGraceMs;
if (compactionIntervalMs !== undefined) {
  userStateMaintenance.compactionIntervalMs = Math.min(compactionIntervalMs, MAX_TIMER_DELAY_MS);
}
if (vacuumPagesPerPass !== undefined) userStateMaintenance.vacuumPagesPerPass = vacuumPagesPerPass;

const app = await buildApp({
  dataDir: process.env.NOREA_DATA_DIR ?? 'data',
  anonymousRead: process.env.NOREA_ANONYMOUS_READ !== 'false',
  ...(Object.keys(userStateMaintenance).length ? { userStateMaintenance } : {}),
});
await app.listen({ host: process.env.NOREA_HOST ?? '127.0.0.1', port: Number(process.env.NOREA_PORT ?? 8787) });
console.log('Norea Content Server is listening.');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await app.close(); process.exit(0); });
