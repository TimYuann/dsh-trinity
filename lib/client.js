window.__ModuleLoader__.load({
  id: "dsh-trinity",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let _deepseek_ai_dsh_client_ui_slots = require("@deepseek-ai/dsh-client-ui-slots");

    // dsh-trinity Web control center for DSH 0.1.7-alpha.1.
    //
    // The page lives on the owning Loader row through `plugins.row.config`.
    // Secrets still use the existing `remote.credentials` domain exclusively:
    // configuration pages never receive or persist a stored credential value.
    // The only fingerprint shown is computed from the value typed in this
    // browser session and disappears when the page unmounts.

    var PLACEHOLDER_TOKENS = new Set([
      "your-key", "xxx", "dummy", "null", "undefined", "changeme",
      "placeholder", "todo", "fixme", "replace-me", "replace_me",
      "example", "sample", "test",
    ]);

    function clientLast4(value) {
      if (typeof value !== "string") return null;
      if (value.length < 8) return null;
      var trimmed = value.trim();
      if (trimmed.length < 8) return null;
      if (PLACEHOLDER_TOKENS.has(trimmed.toLowerCase())) return null;
      return value.slice(-4);
    }

    function clientValidateValue(value, mode) {
      if (typeof value !== "string") return { ok: false, code: "bad-shape" };
      if (value.length === 0 || value.trim().length === 0) return { ok: false, code: "empty" };
      var trimmed = value.trim();
      if (PLACEHOLDER_TOKENS.has(trimmed.toLowerCase())) return { ok: false, code: "placeholder" };
      if (mode === "host") {
        try {
          var parsed = new URL(trimmed);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, code: "bad-url" };
        } catch (_) {
          return { ok: false, code: "bad-url" };
        }
      } else if (value.length < 8) {
        return { ok: false, code: "too-short" };
      }
      return { ok: true, value: value };
    }

    // BEGIN GENERATED TRINITY PROVIDERS
var PROVIDERS = [
      { id: "searxng", label: "SearXNG", env: "SEARXNG_HOST", mode: "host", autoEligible: true, showInCredentialUi: true },
      { id: "exa", label: "Exa", env: "EXA_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "brave", label: "Brave", env: "BRAVE_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "parallel", label: "Parallel", env: "PARALLEL_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "tinyfish", label: "TinyFish", env: "TINYFISH_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "search1api", label: "Search1API", env: "SEARCH1API_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "searchinfinity", label: "SearchInfinity", env: "SEARCHINFINITY_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "querit", label: "Querit", env: "QUERIT_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "tavily", label: "Tavily", env: "TAVILY_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "firecrawl", label: "Firecrawl", env: "FIRECRAWL_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "jina", label: "Jina", env: "JINA_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "serpdive", label: "SERPdive", env: "SERPDIVE_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "kagi", label: "Kagi", env: "KAGI_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "bocha", label: "Bocha", env: "BOCHA_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "ollama", label: "Ollama", env: "OLLAMA_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "perplexity", label: "Perplexity", env: "PERPLEXITY_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "gemini", label: "Gemini", env: "GEMINI_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "duckduckgo", label: "DuckDuckGo", env: "", mode: "none", autoEligible: false, showInCredentialUi: false },
      { id: "anysearch", label: "AnySearch", env: "ANYSEARCH_API_KEY", mode: "api-key", autoEligible: true, showInCredentialUi: true },
      { id: "xai", label: "xAI", env: "XAI_API_KEY", mode: "api-key", autoEligible: false, showInCredentialUi: true },
      { id: "brightdata", label: "Bright Data", env: "BRIGHTDATA_API_KEY", mode: "api-key", autoEligible: false, showInCredentialUi: true },
      { id: "serpbase", label: "SerpBase", env: "SERPBASE_API_KEY", mode: "api-key", autoEligible: false, showInCredentialUi: true },
      { id: "serper", label: "Serper", env: "SERPER_API_KEY", mode: "api-key", autoEligible: false, showInCredentialUi: true },
      { id: "valyu", label: "Valyu", env: "VALYU_API_KEY", mode: "api-key", autoEligible: false, showInCredentialUi: true },
      { id: "kimi", label: "Kimi", env: "KIMI_API_KEY", mode: "api-key", autoEligible: false, showInCredentialUi: true },
      { id: "parallelMcp", label: "Parallel MCP", env: "PARALLEL_MCP_API_KEY", mode: "api-key", autoEligible: false, showInCredentialUi: true },
    ];
    // END GENERATED TRINITY PROVIDERS

    var GROUP_ORDER = ["self-hosted", "automatic", "explicit"];

    function providerGroup(provider) {
      if (provider.mode === "host") return "self-hosted";
      return provider.autoEligible ? "automatic" : "explicit";
    }

    var css =
      ".dshT-shell{box-sizing:border-box;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;display:flex;flex-direction:column;gap:16px;min-width:0}" +
      ".dshT-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px;border:1px solid var(--dsw-alias-border-soft);border-radius:16px;background:linear-gradient(135deg,var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-2))}" +
      ".dshT-heroCopy{min-width:0;display:flex;flex-direction:column;gap:4px}" +
      ".dshT-title{font-size:18px;line-height:26px;font-weight:600;margin:0}" +
      ".dshT-intro{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0;max-width:720px}" +
      ".dshT-score{flex:none;display:flex;align-items:baseline;gap:4px;padding:8px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-soft)}" +
      ".dshT-score strong{font-size:22px;line-height:26px}" +
      ".dshT-score span{color:var(--dsw-alias-label-secondary);font-size:12px}" +
      ".dshT-tabs{display:flex;gap:4px;padding:4px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);width:max-content;max-width:100%;overflow:auto}" +
      ".dshT-tab{cursor:pointer;white-space:nowrap;border:0;border-radius:9px;padding:7px 12px;color:var(--dsw-alias-label-secondary);background:transparent;font:inherit;font-size:13px}" +
      ".dshT-tab[aria-selected='true']{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 3px rgba(0,0,0,.12)}" +
      ".dshT-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center}" +
      ".dshT-search{box-sizing:border-box;min-width:220px;flex:1;height:38px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-input);border:1px solid var(--dsw-alias-border-soft);border-radius:10px;font:inherit;padding:0 12px}" +
      ".dshT-search:focus,.dshT-input:focus,.dshT-rowToggle:focus-visible,.dshT-btn:focus-visible,.dshT-tab:focus-visible,.dshT-filter:focus-visible{outline:2px solid var(--dsw-alias-focus);outline-offset:1px}" +
      ".dshT-filters{display:flex;gap:6px;flex-wrap:wrap}" +
      ".dshT-filter{cursor:pointer;border:1px solid var(--dsw-alias-border-soft);border-radius:999px;padding:5px 10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:12px}" +
      ".dshT-filter[aria-pressed='true']{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-focus);background:var(--dsw-alias-bg-layer-2)}" +
      ".dshT-warning{box-sizing:border-box;background:var(--dsw-alias-bg-warning-soft);color:var(--dsw-alias-label-warning);border-radius:10px;padding:10px 12px;font-size:12px;line-height:18px;margin:0}" +
      ".dshT-group{display:flex;flex-direction:column;gap:8px}" +
      ".dshT-groupHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}" +
      ".dshT-groupTitle{font-size:13px;line-height:20px;font-weight:600;margin:0}" +
      ".dshT-groupHint{color:var(--dsw-alias-label-secondary);font-size:12px}" +
      ".dshT-list{display:flex;flex-direction:column;gap:8px;list-style:none;padding:0;margin:0}" +
      ".dshT-row{box-sizing:border-box;border:1px solid var(--dsw-alias-border-soft);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}" +
      ".dshT-row[data-open='true']{border-color:var(--dsw-alias-focus)}" +
      ".dshT-rowToggle{box-sizing:border-box;width:100%;cursor:pointer;border:0;background:transparent;color:inherit;text-align:left;padding:12px;display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center;font:inherit}" +
      ".dshT-rowIdentity{min-width:0;display:flex;align-items:center;gap:9px}" +
      ".dshT-dot{flex:none;width:8px;height:8px;border-radius:50%}" +
      ".dshT-dotSet{background:var(--dsw-alias-success)}" +
      ".dshT-dotUnset{background:var(--dsw-alias-warning)}" +
      ".dshT-dotNeutral{background:var(--dsw-alias-label-secondary)}" +
      ".dshT-rowNames{min-width:0;display:flex;flex-direction:column}" +
      ".dshT-rowLabel{font-weight:550;line-height:20px;overflow:hidden;text-overflow:ellipsis}" +
      ".dshT-rowId{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-family:ui-monospace,monospace}" +
      ".dshT-badge{display:inline-flex;align-items:center;width:max-content;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:999px;padding:3px 8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}" +
      ".dshT-badgeGood{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-success)}" +
      ".dshT-chevron{color:var(--dsw-alias-label-secondary);font-size:15px;transition:transform .15s ease}" +
      ".dshT-row[data-open='true'] .dshT-chevron{transform:rotate(90deg)}" +
      ".dshT-editor{display:flex;flex-direction:column;gap:10px;padding:0 12px 12px;border-top:1px solid var(--dsw-alias-border-soft)}" +
      ".dshT-meta{display:flex;flex-wrap:wrap;gap:8px 14px;padding-top:10px;color:var(--dsw-alias-label-secondary);font-size:12px}" +
      ".dshT-meta code{font-family:ui-monospace,monospace}" +
      ".dshT-form{display:flex;flex-direction:column;gap:8px}" +
      ".dshT-fieldLabel{font-size:12px;font-weight:500}" +
      ".dshT-input{box-sizing:border-box;width:100%;height:38px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-input);border:1px solid var(--dsw-alias-border-soft);border-radius:9px;font:inherit;padding:0 11px}" +
      ".dshT-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}" +
      ".dshT-btn{cursor:pointer;min-height:34px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-soft);border-radius:9px;padding:0 12px;font:inherit;font-size:12px;display:inline-flex;align-items:center;justify-content:center}" +
      ".dshT-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".dshT-btnPrimary{background:var(--dsw-alias-interactive-bg-primary);color:var(--dsw-alias-label-on-primary);border-color:transparent}" +
      ".dshT-btnDanger{background:var(--dsw-alias-bg-danger-soft);color:var(--dsw-alias-label-danger);border-color:transparent}" +
      ".dshT-btn[disabled]{opacity:.5;cursor:not-allowed}" +
      ".dshT-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
      ".dshT-statusErr{color:var(--dsw-alias-label-danger)}" +
      ".dshT-statusOk{color:var(--dsw-alias-label-success)}" +
      ".dshT-last4{font-family:ui-monospace,monospace;background:var(--dsw-alias-bg-layer-2);padding:1px 6px;border-radius:6px}" +
      ".dshT-confirm{display:flex;flex-direction:column;gap:8px;padding:9px 10px;background:var(--dsw-alias-bg-warning-soft);border-radius:9px;font-size:12px}" +
      ".dshT-empty{padding:28px 16px;text-align:center;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-soft);border-radius:12px}" +
      ".dshT-routeGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}" +
      ".dshT-routeCard,.dshT-diagnostic{border:1px solid var(--dsw-alias-border-soft);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:13px;display:flex;flex-direction:column;gap:8px}" +
      ".dshT-routeList{display:flex;flex-wrap:wrap;gap:6px;list-style:none;padding:0;margin:0}" +
      ".dshT-diagnosticGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}" +
      ".dshT-metric{font-size:24px;line-height:30px;font-weight:600}" +
      ".dshT-summary{color:var(--dsw-alias-label-secondary);font-size:12px}" +
      "@media(max-width:620px){.dshT-hero{flex-direction:column}.dshT-score{align-self:flex-start}.dshT-rowToggle{grid-template-columns:minmax(0,1fr) auto}.dshT-rowToggle>.dshT-badge{display:none}}";

    var TAG_ID = "dsh-trinity/control-center.css";
    var C = {
      shell: "dshT-shell", hero: "dshT-hero", heroCopy: "dshT-heroCopy", title: "dshT-title", intro: "dshT-intro",
      score: "dshT-score", tabs: "dshT-tabs", tab: "dshT-tab", toolbar: "dshT-toolbar", search: "dshT-search",
      filters: "dshT-filters", filter: "dshT-filter", warning: "dshT-warning", group: "dshT-group", groupHead: "dshT-groupHead",
      groupTitle: "dshT-groupTitle", groupHint: "dshT-groupHint", list: "dshT-list", row: "dshT-row", rowToggle: "dshT-rowToggle",
      rowIdentity: "dshT-rowIdentity", dot: "dshT-dot", dotSet: "dshT-dotSet", dotUnset: "dshT-dotUnset", dotNeutral: "dshT-dotNeutral",
      rowNames: "dshT-rowNames", rowLabel: "dshT-rowLabel", rowId: "dshT-rowId", badge: "dshT-badge", badgeGood: "dshT-badgeGood",
      chevron: "dshT-chevron", editor: "dshT-editor", meta: "dshT-meta", form: "dshT-form", fieldLabel: "dshT-fieldLabel",
      input: "dshT-input", actions: "dshT-actions", btn: "dshT-btn", btnPrimary: "dshT-btnPrimary", btnDanger: "dshT-btnDanger",
      status: "dshT-status", statusErr: "dshT-statusErr", statusOk: "dshT-statusOk", last4: "dshT-last4", confirm: "dshT-confirm",
      empty: "dshT-empty", routeGrid: "dshT-routeGrid", routeCard: "dshT-routeCard", routeList: "dshT-routeList",
      diagnostic: "dshT-diagnostic", diagnosticGrid: "dshT-diagnosticGrid", metric: "dshT-metric", summary: "dshT-summary",
    };

    var NS = "plugins.trinity";
    var en = {
      title: "Trinity Web Access",
      intro: "Manage search providers, understand routing, and inspect credential readiness without exposing stored secrets.",
      summaryLoading: "Loading provider status…",
      summaryReady: "{configured} of {total} providers configured",
      providersTab: "Providers",
      routingTab: "Routing",
      diagnosticsTab: "Diagnostics",
      searchPlaceholder: "Search providers, ids, or credential refs",
      filterAll: "All",
      filterConfigured: "Configured",
      filterMissing: "Needs setup",
      configured: "Configured",
      missing: "Needs setup",
      keyless: "Keyless",
      readOnly: "Read-only source",
      groupSelfHosted: "Self-hosted",
      groupAutomatic: "Automatic route",
      groupExplicit: "Explicit only",
      hintSelfHosted: "Private endpoints you operate.",
      hintAutomatic: "Eligible for the default automatic route.",
      hintExplicit: "Used only when a tool call selects them explicitly.",
      routeSelfHosted: "Self-hosted",
      routeAutomatic: "Automatic",
      routeExplicit: "Explicit",
      providerId: "provider id",
      credentialRef: "credential ref",
      source: "source",
      writable: "writable",
      apiKeyLabel: "API key",
      hostLabel: "Endpoint URL",
      apiKeyPlaceholder: "Paste API key",
      hostPlaceholder: "https://search.example.com",
      save: "Save",
      saving: "Saving…",
      checkStatus: "Refresh status",
      clear: "Clear",
      clearConfirmTitle: "Clear stored value?",
      clearConfirmBody: "The stored value for {provider} will be removed. You can add it again later.",
      confirmClear: "Clear value",
      cancel: "Cancel",
      saved: "Saved (last4: {last4}).",
      cleared: "Cleared.",
      statusConfigured: "Configured via {source}; writable: {writable}.",
      statusMissing: "No stored value was found.",
      neverChat: "Never paste credentials into chat. Chat input is durable session data; this page writes only through DSH credentials.",
      routingIntro: "The route is split into automatic, explicit-only, and keyless/self-hosted providers. This view describes eligibility; each tool call can still select a provider explicitly.",
      diagnosticsIntro: "These checks inspect DSH credential metadata only. They do not contact providers or incur usage. Use /webdoctor --active for network probes.",
      refreshAll: "Refresh all status",
      configuredMetric: "Configured",
      missingMetric: "Needs setup",
      writableMetric: "Writable",
      totalMetric: "Credential rows",
      noMatches: "No providers match the current search and filter.",
      unavailable: "The DSH credentials service is not available on this host.",
      loading: "Loading provider status…",
      errGeneric: "Operation failed.",
      errEmpty: "Enter a value to save.",
      errPlaceholder: "That looks like placeholder text. Paste the real value.",
      errTooShort: "That key is too short to be real.",
      errBadUrl: "Enter an http:// or https:// endpoint URL.",
      errCancelled: "Operation cancelled.",
    };
    var zh = {
      title: "Trinity 联网控制中心",
      intro: "集中管理搜索 Provider、查看路由归属并检查凭据就绪状态；已保存的密钥不会被页面读取或回显。",
      summaryLoading: "正在读取 Provider 状态…",
      summaryReady: "已配置 {configured} / {total} 个 Provider",
      providersTab: "Providers",
      routingTab: "路由",
      diagnosticsTab: "诊断",
      searchPlaceholder: "搜索 Provider、ID 或凭据引用",
      filterAll: "全部",
      filterConfigured: "已配置",
      filterMissing: "待配置",
      configured: "已配置",
      missing: "待配置",
      keyless: "无需密钥",
      readOnly: "来源只读",
      groupSelfHosted: "自托管",
      groupAutomatic: "自动路由",
      groupExplicit: "仅显式调用",
      hintSelfHosted: "由你维护的私有搜索端点。",
      hintAutomatic: "默认自动路由会考虑这些 Provider。",
      hintExplicit: "仅在工具调用明确选择时使用。",
      routeSelfHosted: "自托管",
      routeAutomatic: "自动",
      routeExplicit: "显式",
      providerId: "Provider ID",
      credentialRef: "凭据引用",
      source: "来源",
      writable: "可写",
      apiKeyLabel: "API 密钥",
      hostLabel: "端点 URL",
      apiKeyPlaceholder: "粘贴 API 密钥",
      hostPlaceholder: "https://search.example.com",
      save: "保存",
      saving: "保存中…",
      checkStatus: "刷新状态",
      clear: "清除",
      clearConfirmTitle: "确认清除？",
      clearConfirmBody: "将移除 {provider} 的已存值，之后可以重新添加。",
      confirmClear: "清除",
      cancel: "取消",
      saved: "已保存（末四位：{last4}）。",
      cleared: "已清除。",
      statusConfigured: "已配置；来源：{source}；可写：{writable}。",
      statusMissing: "未找到已保存的值。",
      neverChat: "请勿把凭据粘贴到聊天框。聊天内容会写入会话记录；本页面只通过 DSH credentials 写入。",
      routingIntro: "Provider 分为自动路由、仅显式调用、无需密钥和自托管几类。这里展示的是参与资格；单次工具调用仍可明确指定 Provider。",
      diagnosticsIntro: "这里仅检查 DSH 凭据元数据，不会访问 Provider，也不会产生费用。需要网络探测时请运行 /webdoctor --active。",
      refreshAll: "刷新全部状态",
      configuredMetric: "已配置",
      missingMetric: "待配置",
      writableMetric: "可写",
      totalMetric: "凭据项",
      noMatches: "没有符合当前搜索和筛选条件的 Provider。",
      unavailable: "当前宿主没有挂载 DSH credentials 服务。",
      loading: "正在读取 Provider 状态…",
      errGeneric: "操作失败。",
      errEmpty: "请输入要保存的值。",
      errPlaceholder: "看起来像占位文本，请填写真实值。",
      errTooShort: "密钥长度过短，请检查。",
      errBadUrl: "请输入 http:// 或 https:// 开头的端点 URL。",
      errCancelled: "操作已取消。",
    };

    function format(template, vars) {
      if (typeof template !== "string") return "";
      return template.replace(/\{(\w+)\}/g, function (_, key) {
        return vars && vars[key] != null ? String(vars[key]) : "{" + key + "}";
      });
    }

    function mapCodeToMessage(t, code) {
      if (code === "empty") return t("errEmpty");
      if (code === "placeholder") return t("errPlaceholder");
      if (code === "too-short") return t("errTooShort");
      if (code === "bad-url") return t("errBadUrl");
      if (code === "gateway/cancelled") return t("errCancelled");
      if (code === "credentials/unavailable") return t("unavailable");
      return t("errGeneric");
    }

    function statusFor(provider, snapshot) {
      if (provider.mode === "none") return { configured: true, source: "keyless", writable: false };
      return snapshot && snapshot[provider.id]
        ? snapshot[provider.id]
        : { configured: false, source: null, writable: null };
    }

    function routeLabel(t, provider) {
      var group = providerGroup(provider);
      if (group === "self-hosted") return t("routeSelfHosted");
      if (group === "automatic") return t("routeAutomatic");
      return t("routeExplicit");
    }

    function ProviderRow(props) {
      var provider = props.provider;
      var info = props.info;
      var cred = props.cred;
      var t = props.t;
      var expanded = props.expanded;
      var onToggle = props.onToggle;
      var onSaved = props.onSaved;
      var onCleared = props.onCleared;
      var onRefresh = props.onRefresh;
      var last4Session = props.last4Session;

      var _useState = (0, react.useState)("");
      var draft = _useState[0];
      var setDraft = _useState[1];
      var _useState2 = (0, react.useState)(false);
      var busy = _useState2[0];
      var setBusy = _useState2[1];
      var _useState3 = (0, react.useState)(null);
      var status = _useState3[0];
      var setStatus = _useState3[1];
      var _useState4 = (0, react.useState)(false);
      var confirming = _useState4[0];
      var setConfirming = _useState4[1];

      var configured = !!(info && info.configured);
      var writable = !(info && info.writable === false);
      var inputId = "dsht-input-" + provider.id;

      async function callRemote(action) {
        setBusy(true);
        try {
          return await action();
        } finally {
          setBusy(false);
        }
      }

      async function onSubmit(event) {
        event.preventDefault();
        if (busy || !writable) return;
        setStatus(null);
        var validation = clientValidateValue(draft, provider.mode);
        if (!validation.ok) {
          setStatus({ kind: "err", message: mapCodeToMessage(t, validation.code) });
          return;
        }
        var submitted = draft;
        var fingerprint = clientLast4(submitted);
        setDraft("");
        var result = await callRemote(function () { return cred.set(provider.env, submitted); });
        if (result && result.ok) {
          onSaved(provider.env, fingerprint);
          setStatus({ kind: "ok", message: format(t("saved"), { last4: fingerprint || "****" }) });
        } else {
          setStatus({ kind: "err", message: mapCodeToMessage(t, result && result.code) });
        }
      }

      async function onCheck() {
        if (busy) return;
        var result = await callRemote(function () { return cred.describe([provider.env]); });
        if (result && result.ok) {
          var entry = result.value && result.value[provider.env];
          setStatus(entry && entry.configured
            ? { kind: "ok", message: format(t("statusConfigured"), { source: entry.source || "?", writable: String(entry.writable) }) }
            : { kind: "ok", message: t("statusMissing") });
          onRefresh();
        } else {
          setStatus({ kind: "err", message: mapCodeToMessage(t, result && result.code) });
        }
      }

      async function onClearConfirmed() {
        if (busy || !writable) return;
        setConfirming(false);
        setStatus(null);
        var result = await callRemote(function () { return cred.unset(provider.env); });
        if (result && result.ok) {
          onCleared(provider.env);
          setStatus({ kind: "ok", message: t("cleared") });
        } else {
          setStatus({ kind: "err", message: mapCodeToMessage(t, result && result.code) });
        }
      }

      return (0, react.createElement)(
        "li",
        { className: C.row, "data-provider": provider.id, "data-open": expanded ? "true" : "false" },
        (0, react.createElement)(
          "button",
          { type: "button", className: C.rowToggle, onClick: onToggle, "aria-expanded": expanded },
          (0, react.createElement)(
            "span",
            { className: C.rowIdentity },
            (0, react.createElement)("span", {
              className: C.dot + " " + (configured ? C.dotSet : C.dotUnset),
              "aria-hidden": "true",
            }),
            (0, react.createElement)(
              "span",
              { className: C.rowNames },
              (0, react.createElement)("span", { className: C.rowLabel }, provider.label),
              (0, react.createElement)("span", { className: C.rowId }, provider.id)
            )
          ),
          (0, react.createElement)("span", { className: C.badge + (configured ? " " + C.badgeGood : "") }, configured ? t("configured") : t("missing")),
          (0, react.createElement)("span", { className: C.chevron, "aria-hidden": "true" }, "›")
        ),
        expanded
          ? (0, react.createElement)(
              "div",
              { className: C.editor },
              (0, react.createElement)(
                "div",
                { className: C.meta },
                (0, react.createElement)("span", null, t("providerId") + ": ", (0, react.createElement)("code", null, provider.id)),
                (0, react.createElement)("span", null, t("credentialRef") + ": ", (0, react.createElement)("code", null, provider.env)),
                (0, react.createElement)("span", null, routeLabel(t, provider)),
                configured ? (0, react.createElement)("span", null, t("source") + ": " + (info.source || "?")) : null,
                last4Session ? (0, react.createElement)("span", null, "last4: ", (0, react.createElement)("span", { className: C.last4 }, "***" + last4Session)) : null
              ),
              (0, react.createElement)(
                "form",
                { className: C.form, onSubmit: onSubmit, autoComplete: "off" },
                (0, react.createElement)("label", { className: C.fieldLabel, htmlFor: inputId }, provider.mode === "host" ? t("hostLabel") : t("apiKeyLabel")),
                (0, react.createElement)("input", {
                  id: inputId,
                  className: C.input,
                  type: provider.mode === "host" ? "url" : "password",
                  inputMode: "text",
                  autoComplete: "off",
                  autoCorrect: "off",
                  autoCapitalize: "off",
                  spellCheck: false,
                  placeholder: provider.mode === "host" ? t("hostPlaceholder") : t("apiKeyPlaceholder"),
                  value: draft,
                  disabled: busy || !writable,
                  onChange: function (event) { setDraft(typeof event.target.value === "string" ? event.target.value : ""); },
                }),
                (0, react.createElement)(
                  "div",
                  { className: C.actions },
                  (0, react.createElement)("button", { type: "submit", className: C.btn + " " + C.btnPrimary, disabled: busy || !writable }, busy ? t("saving") : t("save")),
                  (0, react.createElement)("button", { type: "button", className: C.btn, disabled: busy, onClick: onCheck }, t("checkStatus")),
                  (0, react.createElement)("button", { type: "button", className: C.btn + " " + C.btnDanger, disabled: busy || !configured || !writable, onClick: function () { setConfirming(true); } }, t("clear"))
                ),
                !writable ? (0, react.createElement)("div", { className: C.status }, t("readOnly")) : null,
                confirming
                  ? (0, react.createElement)(
                      "div",
                      { className: C.confirm, role: "alertdialog", "aria-label": t("clearConfirmTitle") },
                      (0, react.createElement)("strong", null, t("clearConfirmTitle")),
                      (0, react.createElement)("span", null, format(t("clearConfirmBody"), { provider: provider.label })),
                      (0, react.createElement)(
                        "div",
                        { className: C.actions },
                        (0, react.createElement)("button", { type: "button", className: C.btn + " " + C.btnDanger, disabled: busy, onClick: onClearConfirmed, autoFocus: true }, t("confirmClear")),
                        (0, react.createElement)("button", { type: "button", className: C.btn, disabled: busy, onClick: function () { setConfirming(false); } }, t("cancel"))
                      )
                    )
                  : null,
                status
                  ? (0, react.createElement)("div", { className: C.status + " " + (status.kind === "ok" ? C.statusOk : C.statusErr), role: status.kind === "err" ? "alert" : "status" }, status.message)
                  : null
              )
            )
          : null
      );
    }

    function ProviderGroups(props) {
      var providers = props.providers;
      var snapshot = props.snapshot;
      var expanded = props.expanded;
      var setExpanded = props.setExpanded;
      var cred = props.cred;
      var t = props.t;
      var last4Session = props.last4Session;
      var onSaved = props.onSaved;
      var onCleared = props.onCleared;
      var onRefresh = props.onRefresh;

      if (providers.length === 0) return (0, react.createElement)("div", { className: C.empty }, t("noMatches"));

      return GROUP_ORDER.map(function (group) {
        var rows = providers.filter(function (provider) { return providerGroup(provider) === group; });
        if (rows.length === 0) return null;
        var titleKey = group === "self-hosted" ? "groupSelfHosted" : group === "automatic" ? "groupAutomatic" : "groupExplicit";
        var hintKey = group === "self-hosted" ? "hintSelfHosted" : group === "automatic" ? "hintAutomatic" : "hintExplicit";
        return (0, react.createElement)(
          "section",
          { className: C.group, key: group },
          (0, react.createElement)(
            "div",
            { className: C.groupHead },
            (0, react.createElement)("h4", { className: C.groupTitle }, t(titleKey)),
            (0, react.createElement)("span", { className: C.groupHint }, t(hintKey))
          ),
          (0, react.createElement)(
            "ul",
            { className: C.list },
            rows.map(function (provider) {
              var info = statusFor(provider, snapshot);
              return (0, react.createElement)(ProviderRow, {
                key: provider.id,
                provider: provider,
                info: info,
                cred: cred,
                t: t,
                expanded: expanded === provider.id,
                onToggle: function () { setExpanded(expanded === provider.id ? null : provider.id); },
                last4Session: last4Session[provider.env] || null,
                onSaved: onSaved,
                onCleared: onCleared,
                onRefresh: onRefresh,
              });
            })
          )
        );
      });
    }

    function RoutingView(props) {
      var snapshot = props.snapshot;
      var t = props.t;
      return (0, react.createElement)(
        react.Fragment,
        null,
        (0, react.createElement)("p", { className: C.intro }, t("routingIntro")),
        (0, react.createElement)(
          "div",
          { className: C.routeGrid },
          GROUP_ORDER.map(function (group) {
            var rows = PROVIDERS.filter(function (provider) { return providerGroup(provider) === group; });
            var titleKey = group === "self-hosted" ? "groupSelfHosted" : group === "automatic" ? "groupAutomatic" : "groupExplicit";
            var hintKey = group === "self-hosted" ? "hintSelfHosted" : group === "automatic" ? "hintAutomatic" : "hintExplicit";
            return (0, react.createElement)(
              "section",
              { className: C.routeCard, key: group },
              (0, react.createElement)("h4", { className: C.groupTitle }, t(titleKey)),
              (0, react.createElement)("p", { className: C.intro }, t(hintKey)),
              (0, react.createElement)(
                "ul",
                { className: C.routeList },
                rows.map(function (provider) {
                  var info = statusFor(provider, snapshot);
                  var text = provider.label + " · " + (provider.mode === "none" ? t("keyless") : info.configured ? t("configured") : t("missing"));
                  return (0, react.createElement)("li", { className: C.badge + (info.configured ? " " + C.badgeGood : ""), key: provider.id, title: provider.id }, text);
                })
              )
            );
          })
        )
      );
    }

    function DiagnosticsView(props) {
      var snapshot = props.snapshot;
      var t = props.t;
      var reload = props.reload;
      var credentialProviders = PROVIDERS.filter(function (provider) { return provider.showInCredentialUi; });
      var configured = credentialProviders.filter(function (provider) { return statusFor(provider, snapshot).configured; }).length;
      var writable = credentialProviders.filter(function (provider) { return statusFor(provider, snapshot).writable !== false; }).length;
      var metrics = [
        ["configuredMetric", configured],
        ["missingMetric", credentialProviders.length - configured],
        ["writableMetric", writable],
        ["totalMetric", credentialProviders.length],
      ];
      return (0, react.createElement)(
        react.Fragment,
        null,
        (0, react.createElement)("p", { className: C.intro }, t("diagnosticsIntro")),
        (0, react.createElement)(
          "div",
          { className: C.diagnosticGrid },
          metrics.map(function (metric) {
            return (0, react.createElement)(
              "section",
              { className: C.diagnostic, key: metric[0] },
              (0, react.createElement)("span", { className: C.metric }, String(metric[1])),
              (0, react.createElement)("span", { className: C.intro }, t(metric[0]))
            );
          })
        ),
        (0, react.createElement)("div", { className: C.actions }, (0, react.createElement)("button", { type: "button", className: C.btn + " " + C.btnPrimary, onClick: reload }, t("refreshAll")))
      );
    }

    function ControlCenter(props) {
      var cred = props.cred;
      var t = props.t;
      var view = props.view || "page";
      var _useState5 = (0, react.useState)(null);
      var snapshot = _useState5[0];
      var setSnapshot = _useState5[1];
      var _useState6 = (0, react.useState)(null);
      var error = _useState6[0];
      var setError = _useState6[1];
      var _useState7 = (0, react.useState)("providers");
      var tab = _useState7[0];
      var setTab = _useState7[1];
      var _useState8 = (0, react.useState)("");
      var query = _useState8[0];
      var setQuery = _useState8[1];
      var _useState9 = (0, react.useState)("all");
      var filter = _useState9[0];
      var setFilter = _useState9[1];
      var _useState10 = (0, react.useState)(null);
      var expanded = _useState10[0];
      var setExpanded = _useState10[1];
      var _useState11 = (0, react.useState)({});
      var last4Session = _useState11[0];
      var setLast4Session = _useState11[1];

      async function reload() {
        if (!cred || typeof cred.describe !== "function") {
          setError({ code: "credentials/unavailable" });
          return;
        }
        var refs = PROVIDERS.filter(function (provider) { return provider.showInCredentialUi && provider.env; }).map(function (provider) { return provider.env; });
        var result = await cred.describe(refs);
        if (!result || result.ok === false) {
          setError({ code: result && result.code ? result.code : "unknown" });
          return;
        }
        var map = result.value || {};
        var next = {};
        for (var i = 0; i < PROVIDERS.length; i++) {
          var provider = PROVIDERS[i];
          if (provider.mode === "none") {
            next[provider.id] = { configured: true, source: "keyless", writable: false };
            continue;
          }
          var entry = map[provider.env];
          next[provider.id] = {
            configured: !!(entry && entry.configured),
            source: entry && entry.source ? entry.source : null,
            writable: entry && typeof entry.writable === "boolean" ? entry.writable : null,
          };
        }
        setSnapshot(next);
        setError(null);
      }

      (0, react.useEffect)(function () { reload(); }, []);
      (0, react.useEffect)(function () {
        if (!cred || typeof cred.$on !== "function") return;
        var off = cred.$on("credentials/reference-updated", function () { reload(); });
        return typeof off === "function" ? off : function () {};
      }, []);

      var credentialProviders = PROVIDERS.filter(function (provider) { return provider.showInCredentialUi; });
      var configuredCount = snapshot
        ? credentialProviders.filter(function (provider) { return statusFor(provider, snapshot).configured; }).length
        : 0;

      function onSaved(envName, last4) {
        setLast4Session(function (previous) {
          var next = Object.assign({}, previous);
          next[envName] = last4;
          return next;
        });
        reload();
      }

      function onCleared(envName) {
        setLast4Session(function (previous) {
          var next = Object.assign({}, previous);
          delete next[envName];
          return next;
        });
        reload();
      }

      if (view === "summary") {
        return (0, react.createElement)("span", { className: C.summary }, snapshot
          ? format(t("summaryReady"), { configured: configuredCount, total: credentialProviders.length })
          : t("summaryLoading"));
      }

      var normalizedQuery = query.trim().toLowerCase();
      var visibleProviders = credentialProviders.filter(function (provider) {
        var info = statusFor(provider, snapshot);
        if (filter === "configured" && !info.configured) return false;
        if (filter === "missing" && info.configured) return false;
        if (!normalizedQuery) return true;
        return [provider.id, provider.label, provider.env].some(function (value) { return String(value).toLowerCase().includes(normalizedQuery); });
      });

      return (0, react.createElement)(
        "section",
        { className: C.shell, role: "region", "aria-label": t("title") },
        (0, react.createElement)(
          "header",
          { className: C.hero },
          (0, react.createElement)(
            "div",
            { className: C.heroCopy },
            (0, react.createElement)("h3", { className: C.title }, t("title")),
            (0, react.createElement)("p", { className: C.intro }, t("intro"))
          ),
          (0, react.createElement)(
            "div",
            { className: C.score, "aria-label": format(t("summaryReady"), { configured: configuredCount, total: credentialProviders.length }) },
            (0, react.createElement)("strong", null, String(configuredCount)),
            (0, react.createElement)("span", null, "/ " + credentialProviders.length)
          )
        ),
        (0, react.createElement)(
          "div",
          { className: C.tabs, role: "tablist", "aria-label": t("title") },
          [["providers", "providersTab"], ["routing", "routingTab"], ["diagnostics", "diagnosticsTab"]].map(function (entry) {
            return (0, react.createElement)("button", { key: entry[0], type: "button", role: "tab", className: C.tab, "aria-selected": tab === entry[0] ? "true" : "false", onClick: function () { setTab(entry[0]); } }, t(entry[1]));
          })
        ),
        error ? (0, react.createElement)("p", { className: C.warning, role: "alert" }, mapCodeToMessage(t, error.code)) : null,
        !snapshot && !error ? (0, react.createElement)("p", { className: C.intro }, t("loading")) : null,
        snapshot && tab === "providers"
          ? (0, react.createElement)(
              react.Fragment,
              null,
              (0, react.createElement)("p", { className: C.warning, role: "note" }, t("neverChat")),
              (0, react.createElement)(
                "div",
                { className: C.toolbar },
                (0, react.createElement)("input", { className: C.search, type: "search", value: query, placeholder: t("searchPlaceholder"), "aria-label": t("searchPlaceholder"), onChange: function (event) { setQuery(event.target.value || ""); } }),
                (0, react.createElement)(
                  "div",
                  { className: C.filters },
                  [["all", "filterAll"], ["configured", "filterConfigured"], ["missing", "filterMissing"]].map(function (entry) {
                    return (0, react.createElement)("button", { key: entry[0], type: "button", className: C.filter, "aria-pressed": filter === entry[0] ? "true" : "false", onClick: function () { setFilter(entry[0]); } }, t(entry[1]));
                  })
                )
              ),
              (0, react.createElement)(ProviderGroups, { providers: visibleProviders, snapshot: snapshot, expanded: expanded, setExpanded: setExpanded, cred: cred, t: t, last4Session: last4Session, onSaved: onSaved, onCleared: onCleared, onRefresh: reload })
            )
          : null,
        snapshot && tab === "routing" ? (0, react.createElement)(RoutingView, { snapshot: snapshot, t: t }) : null,
        snapshot && tab === "diagnostics" ? (0, react.createElement)(DiagnosticsView, { snapshot: snapshot, t: t, reload: reload }) : null
      );
    }

    function adaptError(error) {
      if (!error) return { ok: false, code: "unknown" };
      return {
        ok: false,
        code: typeof error.code === "string" ? error.code : "unknown",
      };
    }

    function installStyle(ctx) {
      if (typeof document === "undefined") return;
      ctx.effect(function () {
        var existing = document.querySelector("style[data-plugin-css='" + TAG_ID + "']");
        if (existing) return function () {};
        var tag = document.createElement("style");
        tag.dataset.plugin = "dsh-trinity";
        tag.dataset.pluginCss = TAG_ID;
        tag.textContent = css;
        document.head.appendChild(tag);
        return function () { if (tag.parentNode) tag.parentNode.removeChild(tag); };
      });
    }

    function apply(ctx) {
      installStyle(ctx);
      if (ctx.locale && typeof ctx.locale.register === "function") {
        ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); });
      }
      var t = ctx.locale && typeof ctx.locale.bind === "function"
        ? ctx.locale.bind(NS)
        : function (key) { return en[key] != null ? en[key] : key; };

      var raw = ctx.remote && ctx.remote.credentials ? ctx.remote.credentials : null;
      var cred = raw ? {
        describe: function (refs) {
          return raw.describe(refs).then(function (result) {
            return result && result.ok ? { ok: true, value: result.value } : adaptError(result && result.error);
          }).catch(adaptError);
        },
        set: function (ref, value) {
          return raw.set(ref, value).then(function (result) {
            return result && result.ok ? { ok: true } : adaptError(result && result.error);
          }).catch(adaptError);
        },
        unset: function (ref) {
          return raw.unset(ref).then(function (result) {
            return result && result.ok ? { ok: true } : adaptError(result && result.error);
          }).catch(adaptError);
        },
        $on: ctx.remote && typeof ctx.remote.$on === "function" ? ctx.remote.$on.bind(ctx.remote) : null,
      } : { describe: null, set: null, unset: null, $on: null };

      ctx.slots.inject("plugins.row.config", function () {
        return ctx.slots.register({
          name: "plugins.row.config",
          key: "dsh-trinity#web-access-chain",
          locale: NS,
        }, function (props) {
          return (0, react.createElement)(ControlCenter, {
            cred: cred,
            t: props && typeof props.t === "function" ? props.t : t,
            view: props && props.view ? props.view : "page",
          });
        });
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "remote", "remote.credentials"];
    exports.NS = NS;
    return module.exports;
  },
});
