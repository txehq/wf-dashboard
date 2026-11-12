import path from 'node:path';
import { config } from '../src/config.js';
import { repairImportedVariants } from './import-run-lib.js';

// Usage: tsx scripts/repair-imported-variants.ts <source data dir> [<source data dir> ...]
// Fill in src/skills/, variant.json and the baseline export for imported variants in the current data dir (WFD_DATA_DIR / WFD_DB_PATH);
// reads the database and only adds files, so it can run while the server is running
const sources = process.argv.slice(2);
if (sources.length === 0) {
  throw new Error('Usage: repair-imported-variants.ts <source data dir> [<source data dir> ...]');
}
const result = repairImportedVariants(
  config.dbPath,
  config.dataDir,
  sources.map((s) => path.resolve(s)),
);
console.log(JSON.stringify(result, null, 2));
