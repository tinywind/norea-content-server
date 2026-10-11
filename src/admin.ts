import { provisionAccount } from './auth.ts';

const [username, role = 'member'] = process.argv.slice(2);
const password = process.env.NOREA_ACCOUNT_PASSWORD;
if (!username || !password || !['admin','member'].includes(role)) {
  console.error('Usage: NOREA_ACCOUNT_PASSWORD=<password> pnpm admin <username> [admin|member]');
  process.exitCode = 1;
} else {
  await provisionAccount(process.env.NOREA_DATA_DIR ?? 'data', username, password, role as 'admin' | 'member');
  console.log('Account provisioned. Existing sessions for this account were revoked.');
}
