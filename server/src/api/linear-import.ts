import type { FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { ImportPreview, ImportPreviewRequest } from '../tasks/import-schema.js';
import { previewLinearImport } from '../tasks/linear-import.js';
import type { SettingsStore } from '../runs/settings.js';

// Contracts 第 13 节：用户粘贴工单地址或编号，导入为 ic task。原工单与源仓库只读取
export function linearImportRoutes({ settings }: { settings: SettingsStore }) {
  return (fastify: FastifyInstance, _options: unknown, done: () => void) => {
    fastify.setValidatorCompiler(validatorCompiler);
    fastify.setSerializerCompiler(serializerCompiler);
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    // 预览，不保存：保存走 POST /api/tasks（带 source 的 task 在保存时生成 bundle）
    app.post(
      '/api/tasks/from-linear',
      { schema: { body: ImportPreviewRequest, response: { 200: ImportPreview } } },
      (request) => previewLinearImport(request.body, settings.get().copyRunnerLabels),
    );
    done();
  };
}
