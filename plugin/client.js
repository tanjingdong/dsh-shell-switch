window.__ModuleLoader__.load({
  id: "dsh-shell-switch",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const useState = react.useState;

    const INK = "#f2f2f2";
    const MUTED = "#c9c9c9";
    const SURFACE = "#1f1f1f";
    const EDGE = "#4a4a4a";

    const trigger = {
      background: "transparent", border: "1px solid currentColor", borderRadius: 6,
      color: "inherit", cursor: "pointer", fontSize: 12, padding: "4px 8px",
    };
    const button = {
      background: "transparent", border: `1px solid ${EDGE}`, borderRadius: 6,
      color: INK, cursor: "pointer", fontSize: 12, padding: "4px 8px",
    };
    const panel = {
      background: SURFACE, border: `1px solid ${EDGE}`, borderRadius: 8,
      bottom: 48, boxShadow: "0 8px 24px rgba(0, 0, 0, 0.45)", color: INK,
      display: "flex", flexDirection: "column", gap: 8,
      left: 12, padding: 12, position: "fixed", width: 250, zIndex: 1000,
    };
    const choice = { ...button, textAlign: "left", padding: "8px 10px" };
    const noteStyle = { color: MUTED, fontSize: 12 };

    const DEFAULT_CONFIG = {
      report: { clipboard: true, dialog: true, webhook: false },
      webhook: { url: "", template: '{"text":"DSH 外壳已切换到 {target}：{url}"}' },
      network: {
        addresses: ["192.168.0.106", "10.147.20.214", "100.100.0.3"],
        loopbackOnly: false,
      },
    };
    // Everything on the settings page inherits the host colors: dsh ships a
    // light and a dark theme, so a fixed color is invisible in the other one.
    const pageStyle = {
      color: "inherit", display: "flex", flexDirection: "column", font: "inherit",
      gap: 12, maxWidth: 560, padding: "4px 0",
    };
    const sectionStyle = {
      borderTop: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
      display: "flex", flexDirection: "column", gap: 8, paddingTop: 12,
    };
    const sectionTitleStyle = { fontSize: 13, fontWeight: 600, margin: 0 };
    const checkStyle = { alignItems: "center", display: "flex", fontSize: 13, gap: 8, margin: 0 };
    const fieldStyle = { display: "flex", flexDirection: "column", fontSize: 13, gap: 4 };
    const controlStyle = {
      background: "transparent", borderRadius: 6, boxSizing: "border-box",
      border: "1px solid color-mix(in srgb, currentColor 35%, transparent)",
      color: "inherit", font: "inherit", fontSize: 13, padding: "6px 8px", width: "100%",
    };
    const helpStyle = { fontSize: 12, lineHeight: 1.6, margin: 0, opacity: 0.72 };
    const actionsStyle = { display: "flex", gap: 8, marginTop: 4 };
    // Page-level buttons sit on the host's own surface, so they take the host
    // text color instead of the dark panel's ink.
    const pageButton = { ...trigger, fontSize: 13, padding: "6px 14px" };

    let configCache = null;
    let configLoading = false;

    async function postJson(url, payload) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, body };
    }

    function ConfigForm() {
      const [model, setModel] = useState(configCache || DEFAULT_CONFIG);
      const [notice, setNotice] = useState("");
      const [busy, setBusy] = useState(false);

      if (!configCache && !configLoading) {
        configLoading = true;
        fetch("/dsh-switch/report-config")
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`读取配置失败（${response.status}）`))))
          .then((next) => { configCache = next; setModel(next); })
          .catch((error) => setNotice(String(error && error.message ? error.message : error)))
          .finally(() => { configLoading = false; });
      }

      const setReport = (key, value) => setModel((current) => ({
        ...current, report: { ...current.report, [key]: value },
      }));
      const setWebhook = (key, value) => setModel((current) => ({
        ...current, webhook: { ...current.webhook, [key]: value },
      }));
      const setNetwork = (key, value) => setModel((current) => ({
        ...current, network: { ...(current.network || DEFAULT_CONFIG.network), [key]: value },
      }));
      const network = model.network || DEFAULT_CONFIG.network;

      const save = async () => {
        setBusy(true);
        try {
          const result = await postJson("/dsh-switch/report-config", model);
          if (!result.ok) {
            setNotice((result.body.errors || [`保存失败（${result.status}）`]).join("；"));
          } else {
            configCache = result.body;
            setModel(result.body);
            setNotice("已保存");
          }
        } catch (error) {
          setNotice(String(error && error.message ? error.message : error));
        } finally {
          setBusy(false);
        }
      };

      const sendTest = async () => {
        setBusy(true);
        try {
          const result = await postJson("/dsh-switch/report-test", {});
          setNotice(result.ok
            ? `测试已发送（HTTP ${result.body.status}）`
            : `测试失败：${result.body.error || result.status}`);
        } catch (error) {
          setNotice(String(error && error.message ? error.message : error));
        } finally {
          setBusy(false);
        }
      };

      return h("div", { style: pageStyle },
        h("div", { style: sectionStyle },
          h("p", { style: sectionTitleStyle }, "切换成功后的上报"),
          h("p", { style: helpStyle }, "每个通道独立执行；某个通道失败只写日志，不影响切换本身。"),
          h("label", { style: checkStyle },
            h("input", { type: "checkbox", checked: model.report.clipboard === true, onChange: (e) => setReport("clipboard", e.target.checked) }),
            "复制到剪贴板（带 token 的地址）"),
          h("label", { style: checkStyle },
            h("input", { type: "checkbox", checked: model.report.dialog === true, onChange: (e) => setReport("dialog", e.target.checked) }),
            "弹窗（显示地址，关闭后消失）"),
          h("label", { style: checkStyle },
            h("input", { type: "checkbox", checked: model.report.webhook === true, onChange: (e) => setReport("webhook", e.target.checked) }),
            "发送到网络（POST 一份 JSON，5 秒超时、不重试）")),

        h("div", { style: sectionStyle },
          h("p", { style: sectionTitleStyle }, "网络接口"),
          h("label", { style: fieldStyle }, "API 地址",
            h("input", {
              style: { ...controlStyle, opacity: model.report.webhook === true ? 1 : 0.5 },
              value: model.webhook.url, placeholder: "https://example.com/hook",
              onChange: (e) => setWebhook("url", e.target.value),
            })),
          h("label", { style: fieldStyle }, "JSON 模板",
            h("textarea", {
              style: { ...controlStyle, minHeight: 92, opacity: model.report.webhook === true ? 1 : 0.5 },
              value: model.webhook.template,
              onChange: (e) => setWebhook("template", e.target.value),
            })),
          h("p", { style: helpStyle }, "占位符：{url} 带 token 的完整地址 · {token} 仅 token · {port} 端口 · {target} web 或 client · {time} ISO 时间。未知的 {…} 原样保留，替换后必须仍是合法 JSON。"),
          h("p", { style: helpStyle }, "切到桌面客户端时没有浏览器地址，{url} 与 {token} 是空串；只想要通知就不必在模板里写它们。"),
          h("p", { style: helpStyle }, "{url} 与 {token} 等同于本次登录凭证，网络通道会把它交给该地址——只填你信任的接口。「发送测试」用示例地址真实发送一次。")),

        h("div", { style: sectionStyle },
          h("p", { style: sectionTitleStyle }, "网络发布"),
          h("label", { style: fieldStyle }, "监听网卡",
            h("textarea", {
              style: { ...controlStyle, minHeight: 64, opacity: network.loopbackOnly ? 0.5 : 1 },
              value: (network.addresses || []).join("\n"),
              disabled: network.loopbackOnly,
              onChange: (e) => setNetwork("addresses", e.target.value.split(/[\s,]+/).filter(Boolean)),
            })),
          h("label", { style: checkStyle },
            h("input", { type: "checkbox", checked: network.loopbackOnly === true, onChange: (e) => setNetwork("loopbackOnly", e.target.checked) }),
            "只绑定回环（不启动 relay）"),
          h("p", { style: helpStyle }, "relay 会把网页端口发布到上面列出的每个本机网卡地址（每行一个，或逗号分隔）。地址写错只丢那一个入口，不影响 127.0.0.1。"),
          h("p", { style: helpStyle }, "勾上「只绑定回环」后完全不发布到局域网，只有本机 127.0.0.1 能访问。DSH 不允许监听 0.0.0.0，这里也不接受。")),

        h("div", { style: actionsStyle },
          h("button", { style: pageButton, disabled: busy, onClick: save }, "保存"),
          h("button", { style: pageButton, disabled: busy, onClick: sendTest }, "发送测试")),
        notice !== "" && h("p", { style: { ...helpStyle, fontWeight: 600 } }, notice));
    }

    async function readState() {
      const response = await fetch("/dsh-switch/state");
      if (!response.ok) throw new Error(`状态接口 ${response.status}`);
      return response.json();
    }

    async function requestHandoff(target, nonce) {
      const response = await fetch("/dsh-switch/handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, nonce }),
      });
      if (!response.ok) throw new Error(`切换请求 ${response.status}`);
      return response.json();
    }

    function Panel({ onClose }) {
      const [phase, setPhase] = useState("pick");
      const [pending, setPending] = useState(null);
      const [note, setNote] = useState("");

      const pick = async (target) => {
        setPhase("checking");
        try {
          const state = await readState();
          setPending({ target, nonce: state.nonce });
          setNote(state.known === false
            ? "无法确认是否空闲；若正在跑回合，切换会切断它。"
            : state.busy ? "有回合正在运行，切换会切断它。" : "当前空闲。");
          setPhase(state.busy || state.known === false ? "warn" : "confirm");
        } catch (error) {
          setNote(String(error && error.message ? error.message : error));
          setPhase("error");
        }
      };

      const go = async () => {
        if (!pending) return;
        setPhase("switching");
        try {
          await requestHandoff(pending.target, pending.nonce);
          setNote("正在切换…");
        } catch (error) {
          setNote(String(error && error.message ? error.message : error));
          setPhase("error");
        }
      };

      return h("div", { style: panel, role: "dialog", "aria-label": "切换外壳" },
        h("strong", null, "切换外壳"),
        phase === "pick" && h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
          h("button", { style: choice, onClick: () => pick("client") }, "桌面客户端"),
          h("button", { style: choice, onClick: () => pick("web") }, "浏览器 Web")),
        note !== "" && h("div", { style: noteStyle }, note),
        (phase === "warn" || phase === "confirm") && h("button", { style: choice, onClick: go }, "仍然切换"),
        phase === "error" && h("button", { style: choice, onClick: () => setPhase("pick") }, "重试"),
        phase === "switching" && h("div", { style: { fontSize: 12 } }, "请稍候，窗口即将关闭…"),
        h("button", { style: { ...choice, opacity: 0.7 }, onClick: onClose }, "关闭"));
    }

    function Entry() {
      const [open, setOpen] = useState(false);
      return h("div", null,
        h("button", {
          style: trigger,
          "aria-label": "切换外壳",
          title: "切换外壳",
          disabled: false,
          onClick: () => setOpen((value) => !value),
        }, "⇄"),
        open && h(Panel, { onClose: () => setOpen(false) }));
    }

    const name = "dsh-shell-switch";
    const inject = ["slots"];

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== "function") return;
      const mount = () => ctx.slots.register(
        { name: "sidebar.footer.action", id: "dsh-shell-switch", order: 60 },
        () => h(Entry),
      );
      if (typeof ctx.slots.inject === "function") ctx.slots.inject("sidebar.footer.action", mount);
      else mount();

      // The plugins page shows a 配置 control on a bundle row when this entry
      // names that row; the key is <package>#<row id>.
      const mountRow = () => ctx.slots.register(
        { name: "plugins.row.config", key: "dsh-shell-switch#dsh-shell-switch" },
        ({ view }) => (view === "summary" ? "外壳切换" : h(ConfigForm)),
      );
      if (typeof ctx.slots.inject === "function") ctx.slots.inject("plugins.row.config", mountRow);
      else mountRow();
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
