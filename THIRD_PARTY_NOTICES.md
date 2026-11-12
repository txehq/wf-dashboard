# Third-party notices

## Fluent Emoji

- Source: [microsoft/fluentui-emoji](https://github.com/microsoft/fluentui-emoji), commit `1ffb34c752ecf5d402f04cfb4b392c77f57c54bc`
- Files used: `assets/Robot/Flat/robot_flat.svg`, stored unchanged at `web/src/assets/fluent-emoji/robot_flat.svg`; `web/src/components/magi-robot.tsx` draws the Magi Agent logo from its paths, with the body and both antennas recolored in the Magi Agent color
- License: MIT

```text
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## React Flow

- Source: [xyflow/xyflow](https://github.com/xyflow/xyflow), npm package `@xyflow/react` 12.12.0
- Use: installed as a dependency; `web/src/components/workflow-flow.tsx` (stage flowchart) and `web/src/components/sessions/stage-graph.tsx` (stage graph) draw with it. Both remove the attribution in the canvas corner with `proOptions.hideAttribution`; the attribution and license are given here
- License: MIT

```text
MIT License

Copyright (c) 2019-2025 webkid GmbH

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Three skills in the design and optimization baselines

The baseline variants of the built-in "Design workflow" and "Optimize" workflows (Contracts 33.1) carry three third-party skills, stored unchanged in `server/src/workflows/external-skills/<name>/`. Each directory has its license and a `SOURCE.md` (source and commit).

### find-skills

- Source: [vercel-labs/skills](https://github.com/vercel-labs/skills), commit `13e4063a1cf913f5606d57d42ab83a86f5001e04`, `skills/find-skills/`
- License: MIT, full text in `server/src/workflows/external-skills/find-skills/LICENSE` (the copy from the repository root, Copyright (c) 2026 Vercel, Inc.)

### skill-creator

- Source: [anthropics/skills](https://github.com/anthropics/skills), commit `dbd4588f9e1033efb41dad4bef2f7947c8993d44`, `skills/skill-creator/`
- License: Apache License 2.0, full text in `server/src/workflows/external-skills/skill-creator/LICENSE.txt` (the copy shipped with this skill)

### writing-for-agents

- Source: [mattpocock/skills](https://github.com/mattpocock/skills), commit `49dd158d1076134a641b33efb035946536778336`, `skills/productivity/writing-for-agents/`
- License: MIT, full text in `server/src/workflows/external-skills/writing-for-agents/LICENSE` (the copy from the repository root, Copyright (c) 2026 Matt Pocock)
