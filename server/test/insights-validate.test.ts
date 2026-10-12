import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { ingestFile } from '../src/ingest/ingest.js';
import { writeInput } from '../src/insights/export.js';
import {
  applyHunks,
  evidenceIndex,
  validateFindings,
  validatePatches,
} from '../src/insights/validate.js';
import { syncTasks } from '../src/tasks/loader.js';
import { createVariants } from '../src/variants/index.js';
import { BASE_COMMIT, IC, unpackSession, workDir } from './helpers/session-fixtures.js';

// Contracts 15.2 的校验：用写好的输出文件直接测试校验函数，不调用引擎
const dir = workDir('insights-validate');
const db = openDatabase(path.join(dir, 'db.sqlite'), config.migrationsDir);
syncTasks(db, config.tasksDir);
const variants = createVariants({
  db,
  dataDir: path.join(dir, 'data'),
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const inputDir = path.join(dir, 'analysis', 'input');
const outputDir = path.join(dir, 'analysis', 'output');
fs.mkdirSync(outputDir, { recursive: true });

afterAll(() => {
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

ingestFile(db, unpackSession(dir, IC));
const variant = await variants.createBaseline({
  name: 'w31-validate',
  commit: BASE_COMMIT,
});
const exported = await writeInput(db, {
  analysisId: 'a-20261012-valid1',
  variant: { id: variant.id, name: variant.name },
  skillsDir: variants.layout(variant.id).skills,
  sessionIds: [IC.sessionId],
  inputDir,
});
const index = evidenceIndex(exported);
const rows = exported.get(IC.sessionId) ?? [];

const write = (name: string, value: unknown) => {
  const file = path.join(outputDir, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
};

describe('分析的输入与校验', () => {
  test('导出的请求行包含主 agent 与子代理、完整的 tool 结果与阶段', () => {
    const lines = fs
      .readFileSync(path.join(inputDir, 'sessions', `${IC.sessionId}.jsonl`), 'utf8')
      .trim()
      .split('\n');
    expect(lines.length).toBe(rows.length);
    const main = rows.filter((r) => r.agent === null);
    const sub = rows.filter((r) => r.agent !== null);
    expect(main.length).toBe(34);
    expect(sub.length).toBeGreaterThan(0);
    // 子代理行指回启动它的 Agent 调用所在的主 agent 请求
    for (const r of sub) {
      const parent = main.find((m) => m.seq === r.parentSeq);
      expect(parent?.toolCalls.some((c) => c.subagentId === r.agent)).toBe(true);
    }
    expect(main.some((r) => r.stage === 'ic#1 implement')).toBe(true);
    expect(main[0]?.userMessagesBefore[0]).toEqual({ kind: 'user', text: '/ic TXE-3767' });
    expect(main.some((r) => r.skillLoads.some((l) => l.name === 'claim'))).toBe(true);
    // 结果溢出到文件的调用带有文件的完整内容
    expect(rows.some((r) => r.toolCalls.some((c) => (c.spilledOutput ?? '').length > 20_000))).toBe(
      true,
    );
    for (const name of ['stages.json', 'conversation.json']) {
      expect(fs.existsSync(path.join(inputDir, 'sessions', IC.sessionId, name))).toBe(true);
    }
    expect(fs.existsSync(path.join(inputDir, 'skills', 'claim', 'SKILL.md'))).toBe(true);
  });

  const seqWithText = rows.find((r) => r.agent === null && (r.text ?? '').length > 40);
  if (seqWithText?.text == null) throw new Error('没有带文字的主 agent 请求');
  const goodQuote = seqWithText.text.slice(0, 30);
  const finding = (evidence: { sessionId: string; seq: number; quote: string }[]) => ({
    title: '测试发现',
    stage: 'implement',
    skill: 'implement',
    severity: 'medium',
    detail: '说明',
    evidence,
  });

  test('证据存在且 quote 是原文子串时通过，并按位置编号', () => {
    const sub = rows.find((r) => r.agent !== null && (r.text ?? '').length > 20);
    if (sub?.text == null) throw new Error('没有带文字的子代理请求');
    const file = write('findings-process.json', [
      finding([{ sessionId: IC.sessionId, seq: seqWithText.seq, quote: goodQuote }]),
      // 子代理的内容按 parentSeq 引用
      finding([{ sessionId: IC.sessionId, seq: sub.parentSeq, quote: sub.text.slice(0, 20) }]),
    ]);
    const result = validateFindings(file, 'process', index);
    expect(result.map((f) => f.findingId)).toEqual(['process-1', 'process-2']);
  });

  test('seq 不存在、quote 不是子串时以原文失败', () => {
    const missingSeq = Math.max(...rows.filter((r) => r.agent === null).map((r) => r.seq)) + 1000;
    const file = write('findings-quality.json', [
      finding([{ sessionId: IC.sessionId, seq: missingSeq, quote: goodQuote }]),
      finding([
        { sessionId: IC.sessionId, seq: seqWithText.seq, quote: `${goodQuote}不存在的文字` },
      ]),
    ]);
    expect(() => validateFindings(file, 'quality', index)).toThrow(
      [
        'findings-quality.json 的证据校验失败：',
        `第 1 条发现「测试发现」的证据 ${IC.sessionId}#${String(missingSeq)}：主 agent 中没有 seq ${String(missingSeq)}`,
        `第 2 条发现「测试发现」的证据 ${IC.sessionId}#${String(seqWithText.seq)}：quote 不是该行导出内容的子串：${JSON.stringify(`${goodQuote}不存在的文字`)}`,
      ].join('\n'),
    );
  });

  test('格式不对时以 zod 的原文失败', () => {
    const file = write('findings-interaction.json', [{ title: '', severity: 'urgent' }]);
    expect(() => validateFindings(file, 'interaction', index)).toThrow(
      'findings-interaction.json 的格式不对',
    );
  });

  const skillsDir = path.join(inputDir, 'skills');
  const claim = fs.readFileSync(path.join(skillsDir, 'claim', 'SKILL.md'), 'utf8');
  const changed = claim
    .replace('take the ticket, and read', 'take the ticket, then read')
    .replace('## Contract', '## Contract（输入与输出）');
  const patch = createTwoFilesPatch('a/claim/SKILL.md', 'b/claim/SKILL.md', claim, changed);

  test('patch 通过 git apply --check，修改结果拆成逐处改动并对应到发现', async () => {
    const file = write('patches.json', [
      { file: 'claim/SKILL.md', findingIds: ['process-1'], rationale: '说明', patch },
    ]);
    const { files } = await validatePatches(
      file,
      skillsDir,
      path.join(dir, 'analysis', 'check'),
      new Set(['process-1']),
    );
    expect(files.map((f) => f.path)).toEqual(['skills/claim/SKILL.md']);
    const [proposal] = files;
    if (proposal === undefined) throw new Error('没有修改建议');
    expect(proposal.proposed).toBe(changed);
    expect(proposal.hunks.length).toBe(2);
    expect(proposal.hunks.every((h) => h.findingIds.join() === 'process-1')).toBe(true);
    // 只接受第一处
    const first = proposal.hunks.slice(0, 1);
    expect(applyHunks(claim, first)).toBe(
      claim.replace('take the ticket, and read', 'take the ticket, then read'),
    );
    expect(applyHunks(claim, proposal.hunks)).toBe(changed);
  });

  test('patch 应用不上、findingIds 不存在、改了别的文件时以原文失败', async () => {
    const broken = patch.replace('take the ticket, and read', 'take the ticket, maybe read');
    const file = write('patches.json', [
      { file: 'claim/SKILL.md', findingIds: ['process-9'], rationale: '说明', patch: broken },
      { file: 'ic/SKILL.md', findingIds: ['process-1'], rationale: '说明', patch },
    ]);
    const error = await validatePatches(
      file,
      skillsDir,
      path.join(dir, 'analysis', 'check'),
      new Set(['process-1']),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('第 1 个 patch（claim/SKILL.md）：findingIds 不存在：process-9');
    expect(message).toContain('第 1 个 patch（claim/SKILL.md）：git apply --check 失败：');
    expect(message).toContain('patch does not apply');
    expect(message).toContain('第 2 个 patch（ic/SKILL.md）：patch 必须只修改 ic/SKILL.md');
  });
});
