import { describe, expect, test } from 'vitest';
import { commandsOf } from '../../src/stages/shell.js';

// 命令都取自真实 session 中的 Bash 调用，其中的用户目录写为 /Users/tester
describe('commandsOf 按 tree-sitter-bash 语法树取 argv', () => {
  test('参数展开 ${o:+-c $o} 保持原文（wfd-w42 的 session f3488cd1，原来导入时 500：Bad substitution）', () => {
    const cmd =
      'E=/Users/tester/orca/workspaces/wf-dashboard/wfd-w42/.work/w42/exp; mkdir -p $E/home2; cd $E/proj; for o in "" "skills.bundled.enabled=false" "skills.bundled=false" "skills.include_system=false"; do echo "== $o"; HOME=$E/home2 npm_config_cache=$HOME/.npm CODEX_HOME=$E/codex-home codex debug prompt-input ${o:+-c $o} hi > $E/pi.json 2>$E/pi.err; echo "exit $?"; head -c 300 $E/pi.err; grep -o \'(file: r[0-9]/[^)]*)\' $E/pi.json | sort | uniq | tr \'\\n\' \' \'; echo; done';
    expect(commandsOf(cmd)).toEqual([
      ['mkdir', '-p', '$E/home2'],
      ['cd', '$E/proj'],
      ['echo', '== $o'],
      ['codex', 'debug', 'prompt-input', '${o:+-c $o}', 'hi'],
      ['echo', 'exit $?'],
      ['head', '-c', '300', '$E/pi.err'],
      ['grep', '-o', '(file: r[0-9]/[^)]*)', '$E/pi.json'],
      ['sort'],
      ['uniq'],
      ['tr', '\\n', ' '],
      ['echo'],
    ]);
  });

  test('双引号中的 ${x:-y}', () => {
    const cmd =
      'jq -r \'.vaults[].path\' "$HOME/Library/Application Support/obsidian/obsidian.json"; echo "MAGI_VAULT=${MAGI_VAULT:-<unset>}"; grep -n MAGI_VAULT ~/.zshrc';
    expect(commandsOf(cmd)).toEqual([
      ['jq', '-r', '.vaults[].path', '$HOME/Library/Application Support/obsidian/obsidian.json'],
      ['echo', 'MAGI_VAULT=${MAGI_VAULT:-<unset>}'],
      ['grep', '-n', 'MAGI_VAULT', '~/.zshrc'],
    ]);
  });

  test('$(...) 不是字面量，不计入；其中的命令各自是一条；命令前的变量赋值与重定向不在 argv 中', () => {
    const cmd =
      'W=/Users/tester/orca/workspaces/wf-dashboard/wfd-w4/data/runs/r-20261009-dqva52/workspace; codex exec -s read-only -C $W --skip-git-repo-check -o $W/.research/codex-review-1.md "$(cat $W/.research/codex-review-prompt.md)" > $W/.research/codex-review-1.log 2>&1; echo exit=$?; wc -l $W/.research/codex-review-1.md';
    expect(commandsOf(cmd)).toEqual([
      [
        'codex',
        'exec',
        '-s',
        'read-only',
        '-C',
        '$W',
        '--skip-git-repo-check',
        '-o',
        '$W/.research/codex-review-1.md',
      ],
      ['cat', '$W/.research/codex-review-prompt.md'],
      ['echo', 'exit=$?'],
      ['wc', '-l', '$W/.research/codex-review-1.md'],
    ]);
    expect(
      commandsOf(
        'cd /Users/tester/orca/workspaces/wf-dashboard/wfd-w4/data/runs/r-20261009-dqva52/workspace && ARTIFACT_VIA=decide wf publish-artifact .decide/ballot.html --title "计算器：请老师做的 4 个决定" 2>&1',
      ),
    ).toEqual([
      [
        'cd',
        '/Users/tester/orca/workspaces/wf-dashboard/wfd-w4/data/runs/r-20261009-dqva52/workspace',
      ],
      ['wf', 'publish-artifact', '.decide/ballot.html', '--title', '计算器：请老师做的 4 个决定'],
    ]);
  });

  test('算术展开不是字面量，不计入', () => {
    const cmd =
      'cd "/Users/tester/Documents/Obsidian Vault/Project Magi/Dashboard" && n=$(grep -n \'^## 16\\.\' Contracts.md | cut -d: -f1); echo $n; sed -n "$n,$((n+57))p" Contracts.md';
    expect(commandsOf(cmd)).toEqual([
      ['cd', '/Users/tester/Documents/Obsidian Vault/Project Magi/Dashboard'],
      ['grep', '-n', '^## 16\\.', 'Contracts.md'],
      ['cut', '-d:', '-f1'],
      ['echo', '$n'],
      ['sed', '-n', 'Contracts.md'],
    ]);
  });

  test("引号与转义：双引号中的换行与末尾的 $、$'…' 的字节、续行", () => {
    expect(
      commandsOf(
        'grep -n -E "Research：|验收标准|评审处理完|PR ready|假设|保留的 idea|数据划分|派发：|def lane|lane\\($|feedback=" build.py',
      ),
    ).toEqual([
      [
        'grep',
        '-n',
        '-E',
        'Research：|验收标准|评审处理完|PR ready|假设|保留的 idea|数据划分|派发：|def lane|lane\\($|feedback=',
        'build.py',
      ],
    ]);
    expect(commandsOf("grep -n $'\\xef\\xbf\\xbd' .interview/brief.md")).toEqual([
      ['grep', '-n', '\ufffd', '.interview/brief.md'],
    ]);
    expect(
      commandsOf(
        'cd /Users/tester/Project/txe/txe-workflow/.research/ticket-quality && python3 -c "\nimport json;d=json.load(open(\'success-vs-failure.json\'));print(type(d), list(d.keys())[:10] if isinstance(d,dict) else len(d))\n" ; ls sf-work | head -40',
      ),
    ).toEqual([
      ['cd', '/Users/tester/Project/txe/txe-workflow/.research/ticket-quality'],
      [
        'python3',
        '-c',
        "\nimport json;d=json.load(open('success-vs-failure.json'));print(type(d), list(d.keys())[:10] if isinstance(d,dict) else len(d))\n",
      ],
      ['ls', 'sf-work'],
      ['head', '-40'],
    ]);
    expect(
      commandsOf(
        'cd /Users/tester/Project/txe/txe-workflow\nT=v2.2.0; TGT=aarch64-apple-darwin\necho "=== release verify ==="; gh release verify $T -R txehq/txe-workflow 2>&1 | tail -4\nchmod 700 .install\ngh release download $T -R txehq/txe-workflow -D .install --clobber \\\n  --pattern "wf-$T-$TGT.tar.gz" --pattern \'workflow.lock.json\' --pattern "workflow-$T.tar.gz" 2>&1\nfor f in "wf-$T-$TGT.tar.gz" workflow.lock.json "workflow-$T.tar.gz"; do\n  echo "=== verify-asset $f ==="; gh release verify-asset $T ".install/$f" -R txehq/txe-workflow 2>&1 | tail -2\ndone',
      ),
    ).toEqual([
      ['cd', '/Users/tester/Project/txe/txe-workflow'],
      ['echo', '=== release verify ==='],
      ['gh', 'release', 'verify', '$T', '-R', 'txehq/txe-workflow'],
      ['tail', '-4'],
      ['chmod', '700', '.install'],
      [
        'gh',
        'release',
        'download',
        '$T',
        '-R',
        'txehq/txe-workflow',
        '-D',
        '.install',
        '--clobber',
        '--pattern',
        'wf-$T-$TGT.tar.gz',
        '--pattern',
        'workflow.lock.json',
        '--pattern',
        'workflow-$T.tar.gz',
      ],
      ['echo', '=== verify-asset $f ==='],
      ['gh', 'release', 'verify-asset', '$T', '.install/$f', '-R', 'txehq/txe-workflow'],
      ['tail', '-2'],
    ]);
  });

  test('不是合法 bash 的命令（wfd-w42 的 session 7fbe92b6）不抛出', () => {
    expect(() =>
      commandsOf(
        'grep -n "session ${String(bound.length)}\\|for (const s of bound) events" src/deletion/index.ts',
      ),
    ).not.toThrow();
  });
});
