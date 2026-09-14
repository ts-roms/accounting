/* `pnpm --filter @accounting/api db:seed` */
import '../../config/load-env';
import { runSeed } from './seed';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
runSeed(url)
  .then(() => {
    console.warn('[seed] complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
