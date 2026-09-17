/**
 * dsh-codex-auth — 浏览器半边（设置卡片）。
 *
 * 本文件即源码，也是构建输入：load 调用的模块工厂，由 build.mjs 原样拷到 lib/client.js。
 * 两处 UI（共用 CodexAuthPanel 组件）：
 *  1. 插件配置卡（settings.plugin.item，id dsh-codex-auth）：设置 → 插件 → 插件配置里的常驻卡。
 *  2. 设置分区（settings.section，id codex-auth，order 27）：设置侧栏导航入口，
 *     紧贴归档清理（order 26），整页展示同一套登录面板。
 *     两处实例各有一份独立轮询/输入状态，互不干扰。
 *   状态查询 / Device 码登录 / 浏览器登录（+手工粘回授权码）/ 取消 / 退出登录，
 *   外加 openai-codex 路由一键启用（经 ctx.remote.settings.mutate 写 llm-pi-ai）。
 *
 * 与官方 Models 页的关系：官方页明确不支持 OAuth 提供方，本卡不改官方页，
 * 只负责把底层已存在的登录流跑通；跑通后仍需启用路由并在新会话里选模型。
 *
 * 无外部依赖：只用 React + fetch + ctx.remote.settings（路由一键启用时才用）。
 */
window.__ModuleLoader__.load({
  id: "dsh-codex-auth",
  factory: function (require) {
    var React = require("react");

    var NS = "dsh-codex-auth";
    var POLL_MS = 900;

    var TEXT = {
      title: "Codex 账号登录（ChatGPT）",
      nav: "Codex 登录",
      subLong: "用 ChatGPT Plus / Pro 订阅登录 OpenAI Codex 路由，无需 API Key。登录成功后启用下方路由，即可在新会话里选模型。",
      description: "用 ChatGPT Plus / Pro 订阅登录 OpenAI Codex 路由，无需 API Key。底层即 dsh-llm-pi-ai 自带的 openai-codex OAuth，本卡只把它暴露出来。",
      statusLabel: "登录状态",
      loading: "正在读取登录状态…",
      statusError: "状态读取失败，请刷新后重试。",
      retry: "重试",
      refresh: "刷新",
      loggedIn: "已登录",
      loggedOut: "未登录",
      loggingIn: "登录中…",
      loginFailed: "上次尝试未成功",
      flowMissing: "底层没有 openai-codex 登录流（dsh-llm-pi-ai 未挂载或版本过旧），本卡不可用。",
      loginSection: "登录方式",
      waiting: "正在等待底层登录流程下发指引…",
      cancelledDone: "已取消，可重新发起登录。",
      deviceLogin: "Device 码登录",
      deviceHint: "推荐：给出一串用户码，去 ChatGPT 页面输完即登，无需在本机开回调端口。",
      browserLogin: "浏览器登录",
      browserHint: "备选：在浏览器完成 OpenAI 登录后，把回调 URL 粘回本卡（服务器在远端时只能用这招）。",
      cancel: "取消本次登录",
      signout: "退出登录",
      signoutArm: "再次点击确认退出",
      signoutHint: "仅删除本机存的授权记录（官方语义：不通知发行方撤销），订阅本身不受影响。",
      answerPh: "粘贴授权码 / 回调 URL",
      answerBtn: "提交",
      answering: "提交中…",
      openUrl: "在浏览器打开",
      copy: "复制",
      copied: "已复制",
      routeTitle: "模型路由",
      routeUnknown: "未知（点“检查路由”）",
      routePresent: "openai-codex 路由已启用",
      routeAbsent: "openai-codex 路由未启用（登录成功后也选不到模型）",
      checkRoute: "检查路由",
      ensureRoute: "一键启用路由",
      ensuring: "启用中…",
      routeOk: "路由已启用，去“模型”页或新会话的模型选择器里选 openai-codex 的模型即可。",
      routeFail: "路由启用失败：{err}",
      manualTitle: "手动启用（备用）：在 $DSH_HOME/settings.yaml 加",
      manualYaml: "llm-pi-ai:\n  providers:\n    openai-codex: {}",
      hintsTitle: "说明",
      hints: [
        "登录中途刷新/重载页面，本次尝试即作废（官方限制：attempt 只活在发起它的进程里），需重新点登录。",
        "在浏览器完成 OpenAI 登录后，把跳到的回调地址整个粘回输入框提交即可。",
        "登录成功只代表“本机有可用的订阅授权”；模型是否可选，还要看上面的路由是否启用。",
        "需要 ChatGPT Plus / Pro 这类含 Codex 的订阅；普通免费号登上也可能无可用模型。",
      ],
    };

    function post(path, body) {
      return fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json(); });
    }

    function copyText(t, done) {
      function fallback() {
        try {
          var ta = document.createElement("textarea");
          ta.value = t;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          done(true);
        } catch (e) { done(false); }
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(t).then(function () { done(true); }, fallback);
        } else fallback();
      } catch (e) { fallback(); }
    }

    // ---------- 内联样式（与官方卡片同设计语言） ----------
    var cardStyle = {
      listStyle: "none",
      border: "0.5px solid var(--dsw-alias-border-l4)",
      borderRadius: "16px",
      background: "var(--dsw-alias-bg-layer-3)",
    };
    var headerStyle = { padding: "14px 16px 0 16px" };
    var titleStyle = { fontSize: "15px", fontWeight: 600, lineHeight: 1.4, color: "var(--dsw-alias-label-primary)" };
    var descStyle = { fontSize: "13px", lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)", marginTop: "4px" };
    var bodyStyle = { borderTop: "0.5px solid var(--dsw-alias-border-l2)", margin: "12px 16px 0 16px", padding: "12px 0 16px 0", display: "flex", flexDirection: "column", gap: "12px" };
    var rowStyle = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-primary)" };
    // 分区：标题 + 内容纵向堆叠，分区间用细分割线隔开。
    var sectionStyle = { display: "flex", flexDirection: "column", gap: "8px" };
    var sectionTitleStyle = { fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary)" };
    var dividerStyle = { borderTop: "0.5px solid var(--dsw-alias-border-l2)" };
    var hintStyle = { fontSize: "12px", lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)" };
    var errStyle = { fontSize: "12px", lineHeight: 1.5, color: "var(--dsw-alias-label-error, #e5484d)" };
    var okStyle = { fontSize: "12px", lineHeight: 1.5, color: "var(--dsw-alias-label-secondary)" };
    var metaStyle = { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" };
    var btnBase = {
      appearance: "none", border: "1px solid var(--dsw-alias-border-l2)",
      background: "transparent", color: "var(--dsw-alias-label-secondary)",
      borderRadius: "6px", padding: "4px 12px", fontSize: "12px",
      cursor: "pointer", fontFamily: "inherit", flex: "none",
    };
    var btnPrimary = {
      appearance: "none", border: "1px solid var(--dsw-alias-border-l2)",
      background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)",
      borderRadius: "6px", padding: "4px 12px", fontSize: "12px",
      cursor: "pointer", fontFamily: "inherit", flex: "none", fontWeight: 600,
    };
    var btnDanger = {
      appearance: "none", border: "1px solid var(--dsw-alias-label-error, #e5484d)",
      background: "transparent", color: "var(--dsw-alias-label-error, #e5484d)",
      borderRadius: "6px", padding: "4px 12px", fontSize: "12px", fontWeight: 600,
      cursor: "pointer", fontFamily: "inherit", flex: "none",
    };
    // 状态横幅：底色随登录态走，里面放状态字 + 提供方 pill + 右侧刷新。
    var bannerColors = {
      in: { bg: "color-mix(in srgb, #30d158 10%, transparent)", bd: "color-mix(in srgb, #30d158 45%, transparent)" },
      ing: { bg: "color-mix(in srgb, #ffd60a 10%, transparent)", bd: "color-mix(in srgb, #ffd60a 45%, transparent)" },
      fail: { bg: "color-mix(in srgb, #ff453a 8%, transparent)", bd: "color-mix(in srgb, #ff453a 45%, transparent)" },
      out: { bg: "var(--dsw-alias-bg-layer-2)", bd: "var(--dsw-alias-border-l4)" },
    };
    function bannerStyle(state) {
      var c = bannerColors[state] || bannerColors.out;
      return {
        background: c.bg, border: "0.5px solid " + c.bd, borderRadius: "10px",
        padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px",
      };
    }
    var statusTextStyle = { fontSize: "14px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
    var pillStyle = {
      flex: "none", display: "inline-flex", alignItems: "center", gap: "6px",
      fontSize: "11px", lineHeight: "20px", padding: "0 10px", borderRadius: "999px",
      border: "0.5px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)",
      background: "var(--dsw-alias-bg-layer-3)",
    };
    var noticeStyle = {
      fontSize: "13px", lineHeight: 1.6, color: "var(--dsw-alias-label-primary)",
      background: "var(--dsw-alias-bg-layer-2)", border: "0.5px solid var(--dsw-alias-border-l4)",
      borderRadius: "10px", padding: "10px 14px", display: "flex", flexDirection: "column", gap: "6px",
    };
    var codeStyle = {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "16px", fontWeight: 700,
      letterSpacing: "2px", color: "var(--dsw-alias-label-primary)",
      background: "var(--dsw-alias-bg-layer-3)", border: "0.5px solid var(--dsw-alias-border-l2)",
      borderRadius: "8px", padding: "6px 12px",
    };
    var inputStyle = {
      flex: "1", minWidth: "180px", font: "inherit", fontSize: "13px",
      color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-3)",
      border: "0.5px solid var(--dsw-alias-border-l4)", borderRadius: "8px", padding: "8px 12px",
    };
    var preStyle = {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px", lineHeight: 1.6,
      color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-2)",
      border: "0.5px solid var(--dsw-alias-border-l4)", borderRadius: "8px", padding: "10px 12px",
      whiteSpace: "pre", overflowX: "auto", margin: 0,
    };

    function dotStyle(color) {
      return { width: "8px", height: "8px", borderRadius: "999px", background: color, flex: "none", display: "inline-block" };
    }

    function StatusDot(props) {
      var color = "#8e8e93";
      if (props.state === "in") color = "#30d158";
      else if (props.state === "ing") color = "#ffd60a";
      else if (props.state === "fail") color = "#ff453a";
      return React.createElement("span", { style: dotStyle(color), "aria-hidden": "true" });
    }

    // ---------- 共用登录面板（插件卡与设置分区共用：全部状态与交互都在这里） ----------
    function CodexAuthPanel(props) {
      var ctx = props.ctx;
      var stView = React.useState({ status: "loading" });
      var view = stView[0], setView = stView[1];
      var stNotices = React.useState([]);
      var notices = stNotices[0], setNotices = stNotices[1];
      var stPending = React.useState(null);
      var pending = stPending[0], setPending = stPending[1];
      var stAnswer = React.useState("");
      var answer = stAnswer[0], setAnswer = stAnswer[1];
      var stBusy = React.useState(false);
      var busy = stBusy[0], setBusy = stBusy[1];
      var stRoute = React.useState({ state: "unknown", msg: "" });
      var route = stRoute[0], setRoute = stRoute[1];
      var stArmed = React.useState(false);
      var armed = stArmed[0], setArmed = stArmed[1];
      var stCopied = React.useState(null);
      var copied = stCopied[0], setCopied = stCopied[1];
      var pollTimer = React.useRef(null);
      var runningRef = React.useRef(false);

      function stopPoll() {
        runningRef.current = false;
        if (pollTimer.current) { try { clearTimeout(pollTimer.current); } catch (e) { /* ignore */ } pollTimer.current = null; }
      }

      React.useEffect(function () { return stopPoll; }, []);

      function loadStatus() {
        setView(function (prev) {
          if (prev.status === "ready") return { status: "ready", flow: prev.flow, record: prev.record, active: prev.active, loading: true };
          return { status: "loading" };
        });
        post("/codex-auth/status", {}).then(function (resp) {
          if (!resp || !resp.ok) {
            setView({ status: "error", error: (resp && (resp.message || resp.error)) || TEXT.statusError });
            return;
          }
          setView({ status: "ready", flow: resp.flow, record: resp.record, active: resp.active || null });
          if (resp.active && resp.active.status === "running") startPoll();
        }, function () {
          setView({ status: "error", error: TEXT.statusError });
        });
      }

      React.useEffect(function () { loadStatus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

      function schedulePoll() {
        if (pollTimer.current) { try { clearTimeout(pollTimer.current); } catch (e) { /* ignore */ } }
        pollTimer.current = setTimeout(doPoll, POLL_MS);
      }

      function startPoll() {
        if (runningRef.current) return;
        runningRef.current = true;
        doPoll();
      }

      function doPoll() {
        if (!runningRef.current) return;
        post("/codex-auth/poll", {}).then(function (resp) {
          if (!runningRef.current) return;
          if (!resp || !resp.ok) { schedulePoll(); return; }
          setNotices(Array.isArray(resp.notices) ? resp.notices : []);
          setPending(resp.pending || null);
          var st = resp.active && resp.active.status;
          setView(function (prev) {
            if (prev.status !== "ready") return prev;
            return { status: "ready", flow: prev.flow, record: prev.record, active: resp.active || null };
          });
          if (st === "running") { schedulePoll(); return; }
          runningRef.current = false;
          // 终态：刷新一次登录态（authorized 后 record 应变为 configured）。
          post("/codex-auth/status", {}).then(function (s) {
            if (s && s.ok) {
              setView({ status: "ready", flow: s.flow, record: s.record, active: s.active || null });
            }
          }, function () { /* 保持轮询到的终态展示 */ });
        }, function () {
          if (runningRef.current) schedulePoll();
        });
      }

      function onStart(loginMethod) {
        if (busy) return;
        setBusy(true);
        setNotices([]);
        setPending(null);
        post("/codex-auth/start", { loginMethod: loginMethod }).then(function (resp) {
          setBusy(false);
          if (!resp || !resp.ok) {
            setView(function (prev) {
              if (prev.status !== "ready") return prev;
              return { status: "ready", flow: prev.flow, record: prev.record, active: prev.active, startError: (resp && (resp.message || resp.error)) || TEXT.statusError };
            });
            return;
          }
          setView(function (prev) {
            if (prev.status !== "ready") return prev;
            return { status: "ready", flow: prev.flow, record: prev.record, active: resp.active || null, startError: null };
          });
          startPoll();
        }, function () {
          setBusy(false);
          setView(function (prev) {
            if (prev.status !== "ready") return prev;
            return { status: "ready", flow: prev.flow, record: prev.record, active: prev.active, startError: TEXT.statusError };
          });
        });
      }

      function onAnswerText(text) {
        var t = typeof text === "string" ? text : answer;
        if (!t || !t.trim() || busy) return;
        setBusy(true);
        post("/codex-auth/answer", { text: t }).then(function (resp) {
          setBusy(false);
          if (resp && resp.ok) setAnswer("");
        }, function () { setBusy(false); });
      }

      function onAnswerOption(id) {
        if (busy) return;
        setBusy(true);
        post("/codex-auth/answer", { text: id }).then(function () { setBusy(false); }, function () { setBusy(false); });
      }

      function onCancel() {
        if (busy) return;
        setBusy(true);
        post("/codex-auth/cancel", {}).then(function () { setBusy(false); }, function () { setBusy(false); });
      }

      function onSignout() {
        if (busy) return;
        if (!armed) {
          setArmed(true);
          setTimeout(function () { setArmed(false); }, 8000);
          return;
        }
        setArmed(false);
        setBusy(true);
        post("/codex-auth/signout", {}).then(function (resp) {
          setBusy(false);
          if (resp && resp.ok) loadStatus();
          else {
            setView(function (prev) {
              if (prev.status !== "ready") return prev;
              return { status: "ready", flow: prev.flow, record: prev.record, active: prev.active, startError: (resp && (resp.message || resp.error)) || TEXT.statusError };
            });
          }
        }, function () { setBusy(false); });
      }

      function findLlmPiAiView(descValue) {
        try {
          var nss = descValue && descValue.namespaces;
          if (!Array.isArray(nss)) return null;
          for (var i = 0; i < nss.length; i++) {
            if (nss[i] && nss[i].ns === "llm-pi-ai") return nss[i];
          }
          return null;
        } catch (e) { return null; }
      }

      function onCheckRoute() {
        setRoute({ state: "checking", msg: "" });
        var remote = null;
        try { remote = ctx && ctx.remote && ctx.remote.settings; } catch (e) { remote = null; }
        if (!remote || typeof remote.describe !== "function") {
          setRoute({ state: "manual", msg: "当前连接读不到 remote.settings，按下方手动片段配置。" });
          return;
        }
        remote.describe().then(function (resp) {
          if (!resp || !resp.ok) {
            setRoute({ state: "error", msg: (resp && resp.error && resp.error.message) || TEXT.statusError });
            return;
          }
          var v = findLlmPiAiView(resp.value);
          if (!v) { setRoute({ state: "error", msg: "找不到 llm-pi-ai 命名空间（dsh-llm-pi-ai 未挂载？）" }); return; }
          var val = v.value || {};
          var providers = val.providers || {};
          if (Object.prototype.hasOwnProperty.call(providers, "openai-codex")) {
            setRoute({ state: "present", msg: "", revision: v.revision });
          } else {
            setRoute({ state: "absent", msg: "", revision: v.revision });
          }
        }, function () {
          setRoute({ state: "error", msg: TEXT.statusError });
        });
      }

      function onEnsureRoute() {
        var remote = null;
        try { remote = ctx && ctx.remote && ctx.remote.settings; } catch (e) { remote = null; }
        if (!remote || typeof remote.describe !== "function" || typeof remote.mutate !== "function") {
          setRoute({ state: "manual", msg: "当前连接写不到 settings，按下方手动片段配置。" });
          return;
        }
        setRoute({ state: "ensuring", msg: "" });
        remote.describe().then(function (resp) {
          if (!resp || !resp.ok) {
            setRoute({ state: "error", msg: (resp && resp.error && resp.error.message) || TEXT.statusError });
            return;
          }
          var v = findLlmPiAiView(resp.value);
          if (!v) { setRoute({ state: "error", msg: "找不到 llm-pi-ai 命名空间" }); return; }
          var val = v.value || {};
          var providers = val.providers || {};
          if (Object.prototype.hasOwnProperty.call(providers, "openai-codex")) {
            setRoute({ state: "present", msg: "" });
            return;
          }
          var rev = (typeof v.revision === "number") ? v.revision : undefined;
          return remote.mutate("llm-pi-ai", [{ op: "set", path: ["providers", "openai-codex"], value: {} }], rev).then(function (m) {
            if (m && m.ok) setRoute({ state: "present", msg: "created" });
            else setRoute({ state: "error", msg: ((m && m.error && m.error.message) || "写入被拒绝") });
          });
        }, function () {
          setRoute({ state: "error", msg: TEXT.statusError });
        });
      }

      if (view.status === "loading") {
        return React.createElement(React.Fragment, null,
          React.createElement("div", { style: hintStyle }, TEXT.loading));
      }
      if (view.status === "error") {
        return React.createElement(React.Fragment, null,
          React.createElement("div", { style: errStyle, role: "alert" }, TEXT.statusError + "（" + view.error + "）"),
          React.createElement("div", null,
            React.createElement("button", { type: "button", style: btnBase, onClick: loadStatus }, TEXT.retry)));
      }

      var flow = view.flow;
      var record = view.record || { configured: false };
      var cur = view.active;
      var running = !!(cur && cur.status === "running");
      var authed = !!record.configured;
      var dotState = running ? "ing" : (authed ? "in" : ((cur && cur.status === "failed") ? "fail" : "out"));
      var statusText = running ? TEXT.loggingIn : (authed ? TEXT.loggedIn : ((cur && cur.status === "failed") ? TEXT.loginFailed : TEXT.loggedOut));

      // 路由状态收成一个小 pill：圆点颜色 + 短文本 + 语气。
      var routeMeta = { dot: "out", text: TEXT.routeUnknown, tone: hintStyle };
      if (route.state === "checking" || route.state === "ensuring") {
        routeMeta = { dot: "ing", text: TEXT.ensuring, tone: hintStyle };
      } else if (route.state === "present") {
        routeMeta = { dot: "in", text: TEXT.routePresent, tone: okStyle };
      } else if (route.state === "absent") {
        routeMeta = { dot: "ing", text: TEXT.routeAbsent, tone: hintStyle };
      } else if (route.state === "manual") {
        routeMeta = { dot: "out", text: route.msg, tone: hintStyle };
      } else if (route.state === "error") {
        routeMeta = { dot: "fail", text: route.msg, tone: errStyle };
      }
      function RoutePill() {
        return React.createElement("span", { style: pillStyle },
          React.createElement(StatusDot, { state: routeMeta.dot }),
          React.createElement("span", { style: routeMeta.tone }, routeMeta.text));
      }

      return React.createElement(React.Fragment, null,
          flow ? null : React.createElement("div", { style: errStyle, role: "alert" }, TEXT.flowMissing),
          // —— 状态横幅：底色随登录态走，右侧常驻刷新 ——
          React.createElement("div", { style: bannerStyle(dotState), role: "status" },
            React.createElement("div", { style: rowStyle },
              React.createElement(StatusDot, { state: dotState }),
              React.createElement("span", { style: statusTextStyle }, statusText),
              flow && flow.label ? React.createElement("span", { style: pillStyle }, flow.label) : null,
              React.createElement("span", { style: { flex: 1 } }),
              React.createElement("button", { type: "button", style: btnBase, disabled: busy, onClick: loadStatus }, TEXT.refresh)),
            view.startError ? React.createElement("div", { style: errStyle }, view.startError) : null,
            cur && cur.status === "failed" && cur.error
              ? React.createElement("div", { style: errStyle }, cur.error + (cur.errorCode ? "（" + cur.errorCode + "）" : ""))
              : null,
            cur && cur.status === "cancelled"
              ? React.createElement("div", { style: hintStyle }, TEXT.cancelledDone)
              : null),
          // —— 登录方式 ——
          flow ? React.createElement("div", { style: sectionStyle },
            React.createElement("div", { style: sectionTitleStyle }, TEXT.loginSection),
            React.createElement("div", { style: rowStyle },
              React.createElement("button", {
                type: "button", style: btnPrimary, disabled: busy || running,
                title: TEXT.browserHint, onClick: function () { onStart("browser"); },
              }, TEXT.browserLogin),
              running ? React.createElement("button", {
                type: "button", style: btnBase, disabled: busy, onClick: onCancel,
              }, TEXT.cancel) : null,
              authed && !running ? React.createElement("button", {
                type: "button", style: armed ? btnDanger : btnBase, disabled: busy, onClick: onSignout,
                title: TEXT.signoutHint,
              }, armed ? TEXT.signoutArm : TEXT.signout) : null),
            running
              ? null
              : React.createElement("div", { style: hintStyle }, authed ? TEXT.signoutHint : TEXT.browserHint)
          ) : null,
          // 进行中的 notices（device 码 / 授权链接）
          running && notices.length === 0 && !pending
            ? React.createElement("div", { style: hintStyle }, TEXT.waiting)
            : null,
          notices.map(function (n, i) {
            var url = n.url || n.verificationUri;
            var code = n.code || n.userCode;
            var msg = n.message || n.instructions || "";
            return React.createElement("div", { key: (n.seq !== undefined ? n.seq : i), style: noticeStyle },
              msg ? React.createElement("span", null, msg) : null,
              url ? React.createElement("div", { style: rowStyle },
                React.createElement("a", { href: url, target: "_blank", rel: "noreferrer" }, url),
                React.createElement("button", {
                  type: "button", style: btnBase,
                  onClick: function () { try { window.open(url, "_blank", "noopener"); } catch (e) { /* ignore */ } },
                }, TEXT.openUrl)) : null,
              code ? React.createElement("div", { style: rowStyle },
                React.createElement("span", { style: codeStyle }, code),
                React.createElement("button", {
                  type: "button", style: btnBase,
                  onClick: function () {
                    copyText(code, function (ok) {
                      setCopied(code);
                      setTimeout(function () { setCopied(null); }, 2000);
                    });
                  },
                }, copied === code ? TEXT.copied : TEXT.copy)) : null);
          }),
          // 待答 prompt：有 options 就渲染成按钮（不管 kind 是 select 还是 text——
          // Codex 方法选择器的 kind 就是 'text'），否则渲染输入框。
          running && pending && Array.isArray(pending.options) && pending.options.length > 0
            ? React.createElement("div", { style: noticeStyle },
              React.createElement("span", null, pending.message || "请选择"),
              React.createElement("div", { style: rowStyle },
                pending.options.map(function (o) {
                  return React.createElement("button", {
                    key: o.id, type: "button", style: btnBase, disabled: busy,
                    onClick: function () { onAnswerOption(o.id); },
                  }, o.label || o.id);
                })))
            : null,
          running && pending && !(Array.isArray(pending.options) && pending.options.length > 0)
            ? React.createElement("div", { style: noticeStyle },
              React.createElement("span", null, pending.message || "请输入"),
              React.createElement("div", { style: rowStyle },
                React.createElement("input", {
                  type: pending.kind === "secret" ? "password" : "text",
                  value: answer, placeholder: pending.placeholder || TEXT.answerPh,
                  disabled: busy, style: inputStyle,
                  onChange: function (e) { setAnswer(e.currentTarget.value); },
                  onKeyDown: function (e) { if (e.key === "Enter") onAnswerText(); },
                }),
                React.createElement("button", {
                  type: "button", style: btnPrimary, disabled: busy || !answer.trim(),
                  onClick: function () { onAnswerText(); },
                }, busy ? TEXT.answering : TEXT.answerBtn)))
            : null,
          React.createElement("div", { style: dividerStyle }),
          // —— 模型路由 ——
          React.createElement("div", { style: sectionStyle },
            React.createElement("div", { style: rowStyle },
              React.createElement("span", { style: sectionTitleStyle }, TEXT.routeTitle),
              React.createElement("span", { style: { flex: 1 } }),
              React.createElement(RoutePill, null)),
            React.createElement("div", { style: rowStyle },
              React.createElement("button", { type: "button", style: btnBase, disabled: busy, onClick: onCheckRoute }, TEXT.checkRoute),
              React.createElement("button", { type: "button", style: btnBase, disabled: busy, onClick: onEnsureRoute }, TEXT.ensureRoute)),
            route.state === "present"
              ? React.createElement("div", { style: okStyle }, TEXT.routeOk) : null,
            React.createElement("div", { style: hintStyle }, TEXT.manualTitle),
            React.createElement("pre", { style: preStyle }, TEXT.manualYaml)),
          React.createElement("div", { style: dividerStyle }),
          // —— 说明 ——
          React.createElement("div", { style: sectionStyle },
            React.createElement("div", { style: sectionTitleStyle }, TEXT.hintsTitle),
            React.createElement("ul", { style: { margin: 0, paddingLeft: "18px", display: "flex", flexDirection: "column", gap: "4px" } },
            TEXT.hints.map(function (h, i) {
              return React.createElement("li", { key: i, style: hintStyle }, h);
            })))
      );
    }

    // ---------- 插件配置卡（常驻入口，风格与官方卡片一致） ----------
    function CodexAuthCard(props) {
      return React.createElement("li", { style: cardStyle },
        React.createElement("div", { style: headerStyle },
          React.createElement("div", { style: titleStyle }, TEXT.title),
          React.createElement("div", { style: descStyle }, TEXT.description)),
        React.createElement("div", { style: bodyStyle },
          React.createElement(CodexAuthPanel, { ctx: props.ctx }))
      );
    }

    // ---------- 设置分区（设置侧栏导航入口，整页展示同一套面板） ----------
    function CodexAuthSection(props) {
      return React.createElement("div", { style: cardStyle },
        React.createElement("div", { style: { padding: "18px 20px 0 20px", display: "flex", flexDirection: "column", gap: "6px" } },
          React.createElement("div", { style: titleStyle }, TEXT.title),
          React.createElement("div", { style: descStyle }, TEXT.subLong)
        ),
        React.createElement("div", { style: { padding: "12px 20px 16px 20px" } },
          React.createElement(CodexAuthPanel, { ctx: props.ctx })
        )
      );
    }

    function apply(ctx) {
      var face = {};
      try {
        if (ctx && ctx.remote) face.ctx = ctx;
        else face.ctx = null;
      } catch (e) { face.ctx = null; }
      // 1) 插件配置卡（常驻：设置 → 插件 → 插件配置）
      var disposeCard = ctx.slots.inject("settings.plugin.item", function () {
        return ctx.slots.register({
          name: "settings.plugin.item",
          key: NS,
          id: NS,
          order: 42,
        }, function () {
          return React.createElement(CodexAuthCard, { ctx: face.ctx });
        });
      });
      // 2) 设置分区（侧栏导航入口，紧贴归档清理 order 26，整页展示同一套面板）
      var disposeSection = ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "codex-auth",
          order: 27,
          label: TEXT.nav,
        }, function () {
          return React.createElement(CodexAuthSection, { ctx: face.ctx });
        });
      });
      return function () {
        try { if (typeof disposeCard === "function") disposeCard(); } catch (e) { /* ignore */ }
        try { if (typeof disposeSection === "function") disposeSection(); } catch (e) { /* ignore */ }
      };
    }

    return { name: "dsh-codex-auth", inject: ["slots", "remote", "remote.settings"], apply: apply };
  }
});
