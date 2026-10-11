import { buildApp } from './app.ts';

const app = await buildApp({ dataDir: process.env.NOREA_DATA_DIR ?? 'data', anonymousRead: process.env.NOREA_ANONYMOUS_READ !== 'false' });
await app.listen({ host: process.env.NOREA_HOST ?? '127.0.0.1', port: Number(process.env.NOREA_PORT ?? 8787) });
console.log('Norea Content Server is listening.');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await app.close(); process.exit(0); });
