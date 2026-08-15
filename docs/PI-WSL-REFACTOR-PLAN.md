# Pi WSL MCP 重构计划

日期：2026-08-09

## 已确认的目标与边界

`Pi WSL MCP` 是任意 MCP host 与用户**既有 WSL Pi**之间的本地 stdio
桥接器。它提供显式工作区、会话生命周期、受限 profile，以及有界且标注为
不可信的输出；它不重写 Pi/Codex，不管理用户的全局 Pi 配置，也不允许任意
磁盘遍历。

“跨项目”指一个 MCP 服务可以为不同项目创建会话；每个会话在创建时都必须
选择一个工作区，工作区会被规范化并限制在 `allowed roots` 内，之后该会话不能
被悄悄切换到其他路径。默认工作区是启动器传入的当前目录；当 host 不是在项目
根目录启动时，用户应显式配置 `PI_WSL_MCP_DEFAULT_CWD` 和
`PI_WSL_MCP_ALLOWED_ROOTS`。

本次只做到可安装、可配置和可验证，**不发布 npm 包、不添加或推测许可证**。

## 重构前实测记录

| 检查 | 实际结果 | 结论 |
| --- | --- | --- |
| `npm run check` | 58/58 测试通过 | 单元/静态检查不足以证明真实桥接可用。 |
| Windows 启动器 + 实际 MCP smoke | 进程提前退出：`Cannot find module '/mnt/d/WorkSpace/pi-local-mcp'` | 当前通用启动器的路径/引号传递存在端到端回归。 |
| 直接在 WSL 运行 `node scripts/mcp-smoke.mjs --live --resume --workspace --lifecycle` | `pi_research` 断言失败；最终回答不是字符串。 | 真实 Pi 运行未成功，不能把 `settled` 当作成功回答。 |
| 失败会话的 Pi transcript | DeepSeek Responses 返回 400：`tool search ... conflicts with server side web_search calls`；`model_calls=0` | 全局原生 DeepSeek 搜索注入与 Pi 暴露的 `search` function 工具冲突。 |
| 直接 Pi 验证 | `pi --exclude-tools search ...` 成功返回 Model Context Protocol 官方 URL，并说明已使用搜索 | 冲突可通过显式排除同名 function tool 避免；原生搜索本身正常。 |
| 输出实现审查 | 默认把最终回答同时放在 `content[0].text` 与 `structuredContent.answer`；`PI_WSL_MCP_RESULT_LIMIT` 没有应用到最终回答，server 中固定为 24000 | 默认输出会重复消耗上下文，且配置名与实际行为不一致。 |

当前工作树中已有一批未完成的重命名/EOL WIP。它们可以作为实现起点，但由于以上
两条真实 smoke 均失败，不能视为完成，也不能仅凭静态测试接受。

## 设计决定

### 1. 可移植身份与启动方式

- 产品、MCP server 和命令统一为 `Pi WSL MCP` / `pi-wsl-mcp`；MCP 配置示例使用
  `pi_wsl`。
- 保留 `PI_LOCAL_MCP_*` 仅作为已弃用兼容别名；`PI_WSL_MCP_*` 优先。
- WSL 内的主入口使用 `pi` 的交互式 zsh PATH，不硬编码用户、发行版、磁盘或 npm
  全局目录。
- Windows 启动器从自己的安装目录推导包路径，并把调用方工作目录转换为 WSL 路径；
  支持可选的 `PI_WSL_MCP_DISTRO`。它必须正确处理空格、尾随反斜杠和 `cmd /c`
  引号，且不能依赖本仓库位置。
- 在 npm 发布前，只支持从 checkout 的 `npm install -g .` 安装，并在文档中清楚
  标注该限制。

### 2. 工作区与安全边界

- 默认工作区和默认 allowed root 都取实际启动目录；用户可用新变量显式覆盖。
- Windows 盘符路径和 WSL 绝对路径均可作为 workspace 参数；解析真实路径后再做
  allowed-root 包含关系检查。
- 会话创建后固定其 workspace；恢复保存会话也沿用保存时的 workspace 约束。
- 不把工作区默认扩展成整个用户目录或整个挂载盘；多项目使用由用户列出多个
  allowed roots。

### 3. DeepSeek 原生搜索兼容

Pi WSL MCP 不修改用户的全局 Pi extension 或凭据。`pi_research`/`pi_review` 的
只读启动 profile 不再把名为 `search` 的 function tool 暴露给启用了 DeepSeek
Responses 原生 `web_search` 的进程；Pi RPC 还会明确排除该同名工具。这样服务端
`web_search` 与 Pi function 工具不会在请求中同名冲突。

这只影响桥接器的只读搜索/review profile：它们仍有 `read`、`grep`、`find`、`ls`
和已安装的 web/knowledge 工具。`workspace` profile 保持用户原有的正常工具集，不
承诺在用户自行组合了同名 `search` tool 与原生搜索注入时自动改写其能力；出现该
组合时，错误必须带有可行动的冲突说明，而不是伪装为成功。

### 4. 行尾保护

- 每个桥接 Pi 进程通过显式 `--extension` 加载包内的、会话级 EOL guard，不触碰
  `~/.pi`。
- guard 只在 Pi builtin `write` 覆盖既有、普通、纯 CRLF 或纯 LF 的文本文件时，把
  incoming content 归一到原有风格；新文件、二进制、无换行、混合行尾和无法安全
  判定的文件保持不变。
- 保留 Pi builtin `edit` 的既有行为，并在 system prompt 中要求优先精确 edit、
  遵守 `.gitattributes`、不要用 shell 批量转码。
- 不声称能够安全拦截任意 bash/sed/第三方工具写入；仓库的 `.gitattributes` 仍是
  行尾策略的权威来源。

### 5. 结果契约：紧凑、准确、可继续

默认结果需要区分三件事：桥接器观察到的生命周期事实、Pi 的未验证文本，以及
按需诊断资料。

- `content[0].text` 是默认唯一的最终 Pi 文本载体，带有 `untrusted` 标记和很短的
  状态/会话引用。
- `structuredContent` 只保留机器可用的状态、会话/运行 id、进度、用量、错误和
  `answer_meta`（是否有回答、是否截断、原始字符数）；默认不再复制全文回答。
- `PI_WSL_MCP_RESULT_LIMIT` 实际控制默认最终回答及嵌套诊断字符串的上限，截断必须
  明确报告。`include_details=true` 才可请求有界的事件/诊断流，且文档说明它会增加
  token 成本。
- 收到 `agent_settled` 并不自动代表模型成功。若 Pi 事件显示 `stop_reason=error`、
  没有可收集的回答，或最终收集失败，run 必须为 `error`，携带经脱敏的可行动错误；
  绝不能报告空回答的 `settled`。
- Pi 文本、网页和 transcript 仍只标为 `untrustedContent`，不被桥接器升级为已验证
  事实。运行状态、ids、计数和实际观察到的工具事件才是桥接器可负责的事实。

这会在预发布阶段调整 `structuredContent.answer` 的旧兼容形状；文档与所有协议
测试会一起更新，避免用“兼容”名义保留默认双份回答。

## 实施顺序

1. **收敛重命名 WIP 与启动器**：检查/修复 Windows cmd 引号、包定位和 WSL cwd
   转换；补充无需固定用户路径的单元测试和 Windows launcher smoke。
2. **修复真实运行状态**：让 Pi RPC 将 profile 的 tool exclusion 传递给 CLI；修复
   `agent_settled` 后的错误识别与最终文本收集，并为 DeepSeek 原生搜索冲突写回归
   测试。
3. **实现/收敛 EOL guard**：保留现有 session-scoped 方向，补全纯 CRLF/LF、混合、
   二进制、新文件、相对路径和大文件边界测试；确认 guard 参数在每个 RPC child
   上实际生效。
4. **重塑输出边界**：实现单一默认文本载体、`answer_meta`、有效的 result limit 和
   错误状态；更新 schema、README 和 modern/legacy protocol tests。
5. **完成安装文档**：提供 WSL 客户端、Windows MCP host、环境变量、迁移和
   workspace/行尾限制的明确示例；不写入用户配置、不执行发布。

## 验收标准

1. `npm run check` 通过，包含新 launcher、EOL、结果契约和错误生命周期回归测试。
2. WSL 直接现代协议 smoke 与 legacy smoke 均通过；真实 `pi_research` 完成一次
   DeepSeek 原生搜索，回答非空、`model_calls > 0`，且不会包含 400 同名工具冲突。
3. 从 Windows 用 `run-pi-wsl-mcp.cmd` 启动的真实 MCP smoke 通过；运行路径不包含
   `D:\WorkSpace`、`/home/qq110` 或固定 `Ubuntu` 依赖。
4. 默认 `tools/call` wire result 中最终 Pi 文本只出现一次；结构化部分有足够的
   continuation/id/status 元数据，且限制值和截断状态可观察。
5. 受控 CRLF fixture 经 EOL guard 的 `write` 输入仍为 CRLF，LF fixture 仍为 LF；
   混合/二进制/new-file fixture 不被擅自改写。对桥接仓库执行 `git diff --check` 和
   `git ls-files --eol`，确认没有意外全仓行尾翻转。
6. 独立 Pi `deepseek-v4-pro` 审查当前 diff；其发现由源码、测试和真实协议结果复核
   后再决定是否修正。

## 非目标

- 不替换 Pi，不把 MCP 变成自主 agent，也不增加新的泛用工具。
- 不自动扫描或访问 allowed roots 之外的项目。
- 不将 API key、Pi transcript 原文或网页内容作为可信数据转发。
- 不发布 registry 包、创建 release、推送或修改用户级 Codex/Pi 配置。
