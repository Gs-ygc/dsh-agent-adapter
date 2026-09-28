window.__ModuleLoader__.load({
	id: "dsh-agent-adapter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		"use strict";
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __export = (target, all) => {
		  for (var name2 in all)
		    __defProp(target, name2, { get: all[name2], enumerable: true });
		};
		var __copyProps = (to, from, except, desc) => {
		  if (from && typeof from === "object" || typeof from === "function") {
		    for (let key of __getOwnPropNames(from))
		      if (!__hasOwnProp.call(to, key) && key !== except)
		        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
		  }
		  return to;
		};
		var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

		// src/client-ui.tsx
		var client_ui_exports = {};
		__export(client_ui_exports, {
		  apply: () => apply,
		  default: () => client_ui_default,
		  inject: () => inject,
		  name: () => name
		});
		module.exports = __toCommonJS(client_ui_exports);
		var import_react = require("react");
		var import_jsx_runtime = require("react/jsx-runtime");
		var name = "agent-adapter-client";
		var inject = [
		  "slots",
		  "locale",
		  "connection",
		  "remote"
		];
		var NS = "agent-adapter";
		var STATE_URL = "/plugins/dsh-agent-adapter/state.json";
		var zh = {
		  nav: "Agent 适配",
		  title: "Agent 适配",
		  intro: "扫描本机已安装的 agent 服务（codex、opencode、kimi、pi 等），检测到的默认启用。只有启用的服务才会出现在模型选择器中。",
		  installed: "已安装",
		  missing: "未检测到",
		  enabled: "已启用",
		  disabled: "已停用",
		  configured: "自定义配置",
		  customs: (n) => `另有 ${n} 个手动配置的 provider（settings.yaml 的 agent-adapter.codex.providers / agent-adapter.acp.providers），始终启用。`,
		  loading: "正在扫描本机 agent 服务…",
		  loadFailed: "扫描状态读取失败",
		  retry: "重试"
		};
		var en = {
		  nav: "Agent Adapter",
		  title: "Agent Adapter",
		  intro: "Locally installed agent adapters (codex, opencode, kimi, pi, …) are detected and enabled by default. Only enabled agents appear in the model picker.",
		  installed: "Installed",
		  missing: "Not detected",
		  enabled: "Enabled",
		  disabled: "Disabled",
		  configured: "Custom config",
		  customs: (n) => `${n} manually configured provider(s) in settings.yaml (agent-adapter.codex.providers / agent-adapter.acp.providers) are always enabled.`,
		  loading: "Scanning for local agents…",
		  loadFailed: "Failed to read the scan state",
		  retry: "Retry"
		};
		function AcpSection(props) {
		  const { api, subscribeDoc, t } = props;
		  const [state, setState] = (0, import_react.useState)(void 0);
		  const [failed, setFailed] = (0, import_react.useState)(false);
		  const [busy, setBusy] = (0, import_react.useState)(void 0);
		  const refresh = (0, import_react.useCallback)(async () => {
		    try {
		      const res = await fetch(STATE_URL, { cache: "no-store" });
		      if (!res.ok) throw new Error(`HTTP ${res.status}`);
		      setState(await res.json());
		      setFailed(false);
		    } catch {
		      setFailed(true);
		    }
		  }, []);
		  (0, import_react.useEffect)(() => {
		    void refresh();
		    return subscribeDoc?.(() => void refresh());
		  }, [refresh, subscribeDoc]);
		  const toggle = async (row) => {
		    if (!api || busy) return;
		    setBusy(row.id);
		    try {
		      const next = !row.enabled;
		      const response = await api.settings.mutate({
		        ns: row.ns ?? "agent-adapter",
		        ops: [{ op: "set", path: row.switchPath ?? ["acp", "agents", row.id, "enabled"], value: next }]
		      });
		      if (!response.result.ok) throw new Error(response.result.error?.message ?? "mutate failed");
		      setState((prev) => prev && { ...prev, agents: prev.agents.map((a) => a.id === row.id ? { ...a, enabled: next } : a) });
		    } catch {
		      void refresh();
		    } finally {
		      setBusy(void 0);
		    }
		  };
		  if (failed) return (0, import_jsx_runtime.jsxs)("section", { className: "dshAcp_section", children: [
		    (0, import_jsx_runtime.jsx)("h2", { className: "dshAcp_title", children: t("title") }),
		    (0, import_jsx_runtime.jsxs)("p", { className: "dshAcp_error", children: [t("loadFailed"), " ", (0, import_jsx_runtime.jsx)("button", { className: "dshAcp_link", onClick: () => void refresh(), children: t("retry") })] })
		  ] });
		  if (!state) return (0, import_jsx_runtime.jsxs)("section", { className: "dshAcp_section", children: [
		    (0, import_jsx_runtime.jsx)("h2", { className: "dshAcp_title", children: t("title") }),
		    (0, import_jsx_runtime.jsx)("p", { className: "dshAcp_intro", children: t("loading") })
		  ] });
		  return (0, import_jsx_runtime.jsxs)("section", { className: "dshAcp_section", children: [
		    (0, import_jsx_runtime.jsx)("h2", { className: "dshAcp_title", children: t("title") }),
		    (0, import_jsx_runtime.jsx)("p", { className: "dshAcp_intro", children: t("intro") }),
		    (0, import_jsx_runtime.jsx)("ul", { className: "dshAcp_rows", children: state.agents.map((row) => {
		      const usable = row.detected || row.configured;
		      return (0, import_jsx_runtime.jsxs)("li", { className: "dshAcp_row", children: [
		        (0, import_jsx_runtime.jsxs)("div", { className: "dshAcp_rowMain", children: [
		          (0, import_jsx_runtime.jsxs)("div", { className: "dshAcp_rowHead", children: [
		            (0, import_jsx_runtime.jsx)("span", { className: "dshAcp_rowName", children: row.name }),
		            (0, import_jsx_runtime.jsx)("span", { className: `dshAcp_dot ${usable ? "dshAcp_dotOn" : "dshAcp_dotOff"}` }),
		            (0, import_jsx_runtime.jsx)("span", { className: "dshAcp_rowTag", children: usable ? t("installed") + (row.version ? ` · ${row.version}` : "") : t("missing") }),
		            row.configured && (0, import_jsx_runtime.jsx)("span", { className: "dshAcp_rowTag", children: t("configured") })
		          ] }),
		          (0, import_jsx_runtime.jsx)("code", { className: "dshAcp_command", children: row.command })
		        ] }),
		        (0, import_jsx_runtime.jsx)("button", {
		          className: `dshAcp_switch ${row.enabled ? "dshAcp_switchOn" : ""}`,
		          role: "switch",
		          "aria-checked": row.enabled,
		          disabled: !usable || busy === row.id,
		          title: row.enabled ? t("enabled") : t("disabled"),
		          onClick: () => void toggle(row),
		          children: (0, import_jsx_runtime.jsx)("span", { className: "dshAcp_knob" })
		        })
		      ] }, row.id);
		    }) }),
		    state.customs.length > 0 && (0, import_jsx_runtime.jsx)("p", { className: "dshAcp_intro", children: t("customs", state.customs.length) })
		  ] });
		}
		var CSS = `
		.dshAcp_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
		.dshAcp_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
		.dshAcp_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}
		.dshAcp_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}
		.dshAcp_link{color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;font:inherit;text-decoration:underline;padding:0}
		.dshAcp_rows{flex-direction:column;gap:8px;margin:4px 0 0;padding:0;list-style:none;display:flex}
		.dshAcp_row{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;align-items:center;gap:12px;padding:12px 14px;display:flex}
		.dshAcp_rowMain{flex-direction:column;gap:4px;min-width:0;flex:1;display:flex}
		.dshAcp_rowHead{align-items:center;gap:8px;display:flex}
		.dshAcp_rowName{font-size:14px;font-weight:500;line-height:22px}
		.dshAcp_dot{box-sizing:border-box;border-radius:50%;flex:none;width:8px;height:8px;display:inline-block}
		.dshAcp_dotOn{background:var(--dsw-alias-state-success-primary)}
		.dshAcp_dotOff{background:var(--dsw-alias-label-dimmed)}
		.dshAcp_rowTag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px}
		.dshAcp_command{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,monospace);font-size:12px;overflow-wrap:anywhere}
		.dshAcp_switch{box-sizing:border-box;width:36px;height:20px;flex:none;cursor:pointer;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1);position:relative;padding:0;transition:background .15s}
		.dshAcp_switchOn{background:var(--dsw-alias-button-primary-fill);border-color:transparent}
		.dshAcp_switch:disabled{opacity:.4;cursor:default}
		.dshAcp_knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:left .15s}
		.dshAcp_switchOn .dshAcp_knob{left:18px;background:var(--dsw-alias-label-primary-foreground,#fff)}
		`;
		function apply(ctx) {
		  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "agent-adapter: copy dictionaries");
		  const t = ctx.locale.bind(NS);
		  const style = document.createElement("style");
		  style.textContent = CSS;
		  document.head.appendChild(style);
		  ctx.effect(() => () => style.remove());
		  const remote = ctx.get("remote");
		  const injected = () => ({
		    api: ctx.get("connection")?.api,
		    subscribeDoc: remote ? (cb) => remote.$on("settings/document-updated", cb) : void 0,
		    t
		  });
		  ctx.slots.inject("settings.section", () => ctx.slots.register({
		    name: "settings.section",
		    id: "acp",
		    order: 30,
		    label: () => t("nav"),
		    inject: injected
		  }, AcpSection));
		}
		var client_ui_default = { name, inject, apply };

		return module.exports;
	}
});
