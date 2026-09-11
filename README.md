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

```bash
# 2.3.0 线尚未发布到 npm（当前 npm latest = 2.2.3），用本地 tarball 安装。
# 将 web 替换为 dev 即可先装到独立 Profile 验证。
dsh plugin --profile web add /absolute/path/to/dsh-trinity-2.3.0-rc.2.tgz

# 重启该 profile 的 DSH Web host
dsh web --port 4599
```

> npm 上的最新发布版本仍是 **2.2.3**（`dsh plugin --profile web add dsh-trinity@2.2.3`）。
> 本文档描述的 2.3.0 行为来自本地 tarball 与源码，**不是** npm 上可安装的版本。
> 插件加入 Profile 后不会热生效：`dsh` 的 live patch watcher 只监听
> `cordis.patch.yml`，不监听 `package.json`，所以必须重启该 Profile 才会激活。

安装后，DSH Trinity 会在该 Profile 中：

- 保留原生 `web_search` / `web_fetch` 工具；
- 将 Search/FETCH provider 分别指定为 `web-access-chain-search` 与 `web-access-chain-fetch`；
- 禁用会与插件 Search provider 产生歧义的 `web-search-deepseek` bundle；
- 显式恢复 `dsh-web-app` 默认禁用的 `tool-web`，使模型侧 Web 工具可用（该行在 DSH `0.1.5-rc.2` 与 `0.1.2-alpha.4` 上均为必要，见下方验证记录）。

> 推荐先在独立 `dev` Profile 验证，再安装到长期使用的 `web` Profile。

### 本地开发安装

```bash
dsh plugin --profile dev add file:/absolute/path/to/dsh-trinity
dsh --profile dev --port 4600
```

## 配置 Provider Key

插件使用 DSH 原生 `ctx.credentials` credential store，不创建插件私有 `.env` 文件。

### Web UI 设置页（推荐）

DSH Trinity 在 DSH Web UI 设置面板的导航条中暴露 **"Provider 密钥"** 分区（`order: 25`，位于通用设置 / 模型 / 插件 / Agent 预设之后）。在该分区可对所有**在 UI 中可见的 25 个** Provider（Exa、AnySearch、Gemini、Brave、Tavily 等）进行：

- **Save** —— 在 password input 输入 key 后直接调用 `ctx.credentials.set(ref, value)`；提交后输入框立即清空，状态行短暂显示"已保存（末四位：1234）"作为本次回执。
- **Test** —— 仅调用 `ctx.credentials.describe(ref)`，不向任何外部 Provider 发送请求，不产生费用。
- **Clear** —— 二次确认后调用 `ctx.credentials.unset(ref)`，刷新状态。

安全约束：

- 完整 key 永远不进入 chat composer、session log、host log、settings.yaml、模型 prompt、tool argument、console log 或 telemetry payload。
- `last4` 是在用户点击 Save 的瞬间**在浏览器**根据用户输入计算出的，**仅在 React 组件 state 中短暂存在**，刷新页面、关闭弹窗或 context 停止后即被丢弃；host 永远不返回完整 key，也永远不在 `describe` 响应中回显后四位。
- 设置页的 `web-access-chain` settings YAML **只管理非敏感配置**（routing、timeout、Provider 开关、fetch policy 等），不包含任何 Provider key。
- 跨域、未认证或非 loopback 访问均被 DSH 自身 trusted-host fence 拒绝；本插件不引入新 HTTP 路由。

**禁止在聊天框粘贴 key。** 聊天路径会把消息内容写入 session JSONL，DSH Trinity 与 DSH 都无法清理。始终使用 Web UI 设置页或 `/webdoctor-keys` 命令。

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

## DSH 0.1.2-alpha.4 兼容性

DSH Trinity 已在真实 `dev` Profile 与 DSH `0.1.2-alpha.4` 上验证：

- `tool-web` 在 `dsh-web-app` 默认禁用时被插件 composition 显式恢复；
- `tool-web.config.fetch` 使用 DSH base 默认值；
- `web_search` / `web_fetch` 能发现并使用插件注册的 provider；
- `web-search-deepseek` 仅在启用本插件的 Profile 中被禁用；
- 真实 `ctx.web.fetch({ url: "https://example.com" })` 已通过 `web-access-chain-fetch` 返回成功结果。

> **2026-09-11 补充**：实测兼容 DSH 0.1.5-rc.2；`tool-web` patch 在 0.1.5-rc.2 下仍生效（实测 `dsh-web-app@0.1.5-rc.2` 的 cordis.patch.yml 仍带 `disabled: true`，本行 `disabled: false` 是必要的；该行在 alpha.4 与 rc.x 上同样正确）。其余 host 接触面（`ctx.llm` / `agentDefaultModel` / `slots.settings.section` 等）经核对未变更。

> v2.3.0: `web-access-chain-search` 与 `web-access-chain-fetch` 的
> namespaced provider ID 已经成为稳定 API。任何基于 `searchProvider`
> 之外的 monkey-patching 都已不再需要；迁移说明见
> `BASELINE_v2.3.0.md` 与本仓库的 release notes。

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
