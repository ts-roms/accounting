import './src/config/load-env';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://accounting:accounting@localhost:5433/accounting',
  },
  strict: true,
  verbose: true,
});
