/**
 * Loads environment variables from the first `.env` found, checking the app
 * directory first and then the monorepo root. Existing process env wins.
 * Import this before anything that reads `process.env`.
 */
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';

const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../../.env'),
  path.resolve(__dirname, '../../../../../../.env'),
];

for (const file of candidates) {
  if (existsSync(file)) {
    config({ path: file, quiet: true });
    break;
  }
}
