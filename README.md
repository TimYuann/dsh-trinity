# DSH Trinity

> 面向 DeepSeek Harness（DSH）的多 Provider Web 搜索、网页抓取与来源核验插件。

DSH Trinity 保留 DSH 原生的 `web_search` 与 `web_fetch` 工具体验，并通过 Cordis composition 将其底层 provider 路由到插件自身的多 Provider 能力。它不修改 DSH 本体；启用、测试和卸载都以 Profile 为边界。

## 能力

### 搜索与路由

- 支持 Exa、AnySearch、Gemini、Tavily、Brave、Jina、Kagi、Perplexity 等多种搜索 Provider。
- `web_search_ex` 支持四种路由方式：自动选择、聚合、多 Provider 有序回退、强制指定单一 Provider。
- 单一 Provider 路由严格执行：v2.3.0 严格化解析，未知 Provider ID 直接抛出 `WEB_PROVIDER_BAD_REQUEST` 而不是静默回落到 `auto`。
- Provider 凭据来源统一通过 `lib/providers/provider-metadata.js` 维护；`FIRECRAWL_KEY` 等历史拼写视为只读别名，UI 只写规范名。
- 支持每个 Provider 的多 Key 轮换、配额冷却、超时与失败分类。
- MiniMax 搜索可作为自动路由的可选兜底能力。

### 网页抓取与内容处理

- 将 DSH 原生 `web_fetch` 路由到 `web-access-chain-fetch`。
- 支持 HTML、RSS/Atom、PDF、GitHub、YouTube 等内容适配器。
- 提供 Readability / Defuddle 内容提取、Markdown 转换与 RSC 页面识别。
- 提供 SSRF 防护：阻止本机、私网、保留网段及危险重定向。
- 支持域名 allow/deny policy。所有直接 HTTP I/O 走唯一一条 `safeHttpFetch`：跨域重定向时不携带敏感头，DNS 通过 `trustEnvProxy=true` 时短路否则在连接时绑定。
- v2.3.0: DSH 原生 `web_fetch` 公开接口只有 `{ url }`；`authFetch` 配置已被从公开 schema 中移除，不会向模型承诺一个它无法使用的认证 profile。

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

GitHub PR/Issue、视频提取和 PDF 提取属于可选工具，默认关闭；按 Profile 配置显式启用。

## 安装

### 从 npm 安装到 DSH Profile

```bash
# 安装到 web profile；也可将 web 替换为 dev 等独立 profile
dsh plugin --profile web add dsh-trinity@2.3.0-rc.0

# 重启该 profile 的 DSH Web host
dsh web --port 4599
```

安装后，DSH Trinity 会在该 Profile 中：

- 保留原生 `web_search` / `web_fetch` 工具；
- 将 Search/FETCH provider 分别指定为 `web-access-chain-search` 与 `web-access-chain-fetch`；
- 禁用会与插件 Search provider 产生歧义的 `web-search-deepseek` bundle；
- 在 DSH `0.1.2-alpha.4` 的 Web app composition 中显式恢复 `tool-web`，使模型侧 Web 工具可用。

> 推荐先在独立 `dev` Profile 验证，再安装到长期使用的 `web` Profile。

### 本地开发安装

```bash
dsh plugin --profile dev add file:/absolute/path/to/dsh-trinity
dsh --profile dev --port 4600
```

## 配置 Provider Key

插件使用 DSH 原生 `ctx.credentials` credential store，不创建插件私有 `.env` 文件。

### Web UI 设置页（推荐）

DSH Trinity 在 DSH Web UI 设置面板的导航条中暴露 **"Provider 密钥"** 分区（`order: 25`，位于通用设置 / 模型 / 插件 / Agent 预设之后）。在该分区可对所有受支持的 Provider（Exa、AnySearch、Gemini、Brave、Tavily 等共 27 个）进行：

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

# 聚合多 Provider
web_search_ex(query="2026 年 AI Agent 浏览器", routing="aggregate", output="sources")

# 核验一个事实性声明
source_check(claim="DSH Trinity 不会修改 DSH 本体")
```

`web_search_ex` 的 `routing` 支持：

| 值 | 行为 |
|---|---|
| `auto` | 自动按可用性和配置顺序选择 Provider。 |
| `aggregate` | 并行调用多个可用 Provider 并合并结果。 |
| `exa` 等单个 Provider ID | 强制指定一个 Provider；失败即返回失败。 |
| `["exa", "tavily"]` | 按顺序尝试 Provider。 |

## DSH 0.1.2-alpha.4 兼容性

DSH Trinity 已在真实 `dev` Profile 与 DSH `0.1.2-alpha.4` 上验证：

- `tool-web` 在 `dsh-web-app` 默认禁用时被插件 composition 显式恢复；
- `tool-web.config.fetch` 使用 DSH base 默认值；
- `web_search` / `web_fetch` 能发现并使用插件注册的 provider；
- `web-search-deepseek` 仅在启用本插件的 Profile 中被禁用；
- 真实 `ctx.web.fetch({ url: "https://example.com" })` 已通过 `web-access-chain-fetch` 返回成功结果。

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
