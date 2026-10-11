import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

export async function consoleHeaders(app: FastifyInstance, dataDir: string) {
  const password = (await readFile(join(dataDir, 'admin-password.hash'), 'utf8')).trim();
  const response = await app.inject({ method: 'POST', url: '/api/v1/console-sessions', payload: { password } });
  assert.equal(response.statusCode, 200, response.body);
  return { authorization: `Bearer ${response.json().token}` };
}

export async function deviceHeaders(app: FastifyInstance, deviceName = 'Test device') {
  const deviceKey = randomBytes(32).toString('hex');
  const response = await app.inject({ method: 'POST', url: '/api/v1/devices/register', payload: { deviceKey, deviceName } });
  assert.equal(response.statusCode, 200, response.body);
  return { authorization: `Bearer ${deviceKey}` };
}
