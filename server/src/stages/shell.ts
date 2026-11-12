import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

// The wasm initializes once at module load; later parses are synchronous (ingest's rough classification calls them
// inside the synchronous import transaction)
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')));

// Escapes inside $'…' (bash manual, ANSI-C Quoting)
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

// \x and octal escapes give bytes (e.g. $'\xef\xbf\xbd' is one U+FFFD); join them back into a string as UTF-8
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
    // bash keeps code points beyond the Unicode range as written
    return Buffer.from(cp > 0x10ffff ? all : String.fromCodePoint(cp));
  }
  if (kind >= '0' && kind <= '7') return Buffer.from([parseInt(e, 8) & 0xff]);
  return Buffer.from(ANSI_C_LETTERS[e] ?? all);
}

// Unquoted literal text: a backslash escapes the next character, backslash-newline continues the line; text with
// glob characters is not a literal
function bare(text: string): string | null {
  if (/[*?]/.test(text)) return null;
  return text.replace(/\\(\n|[\s\S])/g, (_, c: string) => (c === '\n' ? '' : c));
}

// Literal text inside double quotes: only \$ \` \" \\ and line continuation are escapes
function quoted(text: string): string {
  return text.replace(/\\([$`"\\\n])/g, (_, c: string) => (c === '\n' ? '' : c));
}

// A word made of several parts (double-quoted string, concatenation): text between children (e.g. newlines, a
// trailing $) is read with literal
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

// A word's value: quotes removed, escapes restored, variable and parameter expansions ($X, ${o:+-c}) kept as written;
// null (not a literal) with command substitution, arithmetic expansion, process substitution or an unquoted glob
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
      // $"…" is $ followed by a double-quoted string
      const inner = node.firstNamedChild;
      if (inner === null) throw new Error(`No string inside $"…": ${node.text}`);
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
      throw new Error(`Unknown node ${node.type} in a tree-sitter-bash word: ${node.text}`);
  }
}

// The argv of every simple command in a shell script (including those in compound commands, pipelines and command
// substitutions). Each word comes from the command's name and argument nodes in the tree-sitter-bash tree: variable
// assignments and redirections before the command (including heredoc bodies) are not in argv; non-literal words are
// skipped
export function commandsOf(script: string): string[][] {
  const tree = parser.parse(script);
  if (tree === null) throw new Error('tree-sitter-bash returned no syntax tree');
  const out: string[][] = [];
  const walk = (node: Node) => {
    if (node.type === 'command') out.push(argvOf(node));
    for (const child of node.namedChildren) walk(child);
  };
  walk(tree.rootNode);
  tree.delete();
  return out;
}

function argvOf(node: Node): string[] {
  const argv: string[] = [];
  node.children.forEach((child, i) => {
    const field = node.fieldNameForChild(i);
    if (field !== 'name' && field !== 'argument') return;
    const word = wordOf(field === 'name' ? (child.firstNamedChild ?? child) : child);
    if (word !== null) argv.push(word);
  });
  return argv;
}

const hasCommand = (node: Node): boolean =>
  node.namedChildren.some((c) => c.type === 'command' || hasCommand(c));

// The argv of each command in a script made only of simple commands joined by ;, &&, || or newlines; null with
// pipelines, redirections, subshells, control structures, command substitution or syntax errors
export function sequenceOf(script: string): string[][] | null {
  const tree = parser.parse(script);
  if (tree === null) throw new Error('tree-sitter-bash returned no syntax tree');
  const out: string[][] = [];
  const walk = (node: Node): boolean => {
    if (node.type === 'program' || node.type === 'list') return node.namedChildren.every(walk);
    if (node.type === 'comment') return true;
    if (node.type !== 'command' || hasCommand(node)) return false;
    out.push(argvOf(node));
    return true;
  };
  const simple = !tree.rootNode.hasError && walk(tree.rootNode);
  tree.delete();
  return simple ? out : null;
}

// The arguments of a wf obsidian call (clap's --name value and --name=value forms)
export interface ObsidianArgs {
  kind: string | null;
  file: string | null;
  replace: boolean;
  dryRun: boolean;
  help: boolean;
  json: boolean;
}

// Its arguments when argv is wf obsidian, otherwise null
export function obsidianArgs(argv: string[]): ObsidianArgs | null {
  if (argv[0] !== 'wf') return null;
  // --json is a global flag and may come before the subcommand
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
