import fs from 'node:fs';
import path from 'node:path';

// 仓库根目录的 data/ 是用户实例的数据目录：测试运行前后 data/runs、data/variants 的条目与 db.sqlite* 文件不能有新增
const data = path.resolve(import.meta.dirname, '../../../data');

function entries(): Set<string> {
  const out = new Set<string>();
  for (const sub of ['runs', 'variants']) {
    const dir = path.join(data, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) out.add(path.join(dir, name));
  }
  if (fs.existsSync(data)) {
    for (const name of fs.readdirSync(data)) {
      if (name.startsWith('db.sqlite')) out.add(path.join(data, name));
    }
  }
  return out;
}

export function setup() {
  const before = entries();
  return () => {
    const added = [...entries()].filter((p) => !before.has(p)).sort();
    if (added.length > 0) {
      throw new Error(`测试写入了仓库根目录的 data/（用户实例的数据目录）：\n${added.join('\n')}`);
    }
  };
}
