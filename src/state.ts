import type { DatabaseSync } from 'node:sqlite';
import { canonicalize } from 'json-canonicalize';
import { Ajv } from 'ajv';
import { problem, transaction } from './db.ts';

export interface StateMutation { key: string; baseVersion: number; operationId: string; deviceName: string; value: Record<string, unknown> }
interface Candidate { operationId: string; deviceName: string; value: Record<string, unknown> }
export interface StateEntry { key: string; version: number; value: Record<string, unknown>; conflicts: Candidate[] }

const identityString = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))+"`;
const progress = { type: 'number', minimum: 0, maximum: 100 };
const membershipValue = { type: 'object', additionalProperties: false, required: ['deleted'], properties: { deleted: { type: 'boolean' } } };
const values = {
  library: membershipValue,
  bookmark: membershipValue,
  read: { type: 'object', additionalProperties: false, required: ['unread','progress'], properties: { unread: { type: 'boolean' }, progress } },
  position: { type: 'object', additionalProperties: false, required: ['chapterPath','progress','readAt'], properties: { chapterPath: { type: 'string', minLength: 1, maxLength: 4096 }, progress, readAt: { anyOf: [{ type: 'null' }, { type: 'number', minimum: 0 }] }, locator: { type: 'string', maxLength: 65536 } } },
};
export const stateMutationSchema = {
  type: 'object', additionalProperties: false,
  required: ['key','baseVersion','operationId','deviceName','value'],
  properties: {
    key: { type: 'string', maxLength: 16384, description: 'Prefix plus canonical JSON.stringify([pluginId, novelPath, chapterPath]). Work-level library and position keys use an empty chapterPath; read and bookmark keys require a nonempty chapterPath.' },
    baseVersion: { type: 'integer', minimum: 0 },
    operationId: { type: 'string', minLength: 1, maxLength: 200 },
    deviceName: { type: 'string', minLength: 1, maxLength: 200 },
    value: { type: 'object' },
  },
  oneOf: Object.entries(values).map(([kind, value]) => ({
    properties: {
      key: { type: 'string', pattern: `^${kind}:\\[${identityString},${identityString},${kind === 'library' || kind === 'position' ? '""' : identityString}\\]$` },
      value,
    },
  })),
};
const validateMutation = new Ajv({ coerceTypes: false, removeAdditional: false, strict: false }).compile<StateMutation>(stateMutationSchema);

export function validateStateMutation(value: unknown): asserts value is StateMutation {
  if (!validateMutation(value)) throw problem(400, 'Invalid state mutation identity or value');
  const mutation = value as StateMutation;
  const raw = mutation.key.slice(mutation.key.indexOf(':') + 1);
  const identity: unknown = JSON.parse(raw);
  if (!Array.isArray(identity) || identity.length !== 3 || identity.some(part => typeof part !== 'string' || part.length > 4096 || !part.isWellFormed()) || JSON.stringify(identity) !== raw) throw problem(400, 'State identity must use a canonical array of three strings');
}

export function mutateState(db: DatabaseSync, accountId: string, mutation: StateMutation): { status: number; entry: StateEntry } {
  validateStateMutation(mutation);
  const request = canonicalize(mutation);
  return transaction(db, () => {
    const previous = db.prepare('SELECT request,response,status FROM operations WHERE account_id=? AND operation_id=?').get(accountId, mutation.operationId) as { request: string; response: string; status: number } | undefined;
    if (previous) {
      if (previous.request !== request) throw problem(409, 'Operation ID was already used with different data');
      return { status: previous.status, entry: JSON.parse(previous.response) };
    }
    const row = db.prepare('SELECT entry,candidate FROM state WHERE account_id=? AND key=?').get(accountId, mutation.key) as { entry: string; candidate: string } | undefined;
    const current: StateEntry = row ? JSON.parse(row.entry) : { key: mutation.key, version: 0, value: {}, conflicts: [] };
    if (mutation.baseVersion > current.version) throw problem(409, 'Base version is ahead of server state');
    const candidate: Candidate = { operationId: mutation.operationId, deviceName: mutation.deviceName, value: mutation.value };
    const entry: StateEntry = { key: mutation.key, version: current.version + 1, value: mutation.value, conflicts: [] };
    let status = 200;
    if (mutation.key.startsWith('library:') || mutation.key.startsWith('bookmark:')) {
      if (mutation.baseVersion < current.version && current.value.deleted === true) entry.value = current.value;
    } else if (mutation.baseVersion < current.version) {
      entry.value = current.value;
      entry.conflicts = [...(current.conflicts.length ? current.conflicts : [JSON.parse(row!.candidate)]), candidate];
      status = 409;
    }
    db.prepare('INSERT INTO state VALUES(?,?,?,?) ON CONFLICT(account_id,key) DO UPDATE SET entry=excluded.entry,candidate=excluded.candidate').run(accountId, mutation.key, JSON.stringify(entry), JSON.stringify(candidate));
    db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(accountId, mutation.operationId, request, JSON.stringify(entry), status);
    return { status, entry };
  });
}
