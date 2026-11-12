<p align="center"><img src="web/favicon.svg" width="64" alt="codex-exo-subagent"></p>

# codex-exo-subagent

为 Codex 接入外部子代理模型，并提供本地会话工作区。支持本地部署、直连 API 和模型路由，保留主代理的官方模型配置。

**零 npm 运行依赖 · Node.js 24+ · Windows 为当前验证平台**

## 功能

- **任务管理**：同步或后台执行、进度查询、等待、取消、继续会话。
- **模型配置**：已保存的连接每行一条，通过右侧按钮展开编辑，临时收起后保留当前填写内容；顶栏“添加连接”在列表顶部展开新表单。支持管理模型、默认模型和每个模型的思考设置；保存后可单独测试。选择菜单使用统一圆角样式，支持键盘操作。
- **接口接入**：支持 Responses API 和 OpenAI 兼容的 Chat Completions，网关处理流式文本、工具调用和工具结果。
- **会话页面**：左侧项目与最近会话，右侧消息与执行记录，支持搜索、置顶、重命名、分页和导出。最近列表仅显示会话标题，按更新时间排序；会话标题集中在面包屑，会话信息不再显示固定来源说明。
- **执行记录**：同一终端进程的空 `write_stdin` 轮询不单独显示，新增输出合并回原命令卡片；有真实输入的 `write_stdin` 仍保留。连续命令默认折叠在“运行了命令”中；展开单条命令即可查看贴满内容区的输出，右上角支持复制完整输出；原始 API 记录、导出和完整输出不变。
- **本地存储**：仅显示本 MCP 登记的会话；模型密钥支持 Windows 当前用户加密保存或环境变量认证。

## 快速开始

准备 Node.js 24+、Git，以及支持 `codex exec --json` 和 `codex exec resume` 的 Codex CLI。

```powershell
git clone https://github.com/CandyRGB/codex-exo-subagent-mcp.git
cd codex-exo-subagent-mcp

# 启动本地服务并打开模型配置页面
node open-viewer.mjs --settings
```

打开 [模型与连接](http://127.0.0.1:43187/#/settings/models)，点击顶栏“添加连接”，填写 API 根地址和认证方式。在统一模型列表中添加模型 ID、指定默认模型，然后保存并按需测试。连接行上的“设为默认连接”用于选择新任务使用的连接。

初始配置保留 `workbuddy` / `deepseek-v4.1-flash` 作为兼容入口。如果本机没有这个 Codex profile，直接在页面新增自己的连接并设为默认即可。

随后在 **仓库目录** 中注册 MCP：

```powershell
$entry = Join-Path (Get-Location) 'server.mjs'
codex mcp add codex-subagent -- node $entry
```

重新连接 MCP 或重启 Codex，让客户端读取工具列表。之后修改默认连接会在新任务开始时读取；续聊继续使用原来的连接和模型。

> [!NOTE]
> 不需要 `npm install`。运行数据默认写在仓库的 `state/` 中，该目录已被 Git 忽略。原生 Codex 会话日志仍由 Codex 管理。

## 配置模型

| 接入方式 | 地址示例 | 协议 |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` | Chat Completions |
| LM Studio | `http://127.0.0.1:1234/v1` | Chat Completions |
| vLLM | `http://127.0.0.1:8000/v1` | Chat Completions |
| API 或代理路由 | 服务商提供的 API 根地址 | Responses 或 Chat Completions |

模型服务需要已在本机、局域网或远端运行，并支持所选 API。模型应支持函数/工具调用。其他原生协议（例如 Anthropic Messages）需要经过兼容网关。

认证支持无需认证、环境变量，以及 Windows DPAPI 加密保存的 API Key。认证头默认为 `Authorization: Bearer ...`，也可改为 `X-API-Key` 等名称。非 Windows 环境请使用环境变量；其他平台的完整运行流程尚未验证。

点击“添加”打开模型弹窗，也可先获取模型列表，再从候选项添加。弹窗支持设置 API 模型的上下文窗口、最大输出 Token 数和思考参数。弹窗保存更新当前草稿，点击“保存连接”写入配置。API Key 旁的“检查”访问模型列表接口。“测试模型”使用当前草稿发送推理请求，“测试连接”使用已保存的配置，推理测试可能计入服务用量。

接入方式分为“模型 API 连接”和“已有 Codex profile”。API 地址、协议、认证和模型 ID 由用户手动填写；默认模型只在编辑区的统一模型列表中设置，连接行展示名称、协议、默认模型和状态，右侧提供“设为默认连接”和展开编辑操作。网页管理的 API 连接在每次启动子 CLI 时通过 `--model` / `-c` 传入参数，不自动写入用户的 Codex 配置。

选择“已有 Codex profile”时，下拉框列出本机 Codex 配置目录里的 `<名称>.config.toml`。选中后可编辑 TOML 原文，点“保存文件”写回原文件。点“保存连接”会保存 profile 的引用和模型列表。若文件已被其他程序修改，页面会提示重新读取。模型是否可用需通过实际任务验证。

### 思考参数

模型弹窗提供“服务默认”“服务声明”和“自定义”三种思考档位方案。选择自定义后可填写服务支持的原始值。

“服务默认”让上游决定强度。选择“服务声明”后，可以在弹窗内点击“读取档位”获取当前模型的候选值。

API 连接的思考参数统一由网关按实际请求的模型注入，覆盖 CLI 继承的强度；自定义值不会被当作 Codex 的执行模式。已有 profile 类型继续使用自己的配置。旧版连接的 `reasoning_effort` 会继续作为连接默认值。升级后重新连接一次 MCP，加载新的启动逻辑。

已保存的 API 连接可以在“更多”菜单中“导出为 profile”；“移除连接”也在该菜单中。弹窗提供配置预览、保存路径、下载文件和启动命令，供用户在终端手动使用 Codex CLI 0.134.0+。导出不自动安装或覆盖配置，不包含 API Key 或网关令牌。导出的 profile 仍通过本机网关访问原连接，启动命令会启动网关并从本地文件读取令牌；连接和网关需保留，地址、协议或认证方式变化后需要重新导出。手动启动的 CLI 会话不纳入本页面的 MCP 会话列表。

> [!IMPORTANT]
> 网页只监听本机回环地址。API 连接任务通过同一个本机模型网关运行，因此任务执行时服务需要保持运行。关闭浏览器窗口不会停止服务。

## 在 Codex 中使用

例如告诉 Codex：

> 使用配置好的子代理在后台检查这个项目，完成后报告修改文件和验证结果。

MCP 提供一个工具 `codex_subagent`，通过 `action` 选择操作：

| action | 用途 |
| --- | --- |
| `run` | 同步执行，默认操作 |
| `start` | 后台启动并返回任务编号 |
| `status` / `wait` | 查询进度或有限时间等待 |
| `resume` | 在原会话中继续执行，产生新的任务编号 |
| `cancel` | 终止对应任务的进程树 |
| `result` / `list` | 分页读取结果或列出任务 |
| `models` | 列出配置的连接和模型 ID，不包含密钥 |
| `viewer` | 返回本地工作区地址 |

省略 `connection_id` 和 `model` 时使用网页设置。也可以先调用 `models`，再明确选择连接和模型：

```json
{"action":"start","prompt":"检查项目并报告验证结果","cwd":"C:\\path\\to\\project","sandbox":"workspace-write"}
{"action":"wait","job_id":"<任务编号>","wait_sec":25}
{"action":"resume","job_id":"<任务编号>","prompt":"继续检查第二个输入"}
```

主代理只接收任务状态和有限长度的结果。完整记录可从网页查看；子代理不会自动得到主聊天的全部上下文。

## 运行原理

```mermaid
flowchart LR
  A[Codex 主代理] -->|MCP| B[任务服务]
  B --> C[独立 Codex CLI]
  C --> D[本机模型网关]
  D --> E[本地模型 / API / 路由]
  B --> F[任务记录]
  C --> G[Codex 会话日志]
  F --> H[本地网页]
  G --> H
```

任务服务和网页/网关服务是独立进程。正常断开 MCP 会中断该连接仍在运行的任务；网页服务可以继续查看已保存的记录。已有 Codex profile 类型的连接直接沿用其原路由。

会话顶部保留模型和状态，日期及轮次、工具次数集中在会话信息中。助手回复直接展示内容；侧栏保留品牌、主题与刷新操作，连接异常时显示提示。已有连接以类型标记展示，新建时选择接入方式。参数 JSON 和长说明按需展开，参数错误直接显示。

## 测试

```powershell
npm test
```

48 项自动检查覆盖任务生命周期、会话范围、配置操作、密钥加密、profile 引用与导出、路由固定、网络错误提示、按模型思考参数、思考模式下的连接测试、认证与流式工具协议适配。

```powershell
# 真实 Codex CLI + 本地确定性模型接口，验证文件写入、shell、续聊及导出 profile
npm run test:cli

# 可选：调用实际配置的模型两轮，可能消耗该模型的额度
npm run test:live
```

浏览器外观自动验收尚未完成；接口、静态资源和前端绑定已经检查。

## 环境与存储

常用环境变量：

| 变量 | 默认值 / 用途 |
| --- | --- |
| `CODEX_SUBAGENT_STATE_DIR` | 入口旁的 `state` |
| `CODEX_SUBAGENT_VIEWER_PORT` | `43187` |
| `CODEX_SUBAGENT_MAX_CONCURRENT` | 每个 MCP 进程最多 `2` 个任务 |
| `CODEX_SUBAGENT_MAX_OUTPUT_CHARS` | 每页结果 `4000` 个 UTF-16 字符 |
| `CODEX_SUBAGENT_CODEX_BIN` | Windows 自动寻找桌面端 CLI，其他情况使用 PATH 中的 `codex` |
| `CODEX_SUBAGENT_PROFILE` / `CODEX_SUBAGENT_MODEL` | 初始化兼容连接时使用的 profile / 模型 |

同一个端口只能对应一个状态目录。已有安装占用端口时，可以为新实例指定其他端口，或明确共享同一个状态目录；MCP 与网页需使用相同设置。

`state/`、会话记录、模型配置、加密凭据、网关令牌及测试产物均不提交。更多参数、生命周期和限制见 [完整参考](docs/REFERENCE.md)。
