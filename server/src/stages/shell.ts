import { createRequire } from 'node:module';
import { parse as parseWords } from 'shell-quote';
import { Language, Parser, type Node } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

// wasm 在模块加载时初始化一次，之后的解析是同步的（ingest 的粗判在同步的导入事务中调用）
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')));

// 一条 shell 脚本中的每个简单命令的 argv（含复合命令、管道、命令替换中的命令）。
// tree-sitter-bash 给出命令的位置，heredoc 正文属于重定向，不在命令的文本内；
// shell-quote 去掉命令文本的引号得到 argv，变量保持 $NAME 原样，运算符与 glob 等非字面量不计入
export function commandsOf(script: string): string[][] {
  const tree = parser.parse(script);
  if (tree === null) throw new Error('tree-sitter-bash 没有返回语法树');
  const out: string[][] = [];
  const walk = (node: Node) => {
    if (node.type === 'command') {
      out.push(
        parseWords(node.text, (key) => `$${key}`).filter((w): w is string => typeof w === 'string'),
      );
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(tree.rootNode);
  tree.delete();
  return out;
}

// 一次 wf obsidian 调用的参数（clap 的 --name value 与 --name=value 两种写法）
export interface ObsidianArgs {
  kind: string | null;
  file: string | null;
  replace: boolean;
  dryRun: boolean;
  help: boolean;
  json: boolean;
}

// argv 是 wf obsidian 时返回它的参数，否则为 null
export function obsidianArgs(argv: string[]): ObsidianArgs | null {
  if (argv[0] !== 'wf') return null;
  // --json 是全局参数，可以写在子命令之前
  const sub = argv.findIndex((w, i) => i > 0 && !w.startsWith('-'));
  if (sub === -1 || argv[sub] !== 'obsidian') return null;
  const value = (name: string): string | null => {
    for (const [i, w] of argv.entries()) {
      if (w === `--${name}`) return argv[i + 1] ?? null;
      if (w.startsWith(`--${name}=`)) return w.slice(name.length + 3);
    }
    return null;
  };
  const has = (...names: string[]) => argv.some((w) => names.includes(w));
  return {
    kind: value('kind'),
    file: value('file'),
    replace: has('--replace'),
    dryRun: has('--dry-run'),
    help: has('--help', '-h'),
    json: has('--json'),
  };
}
