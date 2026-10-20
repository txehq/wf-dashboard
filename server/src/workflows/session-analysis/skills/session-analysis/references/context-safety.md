# 读 session 文件的规则

一行记录可能有几十万字符。每个读 `input/` 的步骤都照这四条做：

1. 先量：`wc -lc <文件>`；找出长行：`awk '{ if (length($0) > 100000) print NR, length($0) }' <文件>`。
2. 只取字段：先用 `jq` 取行号、计数与短字段（`jq -c '{seq, agent, stage, timestamp}'`），再对选中的行取需要的字段（`jq -c 'select(.seq == 12) | .toolCalls[] | {name, isError}'`）。
3. 收窄：一条命令对一条记录输出超过 500 个字符时，收窄字段或截取片段（`| cut -c1-500`、`.result[0:500]`）。
4. 只读：不修改、不移动 `input/` 中的任何文件；计算用的临时文件写在 `output/work/` 下。
