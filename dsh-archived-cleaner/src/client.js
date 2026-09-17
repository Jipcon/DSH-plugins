/**
 * dsh-archived-cleaner — 浏览器半边。
 *
 * 本文件即源码，也是构建输入：load 调用的模块工厂，由 build.mjs 原样拷到 lib/client.js。
 * 不依赖 ui-primitives 与 locale，全部文案为单语中文常量 TEXT，样式为内联 style。
 *
 * 两处 UI（共用 CleanerList 组件）：
 *  1. 插件配置卡（settings.plugin.item，id dsh-archived-cleaner）：可折叠卡片，
 *     头部含标题/副标题/启用勾选/箭头，风格与 MessageRecall 卡一致。
 *  2. 设置分区（settings.section，id archived-cleaner，order 26）：设置侧栏导航入口，
 *     紧贴官方「已归档会话」（order 25），整页展示同一套清理列表。
 *
 * 总开关（localStorage dsh-archived-cleaner:enabled，默认开）：关闭后两处 UI 只显示
 * 停用提示与启用勾选，删除动作全部隐藏（分区本身保留，否则关了就找不回入口——
 * 与 MessageRecall 常驻设置卡同理）。
 */
window.__ModuleLoader__.load({
  id: "dsh-archived-cleaner",
  factory: function (require) {
    var React = require("react");

    var TEXT = {
      title: "已归档会话清理",
      nav: "归档清理",
      sub: "彻底删除已归档会话，释放磁盘空间",
      subLong: "彻底删除已归档会话的文件与注册表引用，释放磁盘。删除不可恢复，请确认。",
      expand: "展开",
      collapse: "收起",
      enable: "启用",
      enabledHint: "关闭后归档清理功能停用，删除按钮全部隐藏；本卡与设置分区保留，可随时重新打开。",
      disabledHint: "归档清理已停用。勾选「启用」后可查看并删除已归档会话。",
      refresh: "刷新",
      searchPh: "搜索标题 / workspace",
      empty: "没有已归档会话。",
      unavailable: "归档列表暂不可用（host 未就绪或插件服务缺失），稍后刷新重试。",
      loading: "正在读取已归档会话…",
      selectAll: "全选",
      deleteOne: "删除",
      deleteOneArm: "确认删除？",
      deleteSelected: "删除所选",
      deleteSelectedArm: "确认删除所选？",
      clearAll: "清空全部已归档",
      clearAllArm: "再次点击确认清空全部",
      liveBadge: "使用中",
      goneBadge: "文件已不在",
      deleteDisabledLive: "该会话仍在内存/运行中，关闭后才能删除",
      noticeDeleted: "已删除 {n} 个会话。",
      noticePartial: "已删除 {ok} 个，跳过 {skip} 个（见各行标注或刷新后重试）。",
      noticeFailed: "删除失败：{err}",
      requestFailed: "请求失败，请刷新后重试。",
      confirmHint: "删除为不可逆的文件删除（含该会话目录下全部历史版本文件）。",
      countLine: "共 {n} 个已归档",
      selectedLine: "已选 {n} 个"
    };

    var ARM_MS = 8000;

    // ---------- 设置读写（localStorage） ----------
    function getSetting(key, def) {
      try { var v = localStorage.getItem(key); return v === null ? def : v; } catch (e) { return def; }
    }
    function setSetting(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } }
    function getBool(key, def) { return getSetting(key, def ? "1" : "0") !== "0"; }
    function setBool(key, v) { setSetting(key, v ? "1" : "0"); }

    // ---------- 插件总开关（可订阅快照，切换即时生效，无需刷新） ----------
    var ENABLED_KEY = "dsh-archived-cleaner:enabled";
    var enabledSnapshot = true;
    var enabledListeners = {};
    var enabledSeq = 0;
    function readEnabled() {
      try { return getBool(ENABLED_KEY, true); } catch (e) { return true; }
    }
    enabledSnapshot = readEnabled();
    function subscribeEnabled(listener) {
      var id = "l" + (++enabledSeq);
      enabledListeners[id] = listener;
      return function () { delete enabledListeners[id]; };
    }
    function getEnabledSnapshot() { return enabledSnapshot; }
    function setPluginEnabled(v) {
      setBool(ENABLED_KEY, v);
      var next = !!v;
      if (next === enabledSnapshot) return;
      enabledSnapshot = next;
      for (var k in enabledListeners) {
        try { enabledListeners[k](); } catch (e) { /* 单个订阅者异常不影响其余 */ }
      }
    }
    function useEnabled() {
      var st = React.useState(getEnabledSnapshot);
      React.useEffect(function () { return subscribeEnabled(function () { st[1](getEnabledSnapshot()); }); }, []);
      return st[0];
    }

    function fmtBytes(n) {
      if (typeof n !== "number" || !isFinite(n) || n < 0) return "—";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
      return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
    }

    function fmtAgo(ts) {
      if (typeof ts !== "number" || !isFinite(ts) || ts <= 0) return "";
      var d = Date.now() - ts;
      if (d < 0) d = 0;
      var m = Math.floor(d / 60000);
      if (m < 1) return "刚刚";
      if (m < 60) return m + " 分钟前";
      var h = Math.floor(m / 60);
      if (h < 24) return h + " 小时前";
      var days = Math.floor(h / 24);
      if (days < 30) return days + " 天前";
      try { return new Date(ts).toLocaleDateString(); } catch (e) { return ""; }
    }

    function post(path, body) {
      return fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {})
      }).then(function (r) { return r.json(); });
    }

    function readSnap(ctxSessions, ctxWorkspaces) {
      var sSnap = null, wSnap = null;
      try {
        if (ctxSessions && ctxSessions.list && typeof ctxSessions.list.getSnapshot === "function") {
          sSnap = ctxSessions.list.getSnapshot();
        }
      } catch (e) { sSnap = null; }
      try {
        if (ctxWorkspaces && ctxWorkspaces.list && typeof ctxWorkspaces.list.getSnapshot === "function") {
          wSnap = ctxWorkspaces.list.getSnapshot();
        }
      } catch (e) { wSnap = null; }
      return { sSnap: sSnap, wSnap: wSnap };
    }

    // ---------- 共用样式（与 MessageRecall 卡同设计语言） ----------
    var cardFrame = {
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "var(--dsw-alias-bg-layer-3)",
      borderRadius: "14px",
      listStyle: "none",
      transition: "border-color .16s, background .16s"
    };
    var headTitle = { color: "var(--dsw-alias-label-primary)", fontSize: "20px", fontWeight: 600, lineHeight: "1.4" };
    var headSub = { color: "var(--dsw-alias-label-tertiary)", fontSize: "14px", lineHeight: "1.5" };
    var btnBase = {
      appearance: "none", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))",
      background: "transparent", color: "var(--dsw-alias-label-secondary)",
      borderRadius: "6px", padding: "3px 10px", fontSize: "12px",
      cursor: "pointer", fontFamily: "inherit", flex: "none"
    };
    function dangerBtn(on) {
      var s = {};
      for (var k in btnBase) s[k] = btnBase[k];
      if (on) {
        s.background = "var(--dsw-alias-label-error, #d9534f)";
        s.borderColor = "var(--dsw-alias-label-error, #d9534f)";
        s.color = "#fff";
      }
      return s;
    }
    var metaStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", lineHeight: "1.5" };
    var nameStyle = {
      color: "var(--dsw-alias-label-primary)", fontSize: "13px", lineHeight: "1.4",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
    };
    var rowStyle = {
      display: "flex", alignItems: "center", gap: "10px",
      padding: "8px 10px", border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "8px", background: "var(--dsw-alias-bg-layer-4, transparent)"
    };
    var badgeStyle = {
      fontSize: "11px", padding: "0 6px", borderRadius: "999px",
      border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-warning, #b7791f)",
      flex: "none"
    };

    /** 启用勾选（卡片头与分区共用；点击不冒泡，避免误触折叠）。 */
    function EnableCheck(props) {
      return React.createElement("label", {
        onClick: function (ev) { ev.stopPropagation(); },
        style: {
          display: "flex", gap: "6px", alignItems: "center", flex: "none",
          fontSize: "13px", color: "var(--dsw-alias-label-secondary)", cursor: "pointer"
        }
      },
        React.createElement("input", {
          type: "checkbox", checked: props.checked,
          onChange: function (ev) { setPluginEnabled(ev.currentTarget.checked); }
        }),
        TEXT.enable
      );
    }

    // ---------- 共用清理列表（卡片体与分区体共用） ----------
    function CleanerList(props) {
      var ctxSessions = props.ctxSessions;
      var ctxWorkspaces = props.ctxWorkspaces;

      var stTick = React.useState(0);
      var tick = stTick[0], setTick = stTick[1];
      var stHost = React.useState(null);
      var host = stHost[0], setHost = stHost[1];
      var stHostErr = React.useState("");
      var hostErr = stHostErr[0], setHostErr = stHostErr[1];
      var stLoading = React.useState(false);
      var loading = stLoading[0], setLoading = stLoading[1];
      var stBusy = React.useState(false);
      var busy = stBusy[0], setBusy = stBusy[1];
      var stSel = React.useState({});
      var selected = stSel[0], setSelected = stSel[1];
      var stArm = React.useState(null);
      var arm = stArm[0], setArm = stArm[1];
      var stQuery = React.useState("");
      var query = stQuery[0], setQuery = stQuery[1];
      var stNotice = React.useState(null);
      var notice = stNotice[0], setNotice = stNotice[1];

      function bump() { setTick(function (v) { return v + 1; }); }

      // 订阅客户端快照（别的标签页归档/反归档时即时刷新展示）
      React.useEffect(function () {
        refresh();
        var unsubs = [];
        try {
          if (ctxSessions && ctxSessions.list && typeof ctxSessions.list.subscribe === "function") {
            unsubs.push(ctxSessions.list.subscribe(function () { bump(); }));
          }
        } catch (e) { /* ignore */ }
        try {
          if (ctxWorkspaces && ctxWorkspaces.list && typeof ctxWorkspaces.list.subscribe === "function") {
            unsubs.push(ctxWorkspaces.list.subscribe(function () { bump(); }));
          }
        } catch (e) { /* ignore */ }
        return function () {
          for (var i = 0; i < unsubs.length; i++) {
            try { unsubs[i](); } catch (e) { /* ignore */ }
          }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      function refresh() {
        bump();
        setLoading(true);
        setHostErr("");
        // 自愈侧栏僵尸行：host 删除会广播 api-session/removed，但此前版本删掉的
        // 会话可能还卡在各客户端 sessions list store 里（unarchive 后以"未分组"
        // 现形，点击即 session/not-found）。重拉一次会话基线即可丢掉它们
        // （文件已删、非 live，基线本来就不含）。best-effort：失败不影响归档清单。
        try {
          if (ctxSessions && typeof ctxSessions.refresh === "function") {
            var pr = ctxSessions.refresh();
            if (pr && typeof pr.catch === "function") pr.catch(function () { /* ignore */ });
          }
        } catch (e) { /* 旧客户端面无 refresh 时忽略 */ }
        post("/archived-cleaner/list", {}).then(function (d) {
          setLoading(false);
          if (d && d.ok && Array.isArray(d.archived)) {
            setHost(d);
            setHostErr("");
          } else {
            setHostErr((d && (d.error || d.message)) || "unavailable");
          }
        }).catch(function () {
          setLoading(false);
          setHostErr("request-failed");
        });
      }

      var snaps = readSnap(ctxSessions, ctxWorkspaces);
      var sSnap = snaps.sSnap, wSnap = snaps.wSnap;
      void tick;

      var rows = React.useMemo(function () {
        var owners = {};
        var items = (wSnap && Array.isArray(wSnap.items)) ? wSnap.items : [];
        for (var i = 0; i < items.length; i++) {
          var ws = items[i];
          if (!ws) continue;
          var title = ws.title || ws.path || "未命名";
          var ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
          for (var j = 0; j < ids.length; j++) owners[ids[j]] = title;
        }
        var byId = (sSnap && sSnap.byId) || {};
        var hostById = {};
        var order = [];
        if (host && Array.isArray(host.archived)) {
          for (var k = 0; k < host.archived.length; k++) {
            var e = host.archived[k];
            if (!e || typeof e.id !== "string") continue;
            hostById[e.id] = e;
            order.push(e.id);
          }
        } else if (wSnap && Array.isArray(wSnap.archivedSessionIds)) {
          order = wSnap.archivedSessionIds.slice();
        }
        // 归档顺序是旧→新，展示反转为新→旧（与官方归档页一致）
        order = order.reverse();
        var out = [];
        for (var n = 0; n < order.length; n++) {
          var id = order[n];
          var sum = byId[id] || null;
          var he = hostById[id] || null;
          out.push({
            id: id,
            title: (sum && (sum.displayTitle || sum.title)) || id,
            updatedAt: (sum && typeof sum.updatedAt === "number") ? sum.updatedAt : (he && he.createdAt) || 0,
            workspace: owners[id] || "未分组",
            live: !!(he && he.live),
            running: !!(he && he.running),
            persisted: he ? he.persisted !== false : true,
            sizeBytes: (he && typeof he.sizeBytes === "number") ? he.sizeBytes : null
          });
        }
        return out;
      }, [host, sSnap, wSnap]);

      var q = query.trim().toLowerCase();
      var visible = q.length === 0 ? rows : rows.filter(function (r) {
        return r.title.toLowerCase().indexOf(q) !== -1 || r.workspace.toLowerCase().indexOf(q) !== -1;
      });

      var selectable = rows.filter(function (r) { return !r.live; });
      var selIds = Object.keys(selected).filter(function (id) { return selected[id]; });
      var selAlive = selIds.filter(function (id) {
        return rows.some(function (r) { return r.id === id && !r.live; });
      });

      function armed(key) {
        return arm && arm.key === key && (Date.now() - arm.ts) < ARM_MS;
      }
      function clickArm(key, fn) {
        if (armed(key)) {
          setArm(null);
          fn();
        } else {
          setArm({ key: key, ts: Date.now() });
        }
      }

      function afterMutation(d, total) {
        setSelected({});
        setArm(null);
        if (d && d.ok) {
          var ok = (typeof d.deleted === "number") ? d.deleted : total;
          var skip = (d.skipped && d.skipped.length) || ((d.results || []).filter(function (r) { return !(r && r.ok); }).length) || 0;
          if (skip > 0) {
            var firstErr = "";
            var rs = d.results || [];
            for (var i = 0; i < rs.length; i++) {
              if (rs[i] && !rs[i].ok) { firstErr = rs[i].error || ""; break; }
            }
            setNotice({ kind: "warn", text: TEXT.noticePartial.replace("{ok}", String(ok)).replace("{skip}", String(skip)) + (firstErr ? "（" + firstErr + "）" : "") });
          } else {
            setNotice({ kind: "ok", text: TEXT.noticeDeleted.replace("{n}", String(ok)) });
          }
        } else {
          setNotice({ kind: "err", text: TEXT.noticeFailed.replace("{err}", (d && (d.error || d.message)) || TEXT.requestFailed) });
        }
        refresh();
      }

      function doDeleteMany(ids) {
        if (ids.length === 0) return;
        setBusy(true);
        setNotice(null);
        post("/archived-cleaner/delete-many", { sessionIds: ids }).then(function (d) {
          setBusy(false);
          afterMutation(d, ids.length);
        }).catch(function () {
          setBusy(false);
          setNotice({ kind: "err", text: TEXT.requestFailed });
        });
      }

      function doClear() {
        setBusy(true);
        setNotice(null);
        post("/archived-cleaner/clear", { confirm: true }).then(function (d) {
          setBusy(false);
          afterMutation(d, (d && d.total) || 0);
        }).catch(function () {
          setBusy(false);
          setNotice({ kind: "err", text: TEXT.requestFailed });
        });
      }

      function toggleSel(id, v) {
        setSelected(function (prev) {
          var next = {};
          for (var k in prev) next[k] = prev[k];
          if (v) next[id] = true;
          else delete next[id];
          return next;
        });
      }
      function toggleAll(v) {
        if (v) {
          var next = {};
          for (var i = 0; i < selectable.length; i++) next[selectable[i].id] = true;
          setSelected(next);
        } else {
          setSelected({});
        }
      }

      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
        React.createElement("div", { style: metaStyle }, TEXT.confirmHint),
        React.createElement("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
          React.createElement("input", {
            type: "search", value: query, placeholder: TEXT.searchPh, "aria-label": TEXT.searchPh,
            onChange: function (ev) { setQuery(ev.currentTarget.value); },
            style: {
              flex: "1", minWidth: "0", font: "inherit", fontSize: "13px",
              background: "transparent", color: "var(--dsw-alias-label-primary)",
              border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px", padding: "4px 8px"
            }
          }),
          React.createElement("button", { type: "button", onClick: refresh, disabled: loading, style: btnBase }, TEXT.refresh)
        ),
        loading ? React.createElement("div", { style: metaStyle }, TEXT.loading) : null,
        (!loading && hostErr) ? React.createElement("div", { style: metaStyle }, TEXT.unavailable) : null,
        (!loading && !hostErr && rows.length === 0) ? React.createElement("div", { style: metaStyle }, TEXT.empty) : null,
        visible.map(function (r) {
          var isArmed = armed("one:" + r.id);
          return React.createElement("div", { key: r.id, style: rowStyle },
            React.createElement("input", {
              type: "checkbox", disabled: r.live || busy,
              checked: !!selected[r.id],
              title: r.live ? TEXT.deleteDisabledLive : "",
              onChange: function (ev) { toggleSel(r.id, ev.currentTarget.checked); }
            }),
            React.createElement("span", { style: { flex: "1", minWidth: "0" } },
              React.createElement("span", { style: nameStyle, title: r.id }, r.title),
              React.createElement("br", null),
              React.createElement("span", { style: metaStyle },
                [r.workspace, fmtAgo(r.updatedAt), fmtBytes(r.sizeBytes)].filter(function (x) { return x; }).join(" · ")
              )
            ),
            r.live ? React.createElement("span", { style: badgeStyle }, TEXT.liveBadge + (r.running ? "·运行中" : "")) : null,
            (!r.persisted && !r.live) ? React.createElement("span", { style: badgeStyle }, TEXT.goneBadge) : null,
            React.createElement("button", {
              type: "button",
              disabled: r.live || busy,
              title: r.live ? TEXT.deleteDisabledLive : (isArmed ? TEXT.deleteOneArm : TEXT.deleteOne),
              onClick: function () { clickArm("one:" + r.id, function () { doDeleteMany([r.id]); }); },
              style: dangerBtn(isArmed)
            }, isArmed ? TEXT.deleteOneArm : TEXT.deleteOne)
          );
        }),
        rows.length > 0 ? React.createElement("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
          React.createElement("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" } },
            React.createElement("input", {
              type: "checkbox",
              checked: selectable.length > 0 && selAlive.length === selectable.length,
              disabled: selectable.length === 0 || busy,
              onChange: function (ev) { toggleAll(ev.currentTarget.checked); }
            }),
            TEXT.selectAll + "（" + TEXT.selectedLine.replace("{n}", String(selAlive.length)) + "）"
          ),
          React.createElement("span", { style: { flex: "1" } }),
          React.createElement("button", {
            type: "button", disabled: selAlive.length === 0 || busy,
            onClick: function () { clickArm("sel", function () { doDeleteMany(selAlive); }); },
            style: dangerBtn(armed("sel"))
          }, armed("sel") ? TEXT.deleteSelectedArm : (TEXT.deleteSelected + "（" + selAlive.length + "）")),
          React.createElement("button", {
            type: "button", disabled: selectable.length === 0 || busy,
            onClick: function () { clickArm("clear", doClear); },
            style: dangerBtn(armed("clear"))
          }, armed("clear") ? TEXT.clearAllArm : TEXT.clearAll)
        ) : null,
        notice ? React.createElement("div", {
          style: {
            fontSize: "12px", lineHeight: "1.5",
            color: notice.kind === "err" ? "var(--dsw-alias-label-error, #d9534f)"
              : notice.kind === "warn" ? "var(--dsw-alias-label-warning, #b7791f)"
              : "var(--dsw-alias-label-secondary)"
          }
        }, notice.text) : null
      );
    }

    // ---------- 插件配置卡（可折叠，风格对齐截图） ----------
    function ArchivedCleanerCard(props) {
      var enabled = useEnabled();
      var stOpen = React.useState(false);
      var open = stOpen[0], setOpen = stOpen[1];

      var headWrap = {
        display: "flex", alignItems: "center", gap: "12px",
        padding: "18px 20px", borderRadius: "14px"
      };
      var headTextBtn = {
        appearance: "none", background: "transparent", border: "none",
        font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer",
        display: "flex", flexDirection: "column", flex: "1", minWidth: "0", gap: "6px", padding: "0"
      };
      var chev = {
        color: "var(--dsw-alias-label-tertiary)", flex: "none", fontSize: "20px", lineHeight: "1",
        transition: "transform .16s", transform: open ? "rotate(180deg)" : "rotate(0deg)"
      };
      var body = {
        borderTop: "1px solid var(--dsw-alias-border-l2)", margin: "0 20px",
        paddingTop: "12px", paddingBottom: "16px",
        display: "flex", flexDirection: "column", gap: "10px"
      };

      return React.createElement("li", { style: cardFrame },
        React.createElement("div", { style: headWrap },
          React.createElement("button", {
            type: "button", onClick: function () { setOpen(!open); },
            "aria-expanded": open ? "true" : "false",
            "aria-label": (open ? TEXT.collapse : TEXT.expand) + "：" + TEXT.title,
            style: headTextBtn
          },
            React.createElement("span", { style: headTitle }, TEXT.title),
            React.createElement("span", { style: headSub }, TEXT.sub)
          ),
          React.createElement(EnableCheck, { checked: enabled }),
          React.createElement("span", { style: chev, "aria-hidden": "true" }, "∨")
        ),
        open ? React.createElement("div", { style: body },
          React.createElement("div", { style: metaStyle }, TEXT.enabledHint),
          enabled
            ? React.createElement(CleanerList, { ctxSessions: props.ctxSessions, ctxWorkspaces: props.ctxWorkspaces })
            : React.createElement("div", { style: metaStyle }, TEXT.disabledHint)
        ) : null
      );
    }

    // ---------- 设置分区（设置侧栏导航入口，整页展示） ----------
    function ArchivedCleanerSection(props) {
      var enabled = useEnabled();
      return React.createElement("div", { style: cardFrame },
        React.createElement("div", { style: { padding: "18px 20px 0 20px", display: "flex", flexDirection: "column", gap: "6px" } },
          React.createElement("div", { style: headTitle }, TEXT.title),
          React.createElement("div", { style: headSub }, TEXT.subLong)
        ),
        React.createElement("div", {
          style: {
            margin: "12px 20px 0 20px", padding: "10px 12px",
            border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px",
            display: "flex", gap: "8px", alignItems: "center"
          }
        },
          React.createElement(EnableCheck, { checked: enabled }),
          React.createElement("span", { style: metaStyle }, TEXT.enabledHint)
        ),
        React.createElement("div", { style: { padding: "12px 20px 16px 20px" } },
          enabled
            ? React.createElement(CleanerList, { ctxSessions: props.ctxSessions, ctxWorkspaces: props.ctxWorkspaces })
            : React.createElement("div", { style: metaStyle }, TEXT.disabledHint)
        )
      );
    }

    function serviceFace(ctx) {
      var s = null, w = null;
      try { s = ctx.sessions || null; } catch (e) { s = null; }
      try { w = ctx.workspaces || null; } catch (e) { w = null; }
      return { ctxSessions: s, ctxWorkspaces: w };
    }

    function apply(ctx) {
      return ctx.effect(function () {
        var disposers = [];
        // 1) 插件配置卡（常驻：关闭后靠它重新打开）
        disposers.push(ctx.slots.inject("settings.plugin.item", function () {
          return ctx.slots.register({
            name: "settings.plugin.item",
            key: "dsh-archived-cleaner",
            id: "dsh-archived-cleaner",
            order: 31,
            inject: function () { return serviceFace(ctx); }
          }, ArchivedCleanerCard);
        }));
        // 2) 设置分区（侧栏导航入口，紧贴官方「已归档会话」order 25）
        disposers.push(ctx.slots.inject("settings.section", function () {
          return ctx.slots.register({
            name: "settings.section",
            id: "archived-cleaner",
            order: 26,
            label: TEXT.nav,
            inject: function () { return serviceFace(ctx); }
          }, ArchivedCleanerSection);
        }));
        return function () {
          for (var i = 0; i < disposers.length; i++) {
            try { disposers[i](); } catch (e) { /* ignore */ }
          }
        };
      }, "dsh-archived-cleaner: settings surfaces");
    }

    return { name: "dsh-archived-cleaner", inject: ["slots", "sessions", "workspaces"], apply: apply };
  }
});
