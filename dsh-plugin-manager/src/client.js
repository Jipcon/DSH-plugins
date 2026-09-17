/**
 * dsh-plugin-manager — 浏览器半边（插件管理 Tab）。
 *
 * 本文件即源码，也是构建输入：load 调用的模块工厂，由 build.mjs 原样拷到 lib/client.js。
 * 在“设置 → 插件”下注册一个新的标签页（settings.plugins.tab，id plugin-manager，
 * order 5，位于“插件配置”之后、“插件列表”之前），列出当前 profile 的第三方插件，
 * 每个可卸载插件一行配一个两步确认的“卸载”按钮：
 *   第 1 次点击 → 按钮变红并提示“再次点击确认卸载”（8 秒内有效，防误触）；
 *   第 2 次点击 → POST /plugin-manager/uninstall { name, confirm: true } 真正卸载。
 * 卸载成功后该行消失并顶部提示“重启 DSH 后生效”（Loader 组合只在启动时决定）。
 *
 * 为什么是独立 Tab 而不是塞进每个插件自己的卡片：
 * settings.plugin.item 卡片由各插件自己拥有并渲染，第三方插件无法改写别人的卡片 DOM；
 * 管理 Tab 把全 profile 的第三方插件收拢到一处，效果等价且不受其它插件实现影响。
 *
 * 无外部依赖：只用 React + fetch + 内联样式（dsw CSS 变量，与官方卡片同设计语言）。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-manager",
  factory: function (require) {
    var React = require("react");

    var TAB_ID = "plugin-manager";
    var ARM_MS = 8000;

    var TEXT = {
      tab: "插件管理",
      title: "第三方插件",
      loading: "正在读取插件清单…",
      error: "插件清单读取失败，请刷新后重试。",
      retry: "重试",
      refresh: "刷新",
      searchPh: "搜索显示名 / 插件名",
      empty: "当前 profile 没有第三方插件。",
      emptySearch: "没有匹配的插件。",
      profile: "profile",
      enabledTag: "已启用",
      disabledTag: "已停用",
      builtinTag: "内置",
      selfTag: "自身",
      missingTag: "文件缺失",
      uninstall: "卸载",
      uninstallArm: "再次点击确认卸载",
      uninstalling: "卸载中…",
      uninstallTitle: "从 profile 卸载该插件（需重启生效）",
      selfHint: "这是插件管理自身，请用命令行卸载：dsh plugin --profile <name> remove dsh-plugin-manager",
      builtinTitle: "内置插件（不可卸载）",
      builtinHint: "随 DSH 发版自带，不在 profile 依赖中，无法通过本页卸载。",
      restartDone: "已卸载 {display}（{name}），重启 DSH 后生效。若其文件正被占用，重启后可再进本页确认；lockfile 残留条目可在重启后运行 dsh plugin --profile {profile} install 修剪。",
      uninstallFailed: "卸载失败：{err}",
      requestFailed: "请求失败，请刷新后重试。",
      confirmHint: "卸载将从 profile 清单移除该插件并删除其文件，重启后彻底生效，不可撤销。",
      countUnit: "个",
    };

    function displayNameOf(p) {
      if (p && typeof p.displayName === "string" && p.displayName.trim() !== "") return p.displayName;
      return (p && p.name) || "";
    }

    function describeOf(p) {
      if (p && typeof p.description === "string" && p.description.trim() !== "") return p.description.trim();
      return "";
    }

    function fmt(text, vars) {
      return String(text).replace(/\{(\w+)\}/g, function (m, k) {
        return vars && vars[k] !== undefined ? String(vars[k]) : m;
      });
    }

    function post(path, body) {
      return fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json(); });
    }

    // ---------- 内联样式（dsw 变量，与官方卡片同语言） ----------
    var wrapStyle = { display: "flex", flexDirection: "column", gap: "12px" };
    var headRowStyle = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" };
    var titleStyle = { fontSize: "15px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
    var metaStyle = { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" };
    var spacerStyle = { flex: 1 };
    var searchStyle = {
      width: "100%", boxSizing: "border-box", font: "inherit", fontSize: "13px",
      color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-3)",
      border: "0.5px solid var(--dsw-alias-border-l4)", borderRadius: "8px", padding: "8px 12px",
    };
    var listStyle = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "8px" };
    var rowStyle = {
      display: "flex", alignItems: "center", gap: "10px",
      border: "0.5px solid var(--dsw-alias-border-l4)", borderRadius: "12px",
      background: "var(--dsw-alias-bg-layer-3)", padding: "10px 14px",
    };
    var nameStyle = {
      fontSize: "14px", fontWeight: 600, color: "var(--dsw-alias-label-primary)",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    };
    var verStyle = { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", flex: "none" };
    var subStyle = {
      fontSize: "12px", color: "var(--dsw-alias-label-tertiary)",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    };
    var leftColStyle = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" };
    var titleLineStyle = { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 };
    var tagStyle = {
      flex: "none", fontSize: "11px", lineHeight: "18px", padding: "0 8px", borderRadius: "9px",
      border: "0.5px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)",
    };
    var btnBase = {
      appearance: "none", border: "1px solid var(--dsw-alias-border-l2)",
      background: "transparent", color: "var(--dsw-alias-label-secondary)",
      borderRadius: "6px", padding: "4px 12px", fontSize: "12px",
      cursor: "pointer", fontFamily: "inherit", flex: "none",
    };
    function dangerBtn(on) {
      var s = {};
      for (var k in btnBase) s[k] = btnBase[k];
      if (on) {
        s.border = "1px solid var(--dsw-alias-label-error, #e5484d)";
        s.color = "var(--dsw-alias-label-error, #e5484d)";
        s.fontWeight = 600;
      }
      return s;
    }
    var noticeOkStyle = {
      fontSize: "13px", lineHeight: 1.6, color: "var(--dsw-alias-label-primary)",
      background: "var(--dsw-alias-bg-layer-2)", border: "0.5px solid var(--dsw-alias-border-l4)",
      borderRadius: "10px", padding: "10px 14px",
    };
    var noticeErrStyle = {
      fontSize: "13px", lineHeight: 1.6, color: "var(--dsw-alias-label-error, #e5484d)",
      background: "var(--dsw-alias-bg-layer-2)", border: "0.5px solid var(--dsw-alias-label-error, #e5484d)",
      borderRadius: "10px", padding: "10px 14px",
    };
    var hintStyle = { fontSize: "12px", lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary)" };
    var sectionTitleStyle = { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-secondary)", marginTop: "4px" };
    var statusStyle = { fontSize: "13px", color: "var(--dsw-alias-label-tertiary)" };

    function Tag(props) {
      return React.createElement("span", { style: tagStyle, title: props.title }, props.text);
    }

    function PluginManagerTab() {
      var viewState = React.useState({ status: "loading" });
      var view = viewState[0];
      var setView = viewState[1];
      var queryState = React.useState("");
      var query = queryState[0];
      var setQuery = queryState[1];
      var armedState = React.useState({});
      var armed = armedState[0];
      var setArmed = armedState[1];
      var busyState = React.useState({});
      var busy = busyState[0];
      var setBusy = busyState[1];
      var noticeState = React.useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var requestState = React.useState(0);
      var request = requestState[0];
      var setRequest = requestState[1];
      var timersRef = React.useRef({});

      React.useEffect(function () {
        return function () {
          var timers = timersRef.current;
          for (var k in timers) { try { clearTimeout(timers[k]); } catch (e) { /* ignore */ } }
          timersRef.current = {};
        };
      }, []);

      React.useEffect(function () {
        var current = true;
        setView({ status: "loading" });
        post("/plugin-manager/list", {}).then(function (resp) {
          if (!current) return;
          if (resp && resp.ok) {
            setView({ status: "ready", profile: resp.profile, plugins: resp.plugins || [] });
          } else {
            setView({ status: "error", error: (resp && (resp.error || resp.message)) || TEXT.requestFailed });
          }
        }, function () {
          if (current) setView({ status: "error", error: TEXT.requestFailed });
        });
        return function () { current = false; };
      }, [request]);

      function disarm(name) {
        setArmed(function (prev) {
          if (!prev[name]) return prev;
          var next = {};
          for (var k in prev) { if (k !== name) next[k] = prev[k]; }
          return next;
        });
        var timers = timersRef.current;
        if (timers[name]) { try { clearTimeout(timers[name]); } catch (e) { /* ignore */ } delete timers[name]; }
      }

      function onUninstallClick(plugin) {
        var pname = plugin.name;
        var dname = displayNameOf(plugin);
        if (busy[pname]) return;
        if (!armed[pname]) {
          var next = {};
          for (var k in armed) next[k] = armed[k];
          next[pname] = true;
          setArmed(next);
          var timers = timersRef.current;
          if (timers[pname]) { try { clearTimeout(timers[pname]); } catch (e) { /* ignore */ } }
          timers[pname] = setTimeout(function () { disarm(pname); }, ARM_MS);
          return;
        }
        disarm(pname);
        var b = {};
        for (var k2 in busy) b[k2] = busy[k2];
        b[pname] = true;
        setBusy(b);
        setNotice(null);
        post("/plugin-manager/uninstall", { name: pname, confirm: true }).then(function (resp) {
          setBusy(function (prev) {
            var nb = {};
            for (var k in prev) { if (k !== pname) nb[k] = prev[k]; }
            return nb;
          });
          if (resp && resp.ok) {
            setView(function (prev) {
              if (prev.status !== "ready") return prev;
              return {
                status: "ready", profile: prev.profile,
                plugins: prev.plugins.filter(function (p) { return p.name !== pname; }),
              };
            });
            setNotice({
              kind: "ok",
              text: fmt(TEXT.restartDone, {
                display: dname,
                name: pname,
                profile: (resp && resp.profile) || ((view.status === "ready" && view.profile && view.profile.name) || ""),
              }),
            });
          } else {
            var err = (resp && (resp.message || resp.error)) || TEXT.requestFailed;
            setNotice({ kind: "error", text: fmt(TEXT.uninstallFailed, { err: err }) });
          }
        }, function () {
          setBusy(function (prev) {
            var nb2 = {};
            for (var k4 in prev) { if (k4 !== pname) nb2[k4] = prev[k4]; }
            return nb2;
          });
          setNotice({ kind: "error", text: fmt(TEXT.uninstallFailed, { err: TEXT.requestFailed }) });
        });
      }

      if (view.status === "loading") {
        return React.createElement("div", { style: wrapStyle },
          React.createElement("p", { style: statusStyle }, TEXT.loading));
      }
      if (view.status === "error") {
        return React.createElement("div", { style: wrapStyle },
          React.createElement("p", { style: statusStyle, role: "alert" }, TEXT.error + "（" + view.error + "）"),
          React.createElement("div", null,
            React.createElement("button", {
              type: "button", style: btnBase,
              onClick: function () { setRequest(function (v) { return v + 1; }); },
            }, TEXT.retry)));
      }

      var q = query.trim().toLowerCase();
      function matchName(p) {
        if (!q) return true;
        var hay = [displayNameOf(p), p.name, describeOf(p)].join("\n").toLowerCase();
        return hay.indexOf(q) !== -1;
      }
      var externals = view.plugins.filter(function (p) { return p.external && matchName(p); });
      var builtins = view.plugins.filter(function (p) { return !p.external && matchName(p); });
      var profileName = (view.profile && view.profile.name) || "";

      return React.createElement("div", { style: wrapStyle },
        // 头部
        React.createElement("div", { style: headRowStyle },
          React.createElement("span", { style: titleStyle }, TEXT.title),
          React.createElement("span", { style: metaStyle },
            TEXT.profile + " " + profileName + " · " + String(externals.length) + " " + TEXT.countUnit),
          React.createElement("span", { style: spacerStyle }),
          React.createElement("button", {
            type: "button", style: btnBase,
            onClick: function () { setNotice(null); setRequest(function (v) { return v + 1; }); },
          }, TEXT.refresh)),
        notice ? React.createElement("div", {
          style: notice.kind === "ok" ? noticeOkStyle : noticeErrStyle, role: "status",
        }, notice.text) : null,
        React.createElement("div", { style: hintStyle }, TEXT.confirmHint),
        // 搜索
        React.createElement("input", {
          type: "search", value: query, placeholder: TEXT.searchPh, "aria-label": TEXT.searchPh,
          style: searchStyle, onChange: function (e) { setQuery(e.currentTarget.value); },
        }),
        // 第三方插件（主行显示插件页的显示名，副行显示开发名包名 + 描述）
        externals.length === 0
          ? React.createElement("p", { style: statusStyle }, q ? TEXT.emptySearch : TEXT.empty)
          : React.createElement("ul", { style: listStyle },
            externals.map(function (p) {
              var isSelf = !!p.isSelf;
              var isArmed = !!armed[p.name];
              var isBusy = !!busy[p.name];
              var dname = displayNameOf(p);
              var desc = describeOf(p);
              var subLine = p.name + (desc ? " · " + desc : "");
              var fullTitle = dname === p.name ? p.name : dname + " (" + p.name + ")" + (desc ? " — " + desc : "");
              var btnLabel = isBusy ? TEXT.uninstalling : (isArmed ? TEXT.uninstallArm : TEXT.uninstall);
              var btn = isSelf
                ? React.createElement("button", {
                  type: "button", style: btnBase, disabled: true, title: TEXT.selfHint,
                }, TEXT.uninstall)
                : React.createElement("button", {
                  type: "button", style: dangerBtn(isArmed), disabled: isBusy,
                  title: TEXT.uninstallTitle + "：" + fullTitle,
                  "aria-label": TEXT.uninstall + " " + fullTitle,
                  onClick: function () { onUninstallClick(p); },
                }, btnLabel);
              return React.createElement("li", { key: p.name, style: rowStyle, "data-plugin": p.name, title: fullTitle },
                React.createElement("div", { style: leftColStyle },
                  React.createElement("div", { style: titleLineStyle },
                    React.createElement("span", { style: nameStyle, title: fullTitle }, dname),
                    React.createElement("span", { style: verStyle }, p.version || (p.installed === false ? TEXT.missingTag : "")),
                    p.isSelf ? React.createElement(Tag, { text: TEXT.selfTag, title: TEXT.selfHint }) : null,
                    !p.isSelf && p.installed === false
                      ? React.createElement(Tag, { text: TEXT.missingTag }) : null,
                    !p.isSelf && p.installed !== false
                      ? React.createElement(Tag, { text: p.enabled ? TEXT.enabledTag : TEXT.disabledTag }) : null),
                  React.createElement("div", { style: subStyle, title: p.name }, subLine)),
                btn);
            })),
        // 内置插件（只读）
        builtins.length === 0 ? null : React.createElement(React.Fragment, null,
          React.createElement("div", { style: sectionTitleStyle }, TEXT.builtinTitle),
          React.createElement("div", { style: hintStyle }, TEXT.builtinHint),
          React.createElement("ul", { style: listStyle },
            builtins.map(function (p) {
              var bdname = displayNameOf(p);
              return React.createElement("li", { key: "builtin:" + p.name, style: rowStyle, "data-plugin": p.name },
                React.createElement("span", { style: nameStyle, title: p.name }, bdname),
                React.createElement("span", { style: spacerStyle }),
                React.createElement(Tag, { text: TEXT.builtinTag }));
            })))
      );
    }

    function apply(ctx) {
      var disposer = ctx.slots.inject("settings.plugins.tab", function () {
        return ctx.slots.register({
          name: "settings.plugins.tab",
          id: TAB_ID,
          order: 5,
          label: TEXT.tab,
        }, PluginManagerTab);
      });
      return function () {
        try { if (typeof disposer === "function") disposer(); } catch (e) { /* ignore */ }
      };
    }

    return { name: "dsh-plugin-manager", inject: ["slots"], apply: apply };
  }
});
