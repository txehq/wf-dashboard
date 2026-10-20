import { type APIRequestContext } from './test.js';
import { analysisWorkflowServerPort } from '../ports.js';

// 分析由 workflow session-analysis 驱动（Contracts 19.2、19.3）的基础档 e2e（analysis-*.spec.ts，project analysis-workflow）
// 共用的数据。数据由 prepare-analysis-workflow-e2e 每次重建（一轮的短 session cfa31f10 绑定到 workflow secret-keeper 的初稿，
// session-analysis 的基线与派生的"只看失败"，一次成功的分析作为测试数据）。服务端不调用模型；Codex 是替身命令，
// skill 来源是本地 git 仓库。各文件另存与保存的 variant 都属于 secret-keeper，互不影响，可以同时运行
export const api = `http://127.0.0.1:${String(analysisWorkflowServerPort)}/api`;
export const shots = '.work/screenshots';
// 两种窗口下截图自查（Contracts 20.4）
export const sizes = [
  { width: 1280, height: 800 },
  { width: 1600, height: 1000 },
] as const;
export const session = 'cfa31f10-e280-4908-bcf7-cbe9b00fbe53';
export const aspects = [
  ['process-adherence', '流程遵守'],
  ['plan-adherence', '计划遵守'],
  ['failures', '经常失败的地方'],
  ['repeated-work', '重复的工作'],
  ['token-waste', '浪费 token'],
  ['time-waste', '浪费时间'],
  ['user-interaction', '和用户的交互'],
  ['output-quality', '产物质量'],
  ['request-conflicts', '与请求的冲突'],
] as const;

interface Summary {
  id: string;
  status: string;
  analysisVariantName: string | null;
}

// 测试数据中的那次成功的分析
export async function seeded(request: APIRequestContext): Promise<string> {
  const list = (await (await request.get(`${api}/analyses`)).json()) as Summary[];
  const found = list.find((a) => a.status === 'succeeded');
  if (found === undefined) throw new Error('测试数据中没有成功的分析');
  return found.id;
}
