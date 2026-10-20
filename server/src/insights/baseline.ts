import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { variants as variantsTable } from '../db/schema.js';
import type { Variant, Variants } from '../variants/index.js';
import { skillsHash } from '../variants/skills.js';
import { analysisBaselineSrc } from '../workflows/index.js';
import { ANALYSIS_WORKFLOW } from '../workflows/schema.js';

// session-analysis 的基线 variant（Contracts 19.2）：src/ 取自仓库 server/src/workflows/session-analysis/，
// 没有 parent、不来自草稿。仓库中的 skill 改动后，启动时另建一个内容相同的基线，之前的基线保留（旧分析引用它们）

function baselines(db: Db): Variant[] {
  return db
    .select()
    .from(variantsTable)
    .where(
      and(
        eq(variantsTable.workflowId, ANALYSIS_WORKFLOW),
        isNull(variantsTable.parentId),
        isNull(variantsTable.draftId),
        // 删除的基线不再使用：启动时按仓库内容重新建出（Contracts 24.3）
        isNull(variantsTable.deletedAt),
      ),
    )
    .orderBy(desc(variantsTable.createdAt))
    .all();
}

// 与仓库中的 skill 内容相同的基线；新建分析默认用它
export function currentAnalysisBaseline(db: Db): Variant | null {
  const hash = skillsHash(analysisBaselineSrc);
  return baselines(db).find((v) => v.skillsHash === hash) ?? null;
}

// 服务启动时调用：没有与仓库内容相同的基线时新建；构建（18.6 的自有管理器）后冻结，内容只能派生新 variant 来改
export async function ensureAnalysisBaseline(db: Db, variants: Variants): Promise<Variant> {
  const existing = currentAnalysisBaseline(db);
  const baseline =
    existing ??
    variants.createFromSource({
      srcDir: analysisBaselineSrc,
      workflowId: ANALYSIS_WORKFLOW,
      name: variants.freeName(ANALYSIS_WORKFLOW, '基线'),
      description: null,
      parentId: null,
      draftId: null,
      analysisId: null,
      note: `session-analysis 的基线：${analysisBaselineSrc} 中的 skill`,
    });
  if (baseline.status === 'frozen') return baseline;
  if (baseline.buildStatus !== 'built' || baseline.builtHash !== baseline.skillsHash) {
    await variants.build(baseline.id);
  }
  return variants.freeze(baseline.id);
}
