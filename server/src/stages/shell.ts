import { createRequire } from 'node:module';
import { parse as parseWords } from 'shell-quote';
import { Language, Parser, type Node } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

let parser: Promise<Parser> | null = null;

function bashParser(): Promise<Parser> {
  parser ??= (async () => {
    await Parser.init();
    const bash = await Language.load(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'));
    const p = new Parser();
    p.setLanguage(bash);
    return p;
  })();
  return parser;
}

// 一条 shell 脚本中的每个简单命令的 argv（含复合命令、管道、命令替换中的命令）。
// tree-sitter-bash 给出命令的位置，heredoc 正文属于重定向，不在命令的文本内；
// shell-quote 去掉命令文本的引号得到 argv，变量保持 $NAME 原样，运算符与 glob 等非字面量不计入
export async function commandsOf(script: string): Promise<string[][]> {
  const tree = (await bashParser()).parse(script);
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
