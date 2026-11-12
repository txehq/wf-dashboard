import { describe, expect, test } from 'vitest';
import { catSkill, catSkills, injectedSkill } from '../../src/ingest/codex-skill.js';
import { commandsOf, sequenceOf } from '../../src/stages/shell.js';

// All commands come from Bash calls in real sessions, with the user directory written as /Users/tester
describe('commandsOf takes argv from the tree-sitter-bash syntax tree', () => {
  test('parameter expansion ${o:+-c $o} stays as written (wfd-w42 session f3488cd1, whose import used to fail with 500: Bad substitution)', () => {
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

  test('${x:-y} inside double quotes', () => {
    const cmd =
      'jq -r \'.vaults[].path\' "$HOME/Library/Application Support/obsidian/obsidian.json"; echo "MAGI_VAULT=${MAGI_VAULT:-<unset>}"; grep -n MAGI_VAULT ~/.zshrc';
    expect(commandsOf(cmd)).toEqual([
      ['jq', '-r', '.vaults[].path', '$HOME/Library/Application Support/obsidian/obsidian.json'],
      ['echo', 'MAGI_VAULT=${MAGI_VAULT:-<unset>}'],
      ['grep', '-n', 'MAGI_VAULT', '~/.zshrc'],
    ]);
  });

  test('$(...) is not a literal and is skipped; each command inside it is its own command; assignments and redirections before a command are not in argv', () => {
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
        'cd /Users/tester/orca/workspaces/wf-dashboard/wfd-w4/data/runs/r-20261009-dqva52/workspace && ARTIFACT_VIA=decide wf publish-artifact .decide/ballot.html --title "Calculator: 4 decisions for you to make" 2>&1',
      ),
    ).toEqual([
      [
        'cd',
        '/Users/tester/orca/workspaces/wf-dashboard/wfd-w4/data/runs/r-20261009-dqva52/workspace',
      ],
      [
        'wf',
        'publish-artifact',
        '.decide/ballot.html',
        '--title',
        'Calculator: 4 decisions for you to make',
      ],
    ]);
  });

  test('arithmetic expansion is not a literal and is skipped', () => {
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

  test("quotes and escapes: newline and trailing $ inside double quotes, bytes in $'…', line continuation", () => {
    expect(
      commandsOf(
        'grep -n -E "Research:|acceptance criteria|review handled|PR ready|assumption|kept idea|data split|dispatch:|def lane|lane\\($|feedback=" build.py',
      ),
    ).toEqual([
      [
        'grep',
        '-n',
        '-E',
        'Research:|acceptance criteria|review handled|PR ready|assumption|kept idea|data split|dispatch:|def lane|lane\\($|feedback=',
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

  test('a command that is not valid bash (wfd-w42 session 7fbe92b6) does not throw', () => {
    expect(() =>
      commandsOf(
        'grep -n "session ${String(bound.length)}\\|for (const s of bound) events" src/deletion/index.ts',
      ),
    ).not.toThrow();
  });
});

// Commands come from real codex-cli 0.163.0 rollouts of 2026-10-25 and 2026-10-29
describe('skills Codex reads with cat (Contracts 25.2)', () => {
  test('sequenceOf: simple commands joined only by ;, && or || give their argv; pipelines, redirections, subshells and command substitution give null', () => {
    expect(sequenceOf('cat a/SKILL.md; cat PLATFORM.md && pwd || true')).toEqual([
      ['cat', 'a/SKILL.md'],
      ['cat', 'PLATFORM.md'],
      ['pwd'],
      ['true'],
    ]);
    for (const cmd of [
      'cat a/SKILL.md | head -20',
      'cat a/SKILL.md > b.md',
      '(cat a/SKILL.md)',
      'cat "$(echo a/SKILL.md)"',
      'for f in a b; do cat $f/SKILL.md; done',
    ])
      expect(sequenceOf(cmd), cmd).toBeNull();
  });

  test('every SKILL.md in a chain of cats is one read (commands run in the 2026-10-29 exec script)', () => {
    expect(
      catSkills(
        'cat .agents/skills/workflow-design/SKILL.md; cat PLATFORM.md; cat .agents/skills/writing-for-agents/SKILL.md; cat .agents/skills/skill-creator/SKILL.md',
      ),
    ).toEqual([
      { name: 'workflow-design', path: '.agents/skills/workflow-design/SKILL.md' },
      { name: 'writing-for-agents', path: '.agents/skills/writing-for-agents/SKILL.md' },
      { name: 'skill-creator', path: '.agents/skills/skill-creator/SKILL.md' },
    ]);
    // One cat with several files (2026-10-25)
    expect(
      catSkills(
        'cat .agents/skills/writing-for-agents/SKILL.md .agents/skills/skill-creator/SKILL.md',
      ).map((s) => s.name),
    ).toEqual(['writing-for-agents', 'skill-creator']);
    // Reading a part, cat with a pipe or options, and other commands are not loads
    for (const cmd of [
      'sed -n 1,40p .agents/skills/workflow-design/SKILL.md',
      'cat .agents/skills/workflow-design/SKILL.md | head',
      'cat -n .agents/skills/workflow-design/SKILL.md',
      'git diff -- src/skills/hello-flow/SKILL.md',
      'rg --files -g SKILL.md .',
    ])
      expect(catSkills(cmd), cmd).toEqual([]);
  });

  test('catSkill: the output is the full SKILL.md only when the whole command is a cat of one SKILL.md', () => {
    expect(catSkill('cat .agents/skills/workflow-design/SKILL.md')).toEqual({
      name: 'workflow-design',
      path: '.agents/skills/workflow-design/SKILL.md',
    });
    expect(catSkill('cat .agents/skills/workflow-design/SKILL.md; cat PLATFORM.md')).toBeNull();
    expect(catSkill('cat a/SKILL.md b/SKILL.md')).toBeNull();
  });

  test('injectedSkill: the name, SKILL.md path and full text of a <skill> injection; other user messages are not', () => {
    expect(
      injectedSkill(
        '<skill>\n<name>workflow-design</name>\n<path>/d/.agents/skills/workflow-design/SKILL.md</path>\n---\nname: workflow-design\n---\n\n# /workflow-design\n\n</skill>',
      ),
    ).toEqual({
      name: 'workflow-design',
      path: '/d/.agents/skills/workflow-design/SKILL.md',
      body: '---\nname: workflow-design\n---\n\n# /workflow-design\n',
    });
    expect(
      injectedSkill(
        '$workflow-design Append a line ok to the end of src/skills/hello-flow/SKILL.md',
      ),
    ).toBeNull();
    expect(
      injectedSkill('<environment_context>\n  <cwd>/d</cwd>\n</environment_context>'),
    ).toBeNull();
  });
});
