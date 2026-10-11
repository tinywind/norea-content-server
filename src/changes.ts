import type { DatabaseSync } from 'node:sqlite';
import type { ServerResponse } from 'node:http';
import { problem } from './db.ts';

export interface ChangeCursors { catalogCursor: number; workCursor: number }

export function readChangeCursors(db: DatabaseSync): ChangeCursors {
  const catalog = db.prepare('SELECT coalesce(max(sequence),0) AS cursor FROM catalog_changes').get() as { cursor: number };
  const work = db.prepare('SELECT coalesce(max(sequence),0) AS cursor FROM work_changes').get() as { cursor: number };
  return { catalogCursor: catalog.cursor, workCursor: work.cursor };
}

export function createChangeNotifications(db: DatabaseSync) {
  const pending = new Set<{ check: () => void; stop: () => void }>();
  let closed = false;
  return {
    notify() {
      for (const waiter of pending) waiter.check();
    },
    close() {
      closed = true;
      for (const waiter of pending) waiter.stop();
    },
    wait(after: { catalogCursor: number; workCursor?: number }, waitSeconds: number, response: ServerResponse): Promise<void> {
      if (closed) return Promise.reject(problem(503, 'Server is shutting down'));
      return new Promise((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          response.off('close', disconnected);
          pending.delete(waiter);
          if (error) reject(error); else resolve();
        };
        const disconnected = () => finish();
        const waiter = {
          check: () => {
            try {
              const current = readChangeCursors(db);
              if (current.catalogCursor > after.catalogCursor || (after.workCursor !== undefined && current.workCursor > after.workCursor)) finish();
            } catch (error) { finish(error as Error); }
          },
          stop: () => finish(problem(503, 'Server is shutting down')),
        };
        const timer = setTimeout(finish, waitSeconds * 1000);
        pending.add(waiter);
        response.once('close', disconnected);
        if (response.destroyed) finish(); else waiter.check();
      });
    },
  };
}
