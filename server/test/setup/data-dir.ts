import path from 'node:path';

// 每个测试进程的数据目录：仓库内 .work/test-data/<进程号>/，在任何测试模块读取 config 之前生效。
// config 默认用仓库根目录的 data/，那是用户实例的数据目录，测试不能写进去。
// Playwright 浏览器（评分时安装）各进程共用一份
const testData = path.resolve(import.meta.dirname, '../../../.work/test-data');
const dir = path.join(testData, String(process.pid));
process.env.WFD_DATA_DIR = dir;
process.env.WFD_DB_PATH = path.join(dir, 'db.sqlite');
process.env.WFD_PLAYWRIGHT_BROWSERS_DIR = path.join(testData, 'playwright-browsers');
