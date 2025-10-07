import 'dotenv/config';
import { Client } from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // eslint-disable-next-line no-console
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const res = await client.query('select current_user, current_database()');
    // eslint-disable-next-line no-console
    console.log(res.rows[0]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('DB connect error:', e);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();


