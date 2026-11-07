window.__ModuleLoader__.load({
  id: "dsh-shell-switch",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const useState = react.useState;

    const button = {
      background: "transparent", border: "1px solid currentColor", borderRadius: 6,
      color: "inherit", cursor: "pointer", fontSize: 12, padding: "4px 8px",
    };
    const panel = {
      background: "var(--dsh-surface, #1f1f1f)", border: "1px solid #444", borderRadius: 8,
      bottom: 48, color: "inherit", display: "flex", flexDirection: "column", gap: 8,
      left: 12, padding: 12, position: "fixed", width: 250, zIndex: 1000,
    };
    const choice = { ...button, textAlign: "left", padding: "8px 10px" };

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
        note !== "" && h("div", { style: { fontSize: 12, opacity: 0.9 } }, note),
        (phase === "warn" || phase === "confirm") && h("button", { style: choice, onClick: go }, "仍然切换"),
        phase === "error" && h("button", { style: choice, onClick: () => setPhase("pick") }, "重试"),
        phase === "switching" && h("div", { style: { fontSize: 12 } }, "请稍候，窗口即将关闭…"),
        h("button", { style: { ...choice, opacity: 0.7 }, onClick: onClose }, "关闭"));
    }

    function Entry() {
      const [open, setOpen] = useState(false);
      return h("div", null,
        h("button", {
          style: button,
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
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
