import path from 'node:path';
import { config } from '../src/config.js';
import { repairImportedVariants } from './import-run-lib.js';

// 用法：tsx scripts/repair-imported-variants.ts <来源数据目录> [<来源数据目录> …]
// 为当前数据目录（WFD_DATA_DIR / WFD_DB_PATH）中导入的 variant 补齐 src/skills/、variant.json 与基线导出；
// 只读数据库、只补文件，服务运行中也可以执行
const sources = process.argv.slice(2);
if (sources.length === 0) {
  throw new Error('用法：repair-imported-variants.ts <来源数据目录> [<来源数据目录> …]');
}
const result = repairImportedVariants(
  config.dbPath,
  config.dataDir,
  sources.map((s) => path.resolve(s)),
);
console.log(JSON.stringify(result, null, 2));
