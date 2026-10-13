---
name: failures
description: Session-analysis stage for failures — every point where the session stopped going forward (tool errors, failed commands, retries, loops, workarounds, getting stuck), whether and where it recovered, and what each failure chain cost.
---

# 经常失败的地方

先照 `session-analysis` skill 读过 `../session-analysis/references/` 的五份参考；证据、格式与归属以它们为准。输出：`output/findings-failures.json`。

关键词：**stumble**（一次失败）与 **retry chain**（从第一次失败到恢复或放弃的一串请求）。失败链中的重复与花费只在本阶段报告。

## 步骤

1. **列出每一次失败**（主 agent 与子代理都要）：
   - `isError` 为 true 的 tool 调用；
   - 命令的非零退出、`command not found`、`No such file`、超时；
   - 权限拒绝、hook 失败、API 错误、限流与配额（`rate limit`、`quota`、`429`、`overloaded`）；
   - 撤回的修改：一次编辑之后又改回原样，或对改过的文件 `git checkout`、`git restore`、`git reset`；
   - 回复与思考中的回头（"actually"、"let me instead"、"之前错了"、"换一种方式"）。

   完成条件：每个 `isError` 为 true 的调用都已归入某条失败链，或写明可以忽略的理由（例如预期中的探测）。

2. **连成失败链。** 从一次失败开始，往后找：同一动作原样重试、换参数重试、换策略、绕路（换一种方式避开问题）、放弃。判断卡住：
   - 同一动作与同一错误出现 3 次；
   - 同一动作与同一结果连续 4 次；
   - 两个动作交替（A-B-A-B）6 步以上；
   - 对同一处代码的修改反复进行而测试结果不变。

   每条链写明：起止 seq、失败了什么、之后怎样（同一轮恢复 / 在 seq N 恢复 / 没有恢复）、换策略时有没有依据。

3. **算成本。** 每条链覆盖的请求的 `costUsd`、token 之和与 `timestamp` 跨度（写算法）。
4. **分类。** 每条链标明原因：环境问题（缺工具、缺凭据、外部服务不可用或配额）、skill 的规定导致（引用原文）、agent 的做法。相同的失败（同一错误原文）合并为一条发现并写出次数与所在的全部 seq。
5. 按 `findings.md` 写出 `output/findings-failures.json` 并用 `jq .` 检查。
