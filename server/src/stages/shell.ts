import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

// wasm 在模块加载时初始化一次，之后的解析是同步的（ingest 的粗判在同步的导入事务中调用）
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')));

// $'…' 中的转义（bash 手册 ANSI-C Quoting）
const ANSI_C_ESCAPE =
  /\\([0-7]{1,3}|x[\dA-Fa-f]{1,2}|u[\dA-Fa-f]{1,4}|U[\dA-Fa-f]{1,8}|c[\s\S]|[\s\S])/g;
const ANSI_C_LETTERS: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

// \x 与八进制给出的是字节（例如 $'\xef\xbf\xbd' 是一个 U+FFFD），按 UTF-8 拼回字符串
function ansiC(body: string): string {
  const bytes: Buffer[] = [];
  let at = 0;
  for (const m of body.matchAll(ANSI_C_ESCAPE)) {
    const [all, e = ''] = m;
    bytes.push(Buffer.from(body.slice(at, m.index)), ansiCEscape(all, e));
    at = m.index + all.length;
  }
  bytes.push(Buffer.from(body.slice(at)));
  return Buffer.concat(bytes).toString('utf8');
}

function ansiCEscape(all: string, e: string): Buffer {
  const kind = e.charAt(0);
  if (kind === 'c' && e.length === 2) return Buffer.from([e.charCodeAt(1) & 0x1f]);
  if (kind === 'x' && e.length > 1) return Buffer.from([parseInt(e.slice(1), 16)]);
  if ((kind === 'u' || kind === 'U') && e.length > 1) {
    const cp = parseInt(e.slice(1), 16);
    // 超出 Unicode 范围的 bash 原样保留
    return Buffer.from(cp > 0x10ffff ? all : String.fromCodePoint(cp));
  }
  if (kind >= '0' && kind <= '7') return Buffer.from([parseInt(e, 8) & 0xff]);
  return Buffer.from(ANSI_C_LETTERS[e] ?? all);
}

// 未加引号的字面文本：反斜杠转义下一个字符，反斜杠加换行是续行；含 glob 字符时不是字面量
function bare(text: string): string | null {
  if (/[*?]/.test(text)) return null;
  return text.replace(/\\(\n|[\s\S])/g, (_, c: string) => (c === '\n' ? '' : c));
}

// 双引号中的字面文本：只有 \$ \` \" \\ 与续行是转义
function quoted(text: string): string {
  return text.replace(/\\([$`"\\\n])/g, (_, c: string) => (c === '\n' ? '' : c));
}

// 由几部分连成的词（双引号字符串、concatenation）：子节点之间的文本（例如换行、末尾的 $）按 literal 解释
function joined(node: Node, from: number, to: number, literal: (text: string) => string | null) {
  let out = '';
  let at = from;
  for (const child of node.namedChildren) {
    const start = child.startIndex - node.startIndex;
    const parts = [
      literal(node.text.slice(at, start)),
      child.type === 'string_content' ? quoted(child.text) : wordOf(child),
    ];
    for (const part of parts) {
      if (part === null) return null;
      out += part;
    }
    at = child.endIndex - node.startIndex;
  }
  const tail = literal(node.text.slice(at, to));
  return tail === null ? null : out + tail;
}

// 一个词的值：引号去掉、转义还原，变量与参数展开（$X、${o:+-c}）保持原文；
// 含命令替换、算术展开、进程替换、未加引号的 glob 时不是字面量，为 null
function wordOf(node: Node): string | null {
  switch (node.type) {
    case 'word':
      return bare(node.text);
    case 'number':
    case 'variable_name':
    case 'simple_expansion':
    case 'expansion':
    case 'array':
    case 'regex':
    case '$':
    case '==':
    case '=~':
      return node.text;
    case 'raw_string':
      return node.text.slice(1, -1);
    case 'ansi_c_string':
      return ansiC(node.text.slice(2, -1));
    case 'string':
      return joined(node, 1, node.text.length - 1, quoted);
    case 'translated_string': {
      // $"…" 是 $ 加一个双引号字符串
      const inner = node.firstNamedChild;
      if (inner === null) throw new Error(`$"…" 中没有字符串：${node.text}`);
      return wordOf(inner);
    }
    case 'concatenation':
      return joined(node, 0, node.text.length, bare);
    case 'command_substitution':
    case 'process_substitution':
    case 'arithmetic_expansion':
    case 'brace_expression':
      return null;
    default:
      throw new Error(`tree-sitter-bash 的词中出现未知的节点 ${node.type}：${node.text}`);
  }
}

// 一条 shell 脚本中的每个简单命令的 argv（含复合命令、管道、命令替换中的命令）。
// 每个词取自 tree-sitter-bash 语法树中命令的 name 与 argument 节点：命令前的变量赋值与重定向（含 heredoc 正文）
// 不在 argv 中，非字面量的词不计入
export function commandsOf(script: string): string[][] {
  const tree = parser.parse(script);
  if (tree === null) throw new Error('tree-sitter-bash 没有返回语法树');
  const out: string[][] = [];
  const walk = (node: Node) => {
    if (node.type === 'command') {
      const argv: string[] = [];
      node.children.forEach((child, i) => {
        const field = node.fieldNameForChild(i);
        if (field !== 'name' && field !== 'argument') return;
        const word = wordOf(field === 'name' ? (child.firstNamedChild ?? child) : child);
        if (word !== null) argv.push(word);
      });
      out.push(argv);
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
