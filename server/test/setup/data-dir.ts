import path from 'node:path';

// 每个测试进程的数据目录：仓库内 .work/test-data/<进程号>/，在任何测试模块读取 config 之前生效。
// config 默认用仓库根目录的 data/，那是用户实例的数据目录，测试不能写进去。
// Playwright 浏览器（评分时安装）各进程共用一份
const testData = path.resolve(import.meta.dirname, '../../../.work/test-data');
const dir = path.join(testData, String(process.pid));
process.env.WFD_DATA_DIR = dir;
process.env.WFD_DB_PATH = path.join(dir, 'db.sqlite');
process.env.WFD_PLAYWRIGHT_BROWSERS_DIR = path.join(testData, 'playwright-browsers');
// 本地仓库模式（Contracts 7.2）：run 与交互的仓库建为这里的 bare 仓库，测试不在 GitHub 上建仓库
process.env.WFD_LOCAL_REPOS_DIR = path.join(dir, 'repos');
// 本机 Codex 的 CODEX_HOME（Contracts 25.1）：测试中为空目录，不读写用户的 ~/.codex
process.env.WFD_CODEX_HOME = path.join(dir, 'codex-home');
// 本机配置的 Claude Code projects 目录（Contracts 25.4）：测试中为这里的目录，不读写用户的 ~/.claude；
// 测试文件自己设置时以测试文件的为准
process.env.WFD_CLAUDE_PROJECTS = path.join(dir, 'claude-projects');
// Obsidian vault（Contracts 第 30 节）：测试不读用户的 MAGI_VAULT，run、交互与评分都写读这里
process.env.MAGI_VAULT = path.join(dir, 'vault');
