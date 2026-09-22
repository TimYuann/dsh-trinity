# DSH Trinity

> 面向 DeepSeek Harness（DSH）的多 Provider Web 搜索、网页抓取与来源核验插件。

DSH Trinity 保留 DSH 原生的 `web_search` 与 `web_fetch` 工具体验，并通过 Cordis composition 将其底层 provider 路由到插件自身的多 Provider 能力。它不修改 DSH 本体；启用、测试和卸载都以 Profile 为边界。

## 能力

### 搜索与路由

- 共 **26 个**搜索 Provider（`lib/providers/provider-metadata.js` 为准）：**18 个**参与 `auto` 链与 `aggregate` 扇出，**8 个**（`duckduckgo`、`xai`、`brightdata`、`serpbase`、`serper`、`valyu`、`kimi`、`parallelMcp`）仅显式指定时调用。其中 Exa、AnySearch、Gemini、Tavily、Brave、Jina、Kagi、Perplexity 等 25 个可在设置页配置密钥。
- `web_search_ex` 支持四种路由方式：自动选择、聚合、多 Provider 有序回退、强制指定单一 Provider。
- 单一 Provider 路由严格执行：v2.3.0 严格化解析，未知 Provider ID 直接抛出 `WEB_PROVIDER_BAD_REQUEST` 而不是静默回落到 `auto`。
- `aggregate` 扇出前先按凭据可用性收敛：只调用**确实能解析出 key / host** 的 Provider，因此无 key 的 Provider 不会消耗 `maxProvidersPerSearch` 预算、不会产生 `providerErrors`、也不会把自己的占位池写进运行时状态。全部无凭据时直接失败并说明原因，而不是先跑一轮必然失败的调用。
- Provider 凭据来源统一通过 `lib/providers/provider-metadata.js` 维护；`FIRECRAWL_KEY` 等历史拼写视为只读别名，UI 只写规范名。
- 支持每个 Provider 的多 Key 轮换、配额冷却、超时与失败分类。
- MiniMax 搜索可作为自动路由的可选兜底能力。

### 网页抓取与内容处理

- 将 DSH 原生 `web_fetch` 路由到 `web-access-chain-fetch`。
- 支持 HTML、RSS/Atom、PDF、GitHub、YouTube 等内容适配器。
- 提供 Readability / Defuddle 内容提取、Markdown 转换与 RSC 页面识别。
- 提供 SSRF 防护：阻止本机、私网、保留网段及危险重定向。
- 支持域名 allow/deny policy。抓取与适配器（fetch 管线）的全部出站 HTTP 走唯一一条 `safeHttpFetch`：逐跳校验 URL policy、手动重定向循环、跨域重定向时不携带敏感头、字节上限与流取消、abort 透传。所有适配器都经由它；搜索 Provider 调用的是各自**固定的**服务端点（URL 不由用户输入决定），因此不走该管线。
- v2.3.0: DSH 原生 `web_fetch` 公开接口只有 `{ url }`，模型无法选择认证 profile，因此不向模型承诺这样的能力。`authFetch` profile 仍存在于设置 schema（`lib/config-schema.js`）并由抓取管线识别，但只有内部调用方能指定它，模型侧无从触及。

### 工具、核验与运维

| 工具 / 命令 | 用途 |
|---|---|
| `web_search_ex` | 多 Provider 搜索、路由选择、来源模式或 LLM 总结模式。 |
| `source_check` | 将声明拆为子问题，搜索、抓取并给出证据导向的核验结果。 |
| `search_content` | 读取 `source_check` 产生的来源快照内容，支持切片和文本定位。 |
| `web_doctor` | 诊断 Provider、凭证、适配器、缓存、代理与运行状态。 |
| `/webdoctor` | 运行 Web 能力诊断。 |
| `/webdoctor-keys` | 查看、写入、测试或清除 Provider Key。 |
| `/webcache` | 管理搜索和抓取缓存。 |

插件另外注册两个 **Skill**（与工具同源，但在会话 skill catalog 中按需加载）：

| Skill | 用途 |
|---|---|
| `web-access` | 进阶联网研究方法：多 Provider 对比、多查询扇出、缓存内容读取、来源核验。 |
| `web-access-doctor` | 搜索 / 抓取失败后的排查路径：Provider、凭证、代理、身份。 |

`web_search_ex` 参数：

| 参数 | 说明 |
|---|---|
| `query` | 单个查询（与 `queries` 二选一）。 |
| `queries` | 多查询扇出；每个查询依次走选定路由，结果按 URL 去重合并。 |
| `routing` | `auto`（默认）/ `aggregate` / 单个 Provider ID / Provider ID 数组。 |
| `output` | `sources`（默认，返回原始来源）或 `answer`（调用 `ctx.llm` 生成综述）。 |
| `maxResults` | 1–20，默认 8。 |
| `recencyFilter` | `day` / `week` / `month` / `year`，Provider 支持时透传。 |
| `domainFilter` | 限定域名列表，Provider 支持时透传。 |

`source_check` 参数：`claim`（必需）、`subQueries`（覆盖自动拆解）、`maxPages`（最多抓取的页面数）。

`search_content` 参数：`cacheRef`（必需，来自 `source_check` 的 `evidenceSnapshotRefs[].cacheRef`）、`sourceIndex`、`offset` / `limit`（切片）或 `findText` + `findMode`（`exact` / `case-insensitive` / `fuzzy` 定位段落）。注意 `web_search_ex` 与 `web_fetch` **不产生** `cacheRef`。

`web_doctor` 参数：`activeProbe` —— 设为 `true` 时对每个 Provider 的健康端点发起真实探测并记录 `lastPing`（状态与延迟）。默认 `false` 为纯被动检查，不产生网络请求。

GitHub PR/Issue、视频提取和 PDF 提取属于可选工具，默认关闭；按 Profile 配置显式启用。

## 安装

### 安装到 DSH Profile

当前源码候选版本是 `2.4.0-rc.0`，面向 DSH `0.1.7-alpha.1`。在发布新的
npm prerelease 之前，请使用本地 tarball 或源码目录，不要把旧 `@next`
当作本候选版本：

```bash
# 在插件仓库中生成可审计 tarball
pnpm pack --pack-destination /tmp/dsh-trinity-build

# 首次验证应使用独立 Profile；名称可以自行替换
dsh --profile dev-trinity --from-default-profile web --dump-config
dsh plugin --profile dev-trinity add /tmp/dsh-trinity-build/dsh-trinity-2.4.0-rc.0.tgz

# 冷启动验证
dsh --profile dev-trinity --no-open --port 4601
```

也可以从源码目录安装：

```bash
dsh plugin --profile dev-trinity add file:/absolute/path/to/dsh-trinity
```

> 已发布的 `2.3.0-rc.2` 仍可通过旧 prerelease 轨道取得，但不包含本文所述的
> DSH 0.1.7 Plugins 控制中心和 command input 修复。安装包之后应重新启动目标
> Profile，并用 `dsh --profile <name> --dump-config` 核对 effective config；
> “包安装成功”本身不等于插件已挂载或已通过运行验证。

安装后，DSH Trinity 会在该 Profile 中：

- 保留原生 `web_search` / `web_fetch` 工具；
- 将 Search/FETCH provider 分别指定为 `web-access-chain-search` 与 `web-access-chain-fetch`；
- 禁用会与插件 Search provider 产生歧义的 `web-search-deepseek` bundle；
- 显式恢复 `dsh-web-app` 默认禁用的 `tool-web`，使模型侧 Web 工具可用。

> 推荐先在独立测试 Profile 验证，再安装到长期使用的 `web` Profile；不要用
> 测试 Profile 覆盖已有 `dev` / `web` 的配置或历史会话。

### 本地开发安装

```bash
dsh --profile dev-trinity --from-default-profile web --dump-config
dsh plugin --profile dev-trinity add file:/absolute/path/to/dsh-trinity
dsh --profile dev-trinity --no-open --port 4601
```

## 配置 Provider Key

插件使用 DSH 原生 `ctx.credentials` credential store，不创建插件私有 `.env` 文件。

### Web UI 插件控制中心（推荐）

在 DSH `0.1.7-alpha.1` 中，DSH Trinity 使用官方 Plugins 页的
`plugins.row.config` 接入面。打开 **Plugins → dsh-trinity →
web-access-chain → Configure**，即可进入插件控制中心：

- **Providers** —— 按自托管、自动路由、仅显式调用分组；支持搜索、已配置/待配置筛选和按需展开编辑，避免同时渲染 25 个密钥输入框。
- **Routing** —— 展示完整 Provider 路由归属，包括不需要密钥的 DuckDuckGo；这里说明参与资格，不会暗中发起搜索。
- **Diagnostics** —— 汇总已配置、待配置和可写凭据数；刷新只调用 `ctx.credentials.describe()`，不会访问第三方 Provider，也不会产生费用。需要真实网络探测时使用 `/webdoctor --active`。

在 Provider 编辑器中：

- **Save** 通过 `ctx.remote.credentials.set(ref, value)` 写入 DSH credential store；输入框提交后立即清空。
- **Refresh status** 通过 `describe(ref)` 更新 configured/source/writable 元数据。旧 UI 的“Test”实际从未访问 Provider，现已改名避免误导。
- **Clear** 二次确认后通过 `unset(ref)` 删除已存值。

安全约束：

- 完整 key 永远不进入 chat composer、session log、host log、settings YAML、模型 prompt、tool argument、console log 或 telemetry payload。
- `last4` 只在用户点击 Save 时由浏览器从本次输入计算，并仅存在于当前 React state；刷新页面、离开插件页或 context 停止后即被丢弃。Host 的 `describe()` 永不返回完整值或后四位。
- `web-access-chain` 的普通配置只管理 routing、timeout、Provider 开关和 fetch policy，不包含 Provider key。
- 控制中心复用 DSH 的 Plugins 页面与 credentials Remote，不新增私有 HTTP 路由，也不接管登录或 Cookie。

**禁止在聊天框粘贴 key。** 聊天路径会把消息内容写入 session JSONL，DSH Trinity 与 DSH 都无法清理。始终使用插件控制中心或 `/webdoctor-keys` 命令。

### 命令行 fallback：`/webdoctor-keys`

在不支持派发插件 command 的宿主（例如纯 headless / 终端）上，可使用 `/webdoctor-keys` 命令完成同样的操作。命令不会回显完整 key；`set` 只显示后四位指纹。

```text
/webdoctor-keys status
/webdoctor-keys set exa <KEY>
/webdoctor-keys set anysearch <KEY>
/webdoctor-keys set gemini <KEY>
/webdoctor-keys test exa
/webdoctor-keys list
/webdoctor-keys clear gemini
```

### Key 解析优先级

```text
进程环境变量 > DSH credential store > DSH .env 文件
```

因此，面向可重复部署的 Profile，建议通过 Web UI 设置页或 `/webdoctor-keys set` 写入 DSH credential store，而不是依赖其他 Agent skill 注入的环境变量。

## 调用示例

```text
# 默认自动路由
web_search_ex(query="DSH Trinity", routing="auto", output="sources")

# 强制使用 Exa
web_search_ex(query="最新 DSH 发布说明", routing="exa", output="sources")

# 聚合多 Provider（只扇出到已配置凭据的 Provider）
web_search_ex(query="2026 年 AI Agent 浏览器", routing="aggregate", output="sources")

# 多查询扇出：两个查询各走一次路由，结果按 URL 去重合并
web_search_ex(queries=["DSH Trinity 安装", "DSH Trinity 配置"], routing="auto")

# 有序回退 + 时间窗过滤
web_search_ex(query="Cordis composition", routing=["exa", "tavily"], recencyFilter="month")

# 让插件用 ctx.llm 基于来源生成综述
web_search_ex(query="DSH profile 与 bundle 的关系", output="answer")

# 核验一个事实性声明
source_check(claim="DSH Trinity 不会修改 DSH 本体")

# 读取 source_check 快照中的一段内容
search_content(cacheRef="wac_...", findText="bundle patch", findMode="fuzzy")
```

`web_search_ex` 的 `routing` 支持：

| 值 | 行为 |
|---|---|
| `auto` | 按 `auto` 链顺序依次尝试，第一个成功即返回。 |
| `aggregate` | 并行扇出到**已配置凭据的** Provider，按 URL 去重合并；失败者的错误汇总在 `providerErrors`。 |
| `exa` 等单个 Provider ID | 强制指定一个 Provider；失败即返回失败，不做跨 Provider 回退。 |
| `["exa", "tavily"]` | 按数组顺序尝试 Provider。 |

## DSH 0.1.7-alpha.1 兼容性

`2.4.0-rc.0` 已在独立 `dev-trinity` Profile 与 DSH `0.1.7-alpha.1` 上验证：

- 374 项测试和全部静态 gate 通过；
- 打包产物可安装，且不包含 tests、docs、`.pi` 或 `lib/_deferred`；
- effective config 正确挂载 `web-access-chain`，Search/FETCH 分别指向
  `web-access-chain-search` / `web-access-chain-fetch`；
- `web-search-deepseek` 被禁用，`tool-web` 被恢复启用；
- Host boot manifest 正确广告并加载 `dsh-trinity` client artifact；
- Plugins → dsh-trinity → web-access-chain → Configure 能打开新的控制中心，
  桌面和窄屏均无水平溢出；
- `/webdoctor --active`、`/webdoctor-keys status/test` 和 `/webcache list`
  均通过真实 Web command plane，参数不会再降级为普通聊天；
- `/webdoctor-keys` 继续设置 `recordInput:false`，credential tail 不进入
  durable `command/run` 事件。

本轮按要求只使用 `minimax-cn/MiniMax-M3` 做最终 Agent/tool 路径测试；该模型
通道连续两次在任何 `tool/call` 前失败，错误为
`Anthropic stream ended without a stop reason`。因此不能声称 Exa/AnySearch 的
真实 search tool、fetch adapters 或 `source_check → search_content` 已在该模型下
端到端通过。已确认 Exa credential 配置存在，`/webdoctor --active` 的 Exa endpoint
probe 为 healthy；这仍不等价于一次完整搜索。

旧版 alpha.4 / 0.1.5 验证记录保留在历史 audit 文档中；当前安装与兼容结论以上述
0.1.7-alpha.1 结果为准。

## 安全边界

- 拒绝 loopback、私网、链路本地、保留地址与危险重定向。
- 对跨域认证请求移除 `Authorization`、`Cookie`、`X-Api-Key` 等敏感头。
- 错误、日志和工具输出经过 Key 脱敏。
- 付费 Provider 调用由用户的 Key、路由选择与预算控制；建议显式指定 Provider 进行成本敏感任务。
- 安装插件不会自动导入其他工具或 Agent skill 的 `.env` 凭证。

## 开发与验证

```bash
pnpm test
pnpm run lint:no-llm-in-providers
npm pack --dry-run
```

发布前应至少完成：Profile composition 验证、真实 `web_fetch` 验证、Provider Key 状态检查，以及 `npm pack --dry-run` 包内容检查。

## 许可证

本项目采用 [MIT License](./LICENSE)。
