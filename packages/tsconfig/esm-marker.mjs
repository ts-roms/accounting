// Writes dist/esm/package.json ({ "type": "module" }) so Node loads the ESM
// build of a workspace package as ES modules while dist/*.js stays CommonJS.
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist/esm', { recursive: true });
writeFileSync('dist/esm/package.json', '{ "type": "module" }\n');
