# Rules for reading session files

One record line can be hundreds of thousands of characters. Every step that reads `input/` follows these four rules:

1. Measure first: `wc -lc <file>`; find long lines: `awk '{ if (length($0) > 100000) print NR, length($0) }' <file>`.
2. Take only fields: first use `jq` for line numbers, counts and short fields (`jq -c '{seq, agent, stage, timestamp}'`), then take the fields you need from the selected lines (`jq -c 'select(.seq == 12) | .toolCalls[] | {name, isError}'`).
3. Narrow down: when a command prints more than 500 characters for one record, narrow the fields or take a slice (`| cut -c1-500`, `.result[0:500]`).
4. Read only: do not modify or move any file in `input/`; temporary files for calculations go under `output/work/`.
