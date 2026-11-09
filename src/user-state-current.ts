import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from './auth.ts';
import { problem, transaction } from './db.ts';
import { parseUserStateCurrentSnapshot, USER_STATE_CURRENT_MAX_BYTES } from './user-state-current-protocol.ts';
import { currentUserStateSnapshot, mergeCurrentUserState } from './user-state-current-store.ts';

export function registerUserStateCurrent(app: FastifyInstance, db: DatabaseSync): void {
  const authorize = (request: FastifyRequest) => {
    if (authenticate(db, request).kind !== 'device') throw problem(403, 'Device key required');
  };
  const onRequest = async (request: FastifyRequest, reply: { header: (key: string, value: string) => unknown }) => {
    reply.header('Cache-Control', 'no-store'); authorize(request);
  };
  const security = [{ bearerAuth: [] }];
  app.get('/api/v1/user-state/current', { onRequest, schema: { security } }, async () => currentUserStateSnapshot(db));
  app.post('/api/v1/user-state/current', { onRequest, bodyLimit: USER_STATE_CURRENT_MAX_BYTES, schema: { security, body: { type: 'object' } } }, async request => {
    const current = parseUserStateCurrentSnapshot(request.body);
    authorize(request); // A device can be blocked while its complete snapshot arrives.
    return transaction(db, () => mergeCurrentUserState(db, current));
  });
  const upgrade = async () => { throw problem(426, 'Upgrade Norea to exchange current SQLite state. Legacy edit-history synchronization is no longer accepted.'); };
  app.get('/api/v1/user-state', { onRequest, schema: { security } }, upgrade);
  for (const path of ['read', 'merge']) app.post('/api/v1/user-state/' + path, { onRequest, bodyLimit: USER_STATE_CURRENT_MAX_BYTES, schema: { security } }, upgrade);
}
