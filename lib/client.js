window.__ModuleLoader__.load({
  id: "dsh-trinity",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let _deepseek_ai_dsh_client_ui_slots = require("@deepseek-ai/dsh-client-ui-slots");

    // ────────────────────────────────────────────────────────────────────
    // dsh-trinity v2.2.3 — Web UI Provider Key Settings (browser half).
    //
    // Registered slot: `settings.section` (id: "trinity-credentials").
    // The shell (`@deepseek-ai/dsh-client-ui-settings-general`) renders
    // the section inside the modal's content column. Every byte of copy
    // and every interactive control is owned by this plugin; the shell
    // only paints the chrome.
    //
    // Network surface — every interaction goes through DSH's existing
    // `remote.credentials.{describe,set,unset}` namespace. There is no
    // custom Remote namespace, no private HTTP endpoint, and no settings
    // YAML entry for the key.
    //
    // last4 — computed in the browser from the value the user typed the
    // instant they clicked Save. Lives only in component state; dropped
    // on next mount / page reload / context stop. The host never sees
    // the value past the `set` call (the seam's describe() returns
    // configured/source/writable, no value, no last4).
    //
    // Why hand-rolled CJS instead of tsdown:
    //   - The plugin must remain auditable end-to-end. The slice below
    //     is one self-contained file with no build step.
    //   - The UI is intentionally minimal: a provider list, one input
    //     per row, three buttons (Test / Save / Clear). No build chain
    //     is justified by that surface.
    //
    // React.createElement is used directly (no JSX) so the file is
    // syntactically plain JavaScript and grep-friendly.
    // ────────────────────────────────────────────────────────────────────

    // ── Validation + last4 (browser-side only) ─────────────────────────
    // Re-implementing here keeps the bundle self-contained: the same
    // module exists in lib/credentials/web-ui-validation.js for the
    // slash command, but pulling the host module into the browser
    // would either re-bundle or force a chain of fake-exports that
    // defeats the audit. Both copies are tested by the same fixtures.
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
      var lower = trimmed.toLowerCase();
      if (PLACEHOLDER_TOKENS.has(lower)) return null;
      return value.slice(-4);
    }
    function clientValidateKey(value) {
      if (typeof value !== "string") return { ok: false, code: "bad-shape" };
      if (value.length === 0 || value.trim().length === 0) return { ok: false, code: "empty" };
      var lower = value.trim().toLowerCase();
      if (PLACEHOLDER_TOKENS.has(lower)) return { ok: false, code: "placeholder" };
      if (value.length < 8) return { ok: false, code: "too-short" };
      return { ok: true, value: value };
    }

    // ── All providers this plugin can write keys for. Mirrors
    //    lib/config-schema.js#ALL_PROVIDER_IDS; we list every slot 1
    //    env-name here so the UI can render a row per provider without
    //    asking the host (which keeps the cold-start render offline). ──
    var PROVIDERS = [
      { id: "openai", env: "OPENAI_API_KEY" },
      { id: "exa", env: "EXA_API_KEY" },
      { id: "brave", env: "BRAVE_API_KEY" },
      { id: "parallel", env: "PARALLEL_API_KEY" },
      { id: "tinyfish", env: "TINYFISH_API_KEY" },
      { id: "search1api", env: "SEARCH1API_API_KEY" },
      { id: "searchinfinity", env: "SEARCHINFINITY_API_KEY" },
      { id: "querit", env: "QUERIT_API_KEY" },
      { id: "tavily", env: "TAVILY_API_KEY" },
      { id: "firecrawl", env: "FIRECRAWL_KEY" },
      { id: "jina", env: "JINA_API_KEY" },
      { id: "serpdive", env: "SERPDIVE_API_KEY" },
      { id: "kagi", env: "KAGI_API_KEY" },
      { id: "bocha", env: "BOCHA_API_KEY" },
      { id: "ollama", env: "OLLAMA_API_KEY" },
      { id: "perplexity", env: "PERPLEXITY_API_KEY" },
      { id: "gemini", env: "GEMINI_API_KEY" },
      { id: "duckduckgo", env: "DUCKDUCKGO_API_KEY" },
      { id: "anysearch", env: "ANYSEARCH_API_KEY" },
      { id: "xai", env: "XAI_API_KEY" },
      { id: "brightdata", env: "BRIGHTDATA_API_KEY" },
      { id: "serpbase", env: "SERPBASE_API_KEY" },
      { id: "serper", env: "SERPER_API_KEY" },
      { id: "valyu", env: "VALYU_API_KEY" },
      { id: "kimi", env: "KIMI_API_KEY" },
      { id: "parallelMcp", env: "PARALLELMCP_API_KEY" },
      { id: "searxng", env: "SEARXNG_HOST" },
    ];

    // ── CSS (inlined; the shell renders no other styling for our section) ──
    var css =
      ".dshT-card{box-sizing:border-box;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;display:flex;flex-direction:column;gap:14px;padding:6px 4px 4px}" +
      ".dshT-intro{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0}" +
      ".dshT-warning{box-sizing:border-box;background:var(--dsw-alias-bg-warning-soft);color:var(--dsw-alias-label-warning);border-radius:10px;padding:10px 12px;font-size:12px;line-height:18px;margin:0}" +
      ".dshT-list{display:flex;flex-direction:column;gap:10px;list-style:none;padding:0;margin:0}" +
      ".dshT-row{box-sizing:border-box;border:1px solid var(--dsw-alias-border-soft);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1)}" +
      ".dshT-rowHead{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}" +
      ".dshT-rowName{font-weight:500;font-size:14px;line-height:20px;display:flex;align-items:center;gap:8px}" +
      ".dshT-dot{flex:none;width:8px;height:8px;border-radius:50%}" +
      ".dshT-dotSet{background:var(--dsw-alias-success)}" +
      ".dshT-dotUnset{background:var(--dsw-alias-warning)}" +
      ".dshT-rowMeta{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-family:ui-monospace,monospace;display:flex;flex-wrap:wrap;gap:10px}" +
      ".dshT-form{display:flex;flex-direction:column;gap:8px}" +
      ".dshT-input{box-sizing:border-box;width:100%;height:36px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-input);border:1px solid var(--dsw-alias-border-soft);border-radius:8px;font-family:inherit;font-size:14px;line-height:22px;padding:0 10px}" +
      ".dshT-input:focus{outline:2px solid var(--dsw-alias-focus);outline-offset:1px}" +
      ".dshT-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}" +
      ".dshT-btn{cursor:pointer;height:32px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-soft);border-radius:8px;padding:0 12px;font-family:inherit;font-size:13px;line-height:18px;display:inline-flex;align-items:center;gap:6px}" +
      ".dshT-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".dshT-btnPrimary{background:var(--dsw-alias-interactive-bg-primary);color:var(--dsw-alias-label-on-primary);border-color:transparent}" +
      ".dshT-btnDanger{background:var(--dsw-alias-bg-danger-soft);color:var(--dsw-alias-label-danger);border-color:transparent}" +
      ".dshT-btn[disabled]{opacity:.5;cursor:not-allowed}" +
      ".dshT-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
      ".dshT-statusErr{color:var(--dsw-alias-label-danger)}" +
      ".dshT-statusOk{color:var(--dsw-alias-label-success)}" +
      ".dshT-last4{font-family:ui-monospace,monospace;background:var(--dsw-alias-bg-layer-2);padding:1px 6px;border-radius:6px}" +
      ".dshT-confirm{display:flex;flex-direction:column;gap:8px;padding:8px 10px;background:var(--dsw-alias-bg-warning-soft);border-radius:8px;font-size:12px;line-height:18px}";
    var TAG_ID = "dsh-trinity/web-ui-credential-settings.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css='" + TAG_ID + "']") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-trinity";
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    var C = {
      card: "dshT-card",
      intro: "dshT-intro",
      warning: "dshT-warning",
      list: "dshT-list",
      row: "dshT-row",
      rowHead: "dshT-rowHead",
      rowName: "dshT-rowName",
      dot: "dshT-dot",
      dotSet: "dshT-dotSet",
      dotUnset: "dshT-dotUnset",
      rowMeta: "dshT-rowMeta",
      form: "dshT-form",
      input: "dshT-input",
      actions: "dshT-actions",
      btn: "dshT-btn",
      btnPrimary: "dshT-btnPrimary",
      btnDanger: "dshT-btnDanger",
      status: "dshT-status",
      statusErr: "dshT-statusErr",
      statusOk: "dshT-statusOk",
      last4: "dshT-last4",
      confirm: "dshT-confirm",
    };

    // ── Localization (zh + en) ──
    var NS = "settings.trinity-credentials";
    var en = {
      nav: "Provider Keys",
      title: "DSH Trinity Provider Keys",
      intro: "Set or clear the API keys DSH Trinity uses for Exa, AnySearch, Gemini, and the rest of the chain. The full key never leaves the host; only a short trailing fingerprint is echoed locally for this session.",
      warning: "Never paste an API key into the chat box — the chat route copies keys into session logs. Use this settings page instead.",
      envNameLabel: "env",
      sourceLabel: "source",
      writableLabel: "writable",
      dotSetAria: "key configured",
      dotUnsetAria: "no key configured",
      placeholder: "paste API key",
      setBtn: "Save",
      setBusy: "Saving…",
      testBtn: "Test",
      clearBtn: "Clear",
      clearConfirmTitle: "Clear stored key?",
      clearConfirmBody: "The stored key for {provider} will be removed. You can re-enter it later.",
      clearConfirmYes: "Clear key",
      clearConfirmNo: "Cancel",
      okSaved: "Saved (last4: {last4}).",
      okCleared: "Cleared.",
      okTestedConfigured: "Configured (source: {source}; writable: {writable}).",
      okTestedUnset: "Not configured.",
      errGeneric: "Operation failed.",
      errEmpty: "Enter an API key to save.",
      errPlaceholder: "That looks like a placeholder. Paste the real key from your provider.",
      errTooShort: "That key is too short to be real.",
      errUnknownProvider: "Unknown provider.",
      errCredentialsUnavailable: "Credentials service is not mounted on this host.",
    };
    var zh = {
      nav: "Provider 密钥",
      title: "DSH Trinity Provider 密钥",
      intro: "在这里设置或清除 DSH Trinity 使用的 Exa、AnySearch、Gemini 等 Provider 密钥。完整密钥不会离开浏览器所在主机；只在本会话内本地显示末尾四位指纹。",
      warning: "请勿在聊天框粘贴 API 密钥——聊天路径会把密钥写入 session 日志。请改用本设置页。",
      envNameLabel: "环境变量名",
      sourceLabel: "来源",
      writableLabel: "可写",
      dotSetAria: "已配置密钥",
      dotUnsetAria: "未配置密钥",
      placeholder: "粘贴 API 密钥",
      setBtn: "保存",
      setBusy: "保存中…",
      testBtn: "测试",
      clearBtn: "清除",
      clearConfirmTitle: "确认清除？",
      clearConfirmBody: "将移除该 Provider ({provider}) 的已存储密钥，之后可重新填写。",
      clearConfirmYes: "清除密钥",
      clearConfirmNo: "取消",
      okSaved: "已保存（末四位：{last4}）。",
      okCleared: "已清除。",
      okTestedConfigured: "已配置（来源：{source}；可写：{writable}）。",
      okTestedUnset: "未配置。",
      errGeneric: "操作失败。",
      errEmpty: "请输入要保存的 API 密钥。",
      errPlaceholder: "看起来像占位文本，请粘贴 Provider 提供的真实密钥。",
      errTooShort: "密钥长度过短，请检查。",
      errUnknownProvider: "未知 Provider。",
      errCredentialsUnavailable: "本主机未挂载 credentials 服务。",
    };

    // ── helpers ──
    function format(template, vars) {
      if (typeof template !== "string") return "";
      return template.replace(/\{(\w+)\}/g, function (_, k) {
        return vars && vars[k] != null ? String(vars[k]) : "{" + k + "}";
      });
    }
    function mapCodeToMessage(t, code) {
      // Stable codes come from our own validation surface (client-side)
      // or from the DSH credentials seam's wire response. Only the safe
      // subset gets a localised message. Anything else falls back to a
      // generic redacted hint so the wire never echoes a third-party
      // key fragment.
      if (code === "empty") return t("errEmpty");
      if (code === "placeholder") return t("errPlaceholder");
      if (code === "too-short") return t("errTooShort");
      if (code === "credentials/unavailable") return t("errCredentialsUnavailable");
      if (code === "credential/rejected" || code === "credential/not-supported") return t("errGeneric");
      return t("errGeneric");
    }

    // ── ProviderRow ──
    function ProviderRow(props) {
      var provider = props.provider;
      var envName = props.envName;
      var info = props.info; // { configured, source, writable }
      var cred = props.cred; // { describe, set, unset, $on }
      var t = props.t;
      var last4Session = props.last4Session; // string|null — ephemeral fingerprint the user just saved
      var onSaved = props.onSaved;
      var onCleared = props.onCleared;

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

      // Always wipe the draft after submit so the DOM never carries the
      // typed value into the next render. last4 lives only in the parent
      // component's ephemeral session state, never here.
      function clearDraft() { setDraft(""); }

      async function callRemote(action) {
        setBusy(true);
        setStatus(null);
        try {
          var result = await action();
          return result;
        } finally {
          setBusy(false);
        }
      }

      async function onSubmit(ev) {
        ev.preventDefault();
        if (busy) return;
        var validation = clientValidateKey(draft);
        if (!validation.ok) {
          setStatus({ kind: "err", message: mapCodeToMessage(t, validation.code) });
          return;
        }
        // Capture the draft + computed last4 BEFORE clearing the input,
        // then submit through the real DSH credentials seam.
        var submitValue = draft;
        var ephemeralLast4 = clientLast4(submitValue);
        clearDraft();
        var res = await callRemote(function () { return cred.set(envName, submitValue); });
        if (res && res.ok) {
          // Tell the parent so the rest of the section can show the
          // fingerprint for this session only.
          if (typeof onSaved === "function") onSaved(envName, ephemeralLast4);
          setStatus({ kind: "ok", message: format(t("okSaved"), { last4: ephemeralLast4 || "****" }) });
        } else {
          var code = res && res.code ? res.code : "unknown";
          setStatus({ kind: "err", message: mapCodeToMessage(t, code) });
        }
      }

      async function onTest() {
        if (busy) return;
        var res = await callRemote(function () { return cred.describe([envName]); });
        if (res && res.ok) {
          var entry = (res.value && res.value[envName]) || res[envName];
          if (entry && entry.configured) {
            setStatus({ kind: "ok", message: format(t("okTestedConfigured"), { source: entry.source || "?", writable: String(entry.writable) }) });
          } else {
            setStatus({ kind: "ok", message: t("okTestedUnset") });
          }
        } else {
          setStatus({ kind: "err", message: mapCodeToMessage(t, res && res.code) });
        }
      }

      async function onClearConfirmed() {
        if (busy) return;
        setConfirming(false);
        var res = await callRemote(function () { return cred.unset(envName); });
        if (res && res.ok) {
          if (typeof onCleared === "function") onCleared(envName);
          setStatus({ kind: "ok", message: t("okCleared") });
        } else {
          setStatus({ kind: "err", message: mapCodeToMessage(t, res && res.code) });
        }
      }

      function onClear() {
        if (busy) return;
        if (!configured) {
          setStatus({ kind: "ok", message: t("okTestedUnset") });
          return;
        }
        setConfirming(true);
      }

      return (0, react.createElement)(
        "li",
        { className: C.row, "data-provider": provider },
        (0, react.createElement)(
          "div",
          { className: C.rowHead },
          (0, react.createElement)(
            "div",
            { className: C.rowName },
            configured
              ? (0, react.createElement)("span", { className: C.dot + " " + C.dotSet, role: "img", "aria-label": t("dotSetAria"), title: t("dotSetAria") })
              : (0, react.createElement)("span", { className: C.dot + " " + C.dotUnset, role: "img", "aria-label": t("dotUnsetAria"), title: t("dotUnsetAria") }),
            provider
          ),
          (0, react.createElement)(
            "div",
            { className: C.rowMeta },
            (0, react.createElement)("span", null, t("envNameLabel") + ": ", (0, react.createElement)("code", null, envName)),
            configured ? (0, react.createElement)("span", null, t("sourceLabel") + ": ", info && info.source ? info.source : "?") : null,
            configured ? (0, react.createElement)("span", null, t("writableLabel") + ": ", String(info && typeof info.writable === "boolean" ? info.writable : false)) : null,
            // Ephemeral fingerprint — only present if THIS session
            // saved a key for this exact env; cleared on remount.
            last4Session ? (0, react.createElement)("span", null, "last4: ", (0, react.createElement)("span", { className: C.last4 }, "***" + last4Session)) : null
          )
        ),
        (0, react.createElement)(
          "form",
          { className: C.form, onSubmit: onSubmit, autoComplete: "off" },
          (0, react.createElement)(
            "label",
            { htmlFor: "dsht-input-" + provider, style: { display: "none" } },
            provider + " " + t("placeholder")
          ),
          (0, react.createElement)("input", {
            id: "dsht-input-" + provider,
            className: C.input,
            type: "password",
            inputMode: "text",
            autoComplete: "off",
            autoCorrect: "off",
            autoCapitalize: "off",
            spellCheck: false,
            placeholder: t("placeholder"),
            value: draft,
            disabled: busy,
            onChange: function (ev) { setDraft(typeof ev.target.value === "string" ? ev.target.value : ""); },
          }),
          (0, react.createElement)(
            "div",
            { className: C.actions },
            (0, react.createElement)(
              "button",
              { type: "submit", className: C.btn + " " + C.btnPrimary, disabled: busy, "aria-label": t("setBtn") + " " + provider },
              busy ? t("setBusy") : t("setBtn")
            ),
            (0, react.createElement)(
              "button",
              { type: "button", className: C.btn, disabled: busy, onClick: onTest, "aria-label": t("testBtn") + " " + provider },
              t("testBtn")
            ),
            (0, react.createElement)(
              "button",
              { type: "button", className: C.btn + " " + C.btnDanger, disabled: busy, onClick: onClear, "aria-label": t("clearBtn") + " " + provider },
              t("clearBtn")
            )
          ),
          confirming
            ? (0, react.createElement)(
                "div",
                { className: C.confirm, role: "alertdialog", "aria-label": t("clearConfirmTitle") },
                (0, react.createElement)("div", null, t("clearConfirmTitle")),
                (0, react.createElement)("div", null, format(t("clearConfirmBody"), { provider: provider })),
                (0, react.createElement)(
                  "div",
                  { className: C.actions },
                  (0, react.createElement)(
                    "button",
                    { type: "button", className: C.btn + " " + C.btnDanger, disabled: busy, onClick: onClearConfirmed, autoFocus: true },
                    t("clearConfirmYes")
                  ),
                  (0, react.createElement)(
                    "button",
                    { type: "button", className: C.btn, disabled: busy, onClick: function () { setConfirming(false); } },
                    t("clearConfirmNo")
                  )
                )
              )
            : null,
          status
            ? (0, react.createElement)(
                "div",
                {
                  className: C.status + " " + (status.kind === "ok" ? C.statusOk : C.statusErr),
                  role: status.kind === "err" ? "alert" : "status",
                },
                status.message
              )
            : null
        )
      );
    }

    // ── SectionRoot ──
    function SectionRoot(props) {
      var cred = props.cred;
      var t = props.t;
      var _useState5 = (0, react.useState)(null);
      var snapshot = _useState5[0];
      var setSnapshot = _useState5[1];
      var _useState6 = (0, react.useState)(null);
      var error = _useState6[0];
      var setError = _useState6[1];
      // Ephemeral per-provider last4 map. Lives only in component
      // state. Cleared on unmount, page reload, or context stop.
      var _useState7 = (0, react.useState)({});
      var last4Session = _useState7[0];
      var setLast4Session = _useState7[1];

      async function reload() {
        if (!cred || typeof cred.describe !== "function") {
          setError({ code: "credentials/unavailable" });
          return;
        }
        var refs = PROVIDERS.map(function (p) { return p.env; });
        try {
          var res = await cred.describe(refs);
          // Adapter returns either the raw { <ref>: CredentialInfo } map
          // on success or { ok: false, code, message } on failure.
          if (!res || res.ok === false) {
            setError({ code: (res && res.code) || "unknown" });
            return;
          }
          var map = (res && res.value) ? res.value : res;
          var info = {};
          for (var i = 0; i < PROVIDERS.length; i++) {
            var p = PROVIDERS[i];
            var entry = map[p.env];
            info[p.id] = {
              envName: p.env,
              configured: !!(entry && entry.configured),
              source: entry && entry.source ? entry.source : null,
              writable: entry && typeof entry.writable === "boolean" ? entry.writable : null,
            };
          }
          setSnapshot(info);
          setError(null);
        } catch (e) {
          setError({ code: "exception" });
        }
      }

      (0, react.useEffect)(function () { reload(); }, []);

      // Re-render when the host invalidates a credential reference.
      (0, react.useEffect)(function () {
        if (!cred || typeof cred.$on !== "function") return;
        var off = cred.$on("credentials/reference-updated", function () { reload(); });
        return typeof off === "function" ? off : function () {};
      }, []);

      // Stable order: configured first (sorted), then unset (sorted).
      var rows = (0, react.useMemo)(function () {
        if (!snapshot) return [];
        var ids = Object.keys(snapshot);
        var configuredIds = ids.filter(function (id) { return snapshot[id].configured; }).sort();
        var unsetIds = ids.filter(function (id) { return !snapshot[id].configured; }).sort();
        var ordered = configuredIds.concat(unsetIds);
        return ordered.map(function (id) {
          return { provider: id, info: snapshot[id], last4: last4Session[snapshot[id].envName] || null };
        });
      }, [snapshot, last4Session]);

      function onSaved(envName, last4) {
        setLast4Session(function (prev) {
          var next = {};
          for (var k in prev) next[k] = prev[k];
          next[envName] = last4;
          return next;
        });
        reload();
      }
      function onCleared(envName) {
        setLast4Session(function (prev) {
          var next = {};
          for (var k in prev) if (k !== envName) next[k] = prev[k];
          return next;
        });
        reload();
      }

      if (error) {
        return (0, react.createElement)(
          "section",
          { className: C.card, role: "region", "aria-label": t("title") },
          (0, react.createElement)("h3", null, t("title")),
          (0, react.createElement)("p", { className: C.warning, role: "alert" }, mapCodeToMessage(t, error.code))
        );
      }
      if (!snapshot) {
        return (0, react.createElement)(
          "section",
          { className: C.card, role: "region", "aria-label": t("title") },
          (0, react.createElement)("h3", null, t("title")),
          (0, react.createElement)("p", { className: C.intro }, t("intro"))
        );
      }
      return (0, react.createElement)(
        "section",
        { className: C.card, role: "region", "aria-label": t("title") },
        (0, react.createElement)("h3", null, t("title")),
        (0, react.createElement)("p", { className: C.intro }, t("intro")),
        (0, react.createElement)("p", { className: C.warning, role: "note" }, t("warning")),
        (0, react.createElement)(
          "ul",
          { className: C.list },
          rows.map(function (row) {
            return (0, react.createElement)(ProviderRow, {
              key: row.provider,
              provider: row.provider,
              envName: row.info.envName,
              info: row.info,
              cred: cred,
              t: t,
              last4Session: row.last4,
              onSaved: onSaved,
              onCleared: onCleared,
            });
          })
        )
      );
    }

    // ── Adapt ctx.remote.credentials to the surface our React tree
    // expects: { ok, value, code, ... } envelopes for set/unset and the
    // raw `{ <ref>: CredentialInfo }` map for describe. We NEVER log the
    // value or last4 anywhere in the adapter; any third-party message is
    // already redacted by the host-side controllers controller, but we
    // also belt-and-braces here. ──
    function adaptError(e) {
      if (!e) return { ok: false, code: "unknown", message: "" };
      return {
        ok: false,
        code: typeof e.code === "string" ? e.code : "unknown",
        message: typeof e.message === "string" ? e.message : "",
      };
    }
    function adaptOk() { return { ok: true }; }

    // ── apply() ──
    function apply(ctx) {
      if (ctx.locale && typeof ctx.locale.register === "function") {
        ctx.locale.register(NS, { zh: zh, en: en });
      }
      var t = (ctx.locale && typeof ctx.locale.bind === "function")
        ? ctx.locale.bind(NS)
        : function (k) { return en[k] != null ? en[k] : k; };

      var raw = ctx.remote && ctx.remote.credentials ? ctx.remote.credentials : null;
      if (!raw) {
        // Without `remote.credentials` mounted, there is nothing this
        // plugin can do — render a friendly section instead of failing
        // the boot.
        var injected = function () { return { cred: { describe: null, set: null, unset: null }, t: t }; };
        ctx.slots.inject("settings.section", function () {
          ctx.slots.register({
            name: "settings.section",
            id: "trinity-credentials",
            order: 25,
            label: function () { return t("nav"); },
            inject: injected,
          }, function () {
            return (0, react.createElement)(
              "section",
              { className: C.card, role: "region", "aria-label": t("title") },
              (0, react.createElement)("h3", null, t("title")),
              (0, react.createElement)("p", { className: C.warning, role: "alert" }, t("errCredentialsUnavailable"))
            );
          });
        });
        return;
      }

      var cred = {
        describe: function (refs) {
          return raw.describe(refs).then(function (r) {
            if (r && r.ok) return { ok: true, value: r.value };
            return adaptError(r && r.error);
          }).catch(adaptError);
        },
        set: function (ref, value) {
          return raw.set(ref, value).then(function (r) {
            if (r && r.ok) return { ok: true };
            return adaptError(r && r.error);
          }).catch(adaptError);
        },
        unset: function (ref) {
          return raw.unset(ref).then(function (r) {
            if (r && r.ok) return { ok: true };
            return adaptError(r && r.error);
          }).catch(adaptError);
        },
        $on: ctx.remote && typeof ctx.remote.$on === "function" ? ctx.remote.$on.bind(ctx.remote) : null,
      };

      var injected = function () { return { cred: cred, t: t }; };

      ctx.slots.inject("settings.section", function () {
        ctx.slots.register({
          name: "settings.section",
          id: "trinity-credentials",
          order: 25,
          label: function () { return t("nav"); },
          inject: injected,
        }, function (props) {
          var c = (props && props.cred) || cred;
          var tFn = (props && props.t) || t;
          return (0, react.createElement)(SectionRoot, { cred: c, t: tFn });
        });
      });
    }

    var requiredInject = [
      "slots",
      "locale",
      "remote",
      "remote.credentials",
    ];

    exports.apply = apply;
    exports.inject = requiredInject;
    exports.NS = NS;
    return module.exports;
  },
});