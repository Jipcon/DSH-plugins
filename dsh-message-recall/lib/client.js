/**
 * dsh-message-recall — 浏览器半边。
 *
 * 本文件即源码，也是构建输入：load 调用的模块工厂，由 build.mjs 原样拷到 lib/client.js。
 * 图标使用 ui-primitives 的官方图标组件，不内联任何图片资源。
 * 界面文案为单语中文常量 TEXT；不接入 dsh-client-locale。
 */
window.__ModuleLoader__.load({
  id: "dsh-message-recall",
  factory: function (require) {
    var React = require("react");
    // react-dom 与 react 同源（都在宿主 PLATFORM_MODULES 模块表里），
    // 官方 ui-attachment 的图片放大预览正是用 react-dom 的 createPortal 挂到 body。
    var ReactDOM = require("react-dom");
    var Primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    var IconRefreshOutline16 = Primitives.IconRefreshOutline16;
    var IconCloseOutline16 = Primitives.IconCloseOutline16;


    /** 统一日志：默认静默（仅上报 host 落盘）；调试模式（localStorage dsh-message-recall:debug=1）时打印控制台。 */
    function debugEnabled() {
      try { if (localStorage.getItem("dsh-message-recall:debug") === "1") return true; } catch (e) { /* ignore */ }
      try { return /\?dsh-mr-debug/.test(location.search || ""); } catch (e) { return false; }
    }
    function log(level, tag, message, data) {
      try {
        if (debugEnabled()) {
          var prefix = "[dsh-message-recall][" + level + "] " + (tag ? "[" + tag + "] " : "");
          if (level === "error") console.error(prefix + message, data !== undefined ? data : "");
          else if (level === "warn") console.warn(prefix + message, data !== undefined ? data : "");
          else console.info(prefix + message, data !== undefined ? data : "");
        }
        try {
          fetch("/bubble/log", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ level: level, tag: tag, message: message, data: data !== undefined ? data : null }),
            keepalive: true
          }).catch(function () { /* 静默 */ });
        } catch (e) { /* 静默 */ }
      } catch (e) { /* 静默 */ }
    }


    // ---------- 设置读取（localStorage） ----------
    function getSetting(key, def) {
      try { var v = localStorage.getItem(key); return v === null ? def : v; } catch (e) { return def; }
    }
    function setSetting(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } }
    function getBool(key, def) { return getSetting(key, def ? "1" : "0") !== "0"; }
    function setBool(key, v) { setSetting(key, v ? "1" : "0"); }

    // ---------- 已移除功能遗留的 localStorage 键 ----------
    // 这些调节项已从设置卡移除，其行为改为固定值。留下的旧值不会再被任何代码读取，
    // 属于死数据；启动时连同旧的版本树键一起清扫（见 apply 内的清扫段）。
    // 保留这张表而不是逐个 removeItem：后来人一眼能看出「哪些键曾经存在、为何被弃」。
    var STALE_SETTING_KEYS = {
      "dsh-message-recall:rewriteOnClick": true,      // 气泡编辑开关（现恒为开）
      "dsh-message-recall:editOffShowRecall": true,   // 关闭编辑时显示撤回键（现恒为显示）
      "dsh-message-recall:statOnlyUser": true,        // 统计口径（现恒为仅用户提问）
      "dsh-message-recall:visualMode": true,          // 撤回视觉模式（现恒为简单档）
      "dsh-message-recall:conflictMode": true,        // 回填冲突模式（现恒为覆盖档）
      "dsh-message-recall:editWidth": true,           // 编辑宽度档位（功能已删除）
      "dsh-message-recall:editWidthCustom": true,     // 编辑宽度自定义值（功能已删除）
      "dsh-message-recall:hotkey": true,              // 撤回快捷键键位（功能已删除）
      "dsh-message-recall:hotkeyEnabled": true,       // 撤回快捷键总开关（功能已删除）
      "dsh-message-recall:autoCheckReminded": true    // 「不再显示更新提示」标记（提示已删除）
    };

    // ---------- 插件总开关 ----------
    // 关掉后插件的全部 UI 贡献（气泡编辑与撤回键、版本翻页器）都不注册；设置卡自身始终可用，
    // 否则关掉后就再也打不开了。
    // 用可订阅的小快照而不是一次性读值：开关要即时生效，无需刷新页面。
    var ENABLED_KEY = "dsh-message-recall:enabled";
    var enabledSnapshot = true;
    var enabledListeners = new Set();
    function readEnabled() {
      try { return getBool(ENABLED_KEY, true); } catch (e) { return true; }
    }
    enabledSnapshot = readEnabled();
    function subscribeEnabled(listener) {
      enabledListeners.add(listener);
      return function () { enabledListeners.delete(listener); };
    }
    function getEnabledSnapshot() { return enabledSnapshot; }
    function setPluginEnabled(v) {
      setBool(ENABLED_KEY, v);
      var next = !!v;
      if (next === enabledSnapshot) return;
      enabledSnapshot = next;
      var pending = [];
      enabledListeners.forEach(function (l) { pending.push(l); });
      for (var i = 0; i < pending.length; i++) {
        try { pending[i](); } catch (e) { /* 单个订阅者异常不影响其余 */ }
      }
    }

    // ---------- resume-send 消费者：fork/reset 写 key，新会话 current 确认后读一次即删 ----------
    // 生产者三处（reset 父版本 / reset 空白会话 / confirmEdit fork）只写不读曾是死写：
    // 新会话打开时是空的，编辑文本被截断丢弃。此处在 list.current 翻到目标会话后消费一次。
    // 注意：本块在 factory 顶层、apply(ctx) 之外——不能直接用 ctx。会话服务用
    // 模块级 ctxSessionsRef（apply 时赋值），模型应用用模块级 modelSelApplyRef。
    var RESUME_PREFIX = "dsh-message-recall:resume-send:";
    var RESUME_TTL_MS = 5 * 60 * 1000;
    var resumeClaimed = {}; // 已消费的会话 id（防 subscribe 重复触发二次发送）
    var ctxSessionsRef = null; // apply 内赋值为 ctx.sessions
    var modelSelApplyRef = null; // apply 内赋值为 (sessionId, sel) => Promise<boolean>
    function readResume(targetId) {
      var raw = null;
      try { raw = localStorage.getItem(RESUME_PREFIX + targetId); } catch (e) { return null; }
      if (!raw) return null;
      try {
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.draftText !== "string") return null;
        if (typeof parsed.t === "number" && Date.now() - parsed.t > RESUME_TTL_MS) return null;
        return parsed;
      } catch (e) { return null; }
    }
    function clearResume(targetId) {
      try { localStorage.removeItem(RESUME_PREFIX + targetId); } catch (e) { /* ignore */ }
    }
    // 把「草稿已经写进目标输入框」这个进度标记回写进记录本身。
    // 必须持久化：每次 claimResume 都经 readResume 拿到新对象，内存标记跨不过认领边界；
    // 页面刷新更不能靠内存。不写回就会出现「重试时把用户手动改过的草稿又覆盖一次」。
    function markResumeDrafted(targetId) {
      var cur = readResume(targetId);
      if (!cur || cur.partial === true) return;
      cur.partial = true;
      try { localStorage.setItem(RESUME_PREFIX + targetId, JSON.stringify(cur)); } catch (e) { /* ignore */ }
    }
    // 用读时快照取目标会话的 inputActions（chat.node 的 inject 只产出源会话的面，
    // 不能拿旧会话的 actions 去写新会话的草稿）。scope 不存在时返回 null，由调用方重试。
    function inputActionsFor(targetId) {
      try {
        if (!ctxSessionsRef || typeof ctxSessionsRef.scope !== "function") return null;
        var scope = ctxSessionsRef.scope(targetId);
        if (!scope) return null;
        var conv = null;
        try { conv = scope.get("conversation"); } catch (eConv) { conv = null; }
        if (!conv || !conv.input || typeof conv.input.for !== "function") return null;
        var shell = conv.input.for(scope);
        return (shell && shell.actions) || null;
      } catch (e) { return null; }
    }
    // 就绪等待：ctxSessions.list 状态订阅优先，固定时延只作兜底。
    // 必须保留超时兜底——以下三种情况订阅永远不会触发：目标已就绪但列表快照引用未变
    // （订阅只在快照换引用时回调）、订阅源缺失或被卸载、目标永不出现。没有超时就会永久挂起。
    // 三条出口（就绪 / 超时 / 调用方取消）都会反注册订阅并清掉定时器，不泄漏。
    var WAIT_CURRENT_TIMEOUT_MS = 10000; // 原实现 100 次 ×100ms
    var WAIT_COMPOSER_TIMEOUT_MS = 5000; // 原实现 50 次 ×100ms
    function waitFor(predicate, timeoutMs, signal) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var unsub = null;
        var timer = null;
        var cleanup = function () {
          if (unsub) { try { unsub(); } catch (eU) { /* ignore */ } unsub = null; }
          if (timer !== null) { try { clearTimeout(timer); } catch (eT) { /* ignore */ } timer = null; }
          if (signal) { try { signal.removeEventListener("abort", onAbort); } catch (eR) { /* ignore */ } }
        };
        var onAbort = function () {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("wait-cancelled"));
        };
        var check = function () {
          if (settled) return;
          var ready = false;
          try { ready = !!predicate(); } catch (eP) { ready = false; }
          if (!ready) return;
          settled = true;
          cleanup();
          resolve(true);
        };
        if (signal) {
          if (signal.aborted) { onAbort(); return; }
          try { signal.addEventListener("abort", onAbort); } catch (eA) { /* ignore */ }
        }
        timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("wait-timeout"));
        }, timeoutMs);
        try {
          if (ctxSessionsRef && ctxSessionsRef.list && typeof ctxSessionsRef.list.subscribe === "function") {
            unsub = ctxSessionsRef.list.subscribe(check);
          }
        } catch (eS) { unsub = null; }
        check(); // 订阅不回调「当前已就绪」：先同步判一次，避免已经就绪还白等整段超时
      });
    }
    function currentIs(targetId) {
      var cur = null;
      try { cur = ctxSessionsRef ? ctxSessionsRef.list.getSnapshot().current : null; } catch (eCur) { cur = null; }
      return !!cur && cur === targetId;
    }
    function composerReady(targetId) {
      var ready = false;
      try { ready = !!inputActionsFor(targetId); } catch (eR) { ready = false; }
      return ready;
    }
    // 把一条 resume 写进目标会话输入框并提交；stagedDraft 发完后回填（底部草稿隔离保留）。
    // 回调契约（调用方据此决定是否删除待发送记录）：ok=true 仅在 ia.submit() 成功执行、
    // 未抛错那一刻给出——此前的任何失败（actions 缺失、setDraft 抛错、submit 抛错）都是
    // 「未被接受」，记录必须保留以便重试。不对 submit 抛错放宽语义：submit 抛错证明 agent
    // 没有收到这条消息，放宽会把「没发出去」当成「接受」直接吞掉草稿。
    // submit 前的 80ms 是原实现的固定延迟，属一次性提交节流而非就绪轮询，故保留。
    function deliverResume(targetId, resume, done) {
      var finished = function (ok, err) {
        try { if (typeof done === "function") done(ok, err); } catch (e) { /* ignore */ }
      };
      try {
        var ia = inputActionsFor(targetId);
        if (!ia || typeof ia.setDraft !== "function" || typeof ia.submit !== "function") { finished(false); return; }
        var submitted = false;
        var accept = function () {
          // 80ms 是原实现里 submit 前的固定节流：给 setDraft 落地到宿主 store 留一拍。
          // 它是提交节流而不是就绪轮询（不等任何「就绪」条件），保留。
          setTimeout(function () {
            if (submitted) return;
            submitted = true;
            try {
              ia.submit();
              log("info", "resume", "编辑文本已自动发送", { targetId: targetId });
              // 「明确接受」判定点：submit 已成功执行、未抛错。此处通知调用方删除待发送记录。
              finished(true);
              var staged = resume.stagedDraft;
              if (staged && (staged.text || (Array.isArray(staged.imageIds) && staged.imageIds.length > 0))) {
                setTimeout(function () {
                  try {
                    if (staged.text && typeof ia.setDraft === "function") ia.setDraft(staged.text);
                    var sImgs = Array.isArray(staged.imageIds) ? staged.imageIds : [];
                    if (sImgs.length > 0) addToComposer(ia, sImgs);
                    log("info", "resume", "第二阶段：底部暂存草稿及图片已回填", { hasText: !!staged.text, imgCount: sImgs.length });
                  } catch (eStg) { /* ignore */ }
                }, 160);
              }
            } catch (e) {
              log("error", "resume", "自动发送失败", { targetId: targetId, err: String(e && e.message ? e.message : e) });
              finished(false, e);
            }
          }, 80);
        };
        // 重试已有一次部分投递成功的记录时（resume.partial 已置位），草稿与图片已经在目标
        // 输入框里，重写会覆盖用户此刻可能已经手动改动的内容，所以只重试提交；
        // 首次投递照常写入，写成功即置位 partial，之后的失败重试就不再重复写。
        var skipDraft = !!resume.partial;
        var imgIds = Array.isArray(resume.imageIds) ? resume.imageIds : [];
        if (!skipDraft) {
          try { ia.setDraft(resume.draftText); } catch (eSet) { finished(false, eSet); return; }
          // 写成功即持久化进度：后续重试（含刷新后）只提交，不再覆盖用户可能已改动的草稿。
          resume.partial = true;
          markResumeDrafted(targetId);
        }
        if (imgIds.length > 0) { try { addToComposer(ia, imgIds); } catch (eAdd) { /* ignore */ } }
        var applySel = null;
        try { applySel = (resume.sel && modelSelApplyRef) ? modelSelApplyRef(targetId, resume.sel) : null; } catch (eSel) { applySel = null; }
        if (applySel && typeof applySel.then === "function") applySel.then(accept, accept);
        else accept();
      } catch (e) { finished(false, e); }
    }
    // 认领一条 resume：等 current 翻到目标、再等 composer 就绪，然后投递。
    // 不变式①（防重）：localStorage 记录是唯一的内容来源，且只在投递被明确接受后删除。
    //   一旦删除，后续任何再次认领都 readResume 为空直接返回——「成功即删」本身就是最可靠的
    //   防重，不依赖内存标记，因此刷新/多标签也不会重复发送。
    // 不变式②（可重试）：未成功时记录保留，并清掉 resumeClaimed 放行下一次认领；
    //   已经 setDraft 成功的部分投递靠 resume.partial 标记只重试提交，不重复写草稿。
    function claimResume(targetId) {
      if (!targetId || resumeClaimed[targetId]) return;
      var resume = readResume(targetId);
      if (!resume) return;
      resumeClaimed[targetId] = true;
      log("info", "resume", "认领待发送编辑文本", { targetId: targetId, len: resume.draftText.length });
      var release = function () { /** 放行下一次认领（订阅在每次列表变化时都会回调）。 */ resumeClaimed[targetId] = false; };
      waitFor(function () { return currentIs(targetId); }, WAIT_CURRENT_TIMEOUT_MS, null).then(function () {
        // 关键排序：current 翻转只说明消息区开始显示目标会话，不说明这次编辑的切换已经结算。
        // 先等切换结算，再等 composer 就绪，投递才落在「切换完成之后」——否则消息区会在
        // 新会话已可见、待发送文本尚未写进输入框的空窗里停留（实测可达 170ms 量级）。
        return settleSwitch(targetId);
      }).then(function () {
        // 新会话切进来后 composer 挂载需要一拍：等 inputActions 就绪再投递。
        return waitFor(function () { return composerReady(targetId); }, WAIT_COMPOSER_TIMEOUT_MS, null);
      }).then(function () {
        // 记录还在 ⇒ 上一次投递没被接受 ⇒ 若它已把草稿写进输入框，resume.partial 已随之落盘，
        // deliverResume 会据此跳过重写。标记的写入时机由 deliverResume 掌握（写成功即置位），
        // 所以即使写入阶段自身抛错，也只会让下一次重试重写草稿，不会漏掉首次写入。
        deliverResume(targetId, resume, function (ok) {
          // 残窗测量：从「消息区切到目标」到「文本被接受」的间隔。排序修好前这里应是
          // 170ms 量级（空窗可见），修好后应降到 composer 握手的一拍左右。
          var visibleAt = switchSettledAt[targetId];
          if (typeof visibleAt === "number") {
            log("info", "resume", "切换→接受残窗", { targetId: targetId, ok: ok, residualMs: Date.now() - visibleAt });
          }
          // 唯一删除点：投递被明确接受（submit 成功执行）。删除后任何再次认领都读不到内容，
          // 这就是不变式①的防重实现。
          if (ok) { clearResume(targetId); return; }
          release();
          log("warn", "resume", "投递未成功（待发送记录保留，可重试）", { targetId: targetId });
        });
      }, function (e) {
        release();
        var why = (e && e.message === "wait-timeout") ? "超时" : "等待被取消";
        log("warn", "resume", why + "，放弃投递（待发送记录保留，可重试）", { targetId: targetId });
      });
    }

    // ---------- 版本家族（< X > 翻页器）：以宿主登记的明确编辑关系为准 ----------
    // 侧栏稳定条目只合并明确登记的编辑版本：普通 fork 也有 parentId 父子关系，
    // 不能靠 parentId 推断（旧数据无明确标记时不自动合并）。
    // 关系由 host 经 storageDomain（recall_relations 域）持久化，client 经 /bubble/relations 同步，
    // 并经 ctx.uiWorkspace.registerRecallRows 发布给侧栏投影扩展。
    var RELATIONS_CACHE_KEY = "dsh-message-recall:relations-cache";
    var relationsCache = []; // 最近一次 /bubble/relations 全量（投影扩展的数据源）
    var relationsUnsub = null; // ctx.sessions.list 订阅（跨通道到达顺序由投影层协调：此处只刷新缓存）
    var recallRowsDisposer = null; // uiWorkspace.registerRecallRows 的释放函数
    function readRelationsCache() {
      if (relationsCache.length > 0) return relationsCache;
      try {
        var raw = localStorage.getItem(RELATIONS_CACHE_KEY);
        if (!raw) return [];
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) { return []; }
    }
    function writeRelationsCache(rows) {
      relationsCache = Array.isArray(rows) ? rows : [];
      try { localStorage.setItem(RELATIONS_CACHE_KEY, JSON.stringify(relationsCache)); } catch (e) { /* ignore */ }
    }
    function publishRecallRows() {
      try {
        var rows = readRelationsCache().map(function (r) {
          return { rowId: r.rowId, targetSessionId: r.targetSessionId, memberSessionIds: r.memberSessionIds.slice() };
        });
        if (ctxUiWorkspaceRef && typeof ctxUiWorkspaceRef.registerRecallRows === "function") {
          if (recallRowsDisposer) { try { recallRowsDisposer(); } catch (eD) { /* ignore */ } recallRowsDisposer = null; }
          if (rows.length > 0) recallRowsDisposer = ctxUiWorkspaceRef.registerRecallRows("dsh-message-recall", rows);
        }
      } catch (e) { /* 投影扩展不可用时保持单行显示 */ }
    }
    function refreshRelations() {
      fetch("/bubble/relations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        keepalive: true
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.ok && Array.isArray(d.relations)) {
          writeRelationsCache(d.relations);
          publishRecallRows();
        }
      }).catch(function () { /* 读失败保持缓存 */ });
    }
    function registerRelation(rowId, targetSessionId, memberSessionIds) {
      return fetch("/bubble/relations/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rowId: rowId, targetSessionId: targetSessionId, memberSessionIds: memberSessionIds }),
        keepalive: true
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.ok) refreshRelations();
        return !!(d && d.ok);
      }).catch(function () { return false; });
    }
    function retargetRelation(rowId, targetSessionId) {
      return fetch("/bubble/relations/retarget", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rowId: rowId, targetSessionId: targetSessionId }),
        keepalive: true
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.ok) refreshRelations();
        return !!(d && d.ok);
      }).catch(function () { return false; });
    }
    function relationOfSession(sessionId) {
      var rows = readRelationsCache();
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].memberSessionIds.indexOf(sessionId) >= 0) return rows[i];
      }
      return null;
    }
    // 为 fork 子会话预分配身份（无痕替换下"发布前登记归属"的前提）。
    // 为什么要自己铸造：宿主 fork 子会话一旦创建就会同步进入 client 列表，且列表发布同样由
    // 宿主的 api-session/added 帧驱动——client 无法推迟它。因此"先 fork 再登记关系"必然留下
    // 一段新行可见的空窗。改为本插件先造好 id、先用它登记关系、再拿这个 id 去 fork：
    // 子会话出现时投影已经命名了它，直接折叠进原条目，不再单独成行。
    // 格式与宿主 session-<uuid> 一致；ctxSessions.fork 新增的 childSessionId 参数承载它。
    function generateUuidV4() {
      try {
        if (typeof crypto !== "undefined") {
          if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
          if (typeof crypto.getRandomValues === "function") {
            var bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
            bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
            var hex = [];
            for (var i = 0; i < 16; i++) hex.push((bytes[i] + 0x100).toString(16).slice(1));
            return hex.slice(0, 4).join("") + "-" + hex.slice(4, 6).join("") + "-" + hex.slice(6, 8).join("")
              + "-" + hex.slice(8, 10).join("") + "-" + hex.slice(10, 16).join("");
          }
        }
      } catch (eRnd) { /* 落到下面的时间戳兜底 */ }
      // 无 WebCrypto 的极端环境：时间戳 + 随机段。碰撞概率远低于"没有编辑功能"的代价。
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        var v = c === "x" ? r : ((r & 0x3) | 0x8);
        return v.toString(16);
      });
    }
    function mintChildSessionId() {
      return "session-" + generateUuidV4();
    }
    // fork 子会话身份核对：只有宿主确实按预分配 id 创建时（新宿主），关系才与真实子会话对齐。
    // 旧宿主（内嵌 client 尚未带上 childSessionId）会回落到自生成 id，此处负责把关系改挂到
    // 真实子会话上，避免留下一条指向不存在会话的关系记录。
    function reconcileForkChild(rowId, expectedId, actualId, sourceId) {
      if (!actualId) return Promise.resolve(false);
      if (actualId === expectedId) return Promise.resolve(true);
      log("warn", "edit", "宿主未采用预分配子会话 id（旧宿主），关系改挂真实子会话", {
        rowId: rowId, expected: expectedId, actual: actualId
      });
      var rel = null;
      try { rel = relationOfSession(expectedId); } catch (eRel) { rel = null; }
      var members = rel && Array.isArray(rel.memberSessionIds) ? rel.memberSessionIds.slice() : [sourceId];
      for (var i = members.length - 1; i >= 0; i--) {
        if (members[i] === expectedId) members.splice(i, 1);
      }
      if (members.indexOf(actualId) < 0) members.push(actualId);
      return registerRelation(rowId, actualId, members);
    }
    // 版本家族取数的唯一权威：宿主登记的明确编辑关系。翻页器与设置卡都走这里。
    //
    // 为什么不再回退 lineage：`parentId` 只表示「从哪个会话 fork 出来」，用户主动 fork
    // 与编辑重发产生的是同一种父子边。DSH 侧的可判别字段（调研结论，2026-09 代码为准）：
    //  - `SessionSummary.origin` 只有 `'subagent'` 一个取值，没有「编辑 fork」标记；
    //  - 官方用户入口 `ctx.uiWorkspace.forkSession` → `sessions.fork({ increaseTitle: true })`
    //    （packages/api/session-controller/src/client/sessions/service.ts:428-453）会给子会话标题
    //    追加 `(1)`/`(2)`，而本插件编辑重发调用 fork 时不传 `increaseTitle`；
    //  - 但 `increaseTitle` 依赖源会话已有 `title`：无 title 时 fork 不加后缀；用户事后重命名
    //    会覆盖后缀；`sessions.fork` 也在别处被调用。因此标题后缀**不足以**可靠判别。
    // 结论「无法可靠区分」，按「宁可少显示版本家族，也不要把用户主动 fork 误当编辑版本」取
    // 最保守回退：没有登记关系时翻页器不显示家族。影响：登记失败或旧版本遗留的编辑家族不再
    // 出现在翻页器/设置卡里；但侧栏稳定条目本来就只认登记关系，所以两者显示口径一致，
    // 不会再出现「侧栏一行、翻页器却认为有两版」的分裂。
    function familyOfRelation(sessionId) {
      try {
        var rel = relationOfSession(sessionId);
        if (!rel) return null;
        var members = Array.isArray(rel.memberSessionIds) ? rel.memberSessionIds : [];
        // 顺序即版本先后：registerRelation 只把新版本 push 到末尾，retargetRelation 不改成员顺序。
        var versions = members.slice();
        if (versions.indexOf(sessionId) < 0) return null; // 关系里没有当前会话 → 不认领这个家族
        if (versions.length < 2) return null;
        var index = versions.indexOf(sessionId);
        return { rootId: rel.rowId, versions: versions, index: index >= 0 ? index : 0, targetSessionId: rel.targetSessionId };
      } catch (e) { return null; }
    }
    
// ---------- 滚动锚定：已交还官方 chatScrollPositions（按会话原生保存/恢复滚动位，review #4 删自建轮子） ----------

    // ---------- 编辑附件保留（M4 闭环）：历史图片附件 → 官方草稿附件 ----------
    // 流程：resolveImageCompat 取会话授权 URL → fetch → File → draftsFor(createDrafts) → addToComposer(addAttachments)
    async     function rebuildDraftAttachments(attachmentRefs, props, sessionId, recordPending) {
      var added = 0;
      if (!attachmentRefs || !Array.isArray(attachmentRefs) || attachmentRefs.length === 0) return added;
      try {
        var files = [];
        for (var i = 0; i < attachmentRefs.length; i++) {
          var ref = attachmentRefs[i];
          if (!ref || typeof ref.attachmentId !== "string") { log("warn", "attach", "附件引用缺 attachmentId", { i: i }); continue; }
          try {
            // v2.4.0：resolveImageCompat 双宿主兼容（rc.2 resolveImage / rc.1 imageUrl+loadImage）
            var url = await resolveImageCompat(sessionId, ref, props);
            if (!url) { log("warn", "attach", "resolveImage 返回空 URL", { attachmentId: ref.attachmentId }); continue; }
            var resp = await fetch(url);
            if (!resp.ok) { log("warn", "attach", "fetch 失败", { status: resp.status, url: String(url).slice(0, 80) }); continue; }
            var blob = await resp.blob();
            var name = typeof ref.name === "string" && ref.name ? ref.name : "attachment." + (ref.mediaType === "image/png" ? "png" : (ref.mediaType === "image/jpeg" || ref.mediaType === "image/jpg" ? "jpg" : "img"));
            // 写缓存，供后续重发复用
            files.push(new File([blob], name, { type: ref.mediaType || blob.type || "application/octet-stream" }));
            log("info", "attach", "已构造 File 并写缓存", { name: name, type: ref.mediaType || blob.type, size: blob.size });
          } catch (e) { log("warn", "attach", "重建单个附件失败", { attachmentId: ref.attachmentId, err: String(e && e.message ? e.message : e) }); }
        }
        if (files.length > 0 && draftsAvailable() && props.inputActions) {
          try {
            var images = draftsFor(sessionId, files);
            if (images && images.length > 0) {
              var ids = images.map(function (img) { return img.id; });
              var addOk = addToComposer(props.inputActions, ids);
              if (recordPending) { for (var pi = 0; pi < ids.length; pi++) pendingAttachIds.push(ids[pi]); }
              log("info", "attach", "createDraftImages+addImages 成功", { count: images.length, addOk: addOk });
              added = images.length;
            } else {
              log("warn", "attach", "createDraftImages 返回空数组", { filesLen: files.length });
            }
          } catch (e2) {
            log("error", "attach", "createDraftImages 抛错（MIME 校验等）", { filesLen: files.length, err: String(e2 && e2.message ? e2.message : e2), types: files.map(function (f) { return f.type; }) });
          }
        } else {
          if (files.length === 0) log("warn", "attach", "无可重建文件（缓存未命中+resolveImage/fetch 均失败）", { refsLen: attachmentRefs.length });
          else log("warn", "attach", "缺草稿能力或输入框接口", { hasDrafts: draftsAvailable(), hasInput: !!(props.inputActions), reason: lastDraftsError });
        }
      } catch (e) { log("error", "attach", "rebuildDraftAttachments 外层异常", { err: String(e && e.message ? e.message : e) }); }
      return added;
    }
    // ---------- 图片桥接（review #3）：跨会话传递交官方全局 draftAttachments 单例，只记 imageIds ----------
    var pendingAttachIds = [];
    var cachedEditMsg = {}; // 消息图refs缓存（渲染时填充，confirmEdit 异步回调读取） // 撤回确认时重建到输入框的图 id（× 取消时需移除）
    var latestInputImageIds = []; // 输入框当前图 id 镜像（UserBubbleView 渲染时喂入；发送时据此搬运）
    // ---------- 调试 API：撤回条实时调参（调试模式 dsh-message-recall:debug=1 时挂 window.__dshMessageRecall.bar） ----------
    // 用法：__dshMessageRecall.bar.get() 看现状（含计算样式）；.set({inset,size,radius,bg}) 实时调（立即生效，不落盘）；
    // .diagnose() 扫全样式表找压圆角的规则；.export() 导出 JSON（发给我固化进代码）。纯内存，刷新即还原。
    var barTune = { inset: null, size: null, radius: null, bg: null };
    function barApplyCircTune(xCirc) {
      // 圆钮调参重放：bar 因官方重渲染被重建时，placeBar 调用此函数恢复 size（inset 由 placeBar 自身处理）。
      // SVG 圆形底终稿后 radius/bg 调参退役（真圆不可变形；底色走 fill var 由 hover CSS 管）
      if (!xCirc) return;
      try {
        if (barTune.size !== null) {
          xCirc.style.width = barTune.size + "px";
          xCirc.style.height = barTune.size + "px";
          var svgEl = xCirc.querySelector("svg");
          if (svgEl) { svgEl.setAttribute("width", String(barTune.size)); svgEl.setAttribute("height", String(barTune.size)); svgEl.setAttribute("viewBox", "0 0 " + barTune.size + " " + barTune.size); }
        }
      } catch (eT) { /* ignore */ }
    }
    function barApplyTune() {
      try {
        var barEl = document.querySelector('[data-dsh-message-recall="recall-bar"]');
        if (!barEl) return "recall-bar 不在 DOM（需先进入撤回态）";
        var xCirc = barEl.querySelector(".dbe-recall-x-circ");
        var cardEl = document.querySelector('[data-composer-card="true"]');
        var firstImg = null;
        try { firstImg = cardEl ? cardEl.querySelector("img") : null; } catch (eI) { /* ignore */ }
        // inset 不在此处直接写 —— placeBar（effect 闭包）会在 MutationObserver 触发时无条件重写 padding，
        // 直接写会被瞬间覆盖（"set 了但没变化"的根因）。改为派发事件让 placeBar 用最新 barTune 重算。
        if (barTune.inset !== null) {
          try { document.dispatchEvent(new CustomEvent("dsh-message-recall:bar-tune")); } catch (eE) { /* ignore */ }
        }
        if (xCirc) barApplyCircTune(xCirc);
        return "applied: " + JSON.stringify(barTune);
      } catch (eA) { return "ERR: " + (eA && eA.message); }
    }
    function barDiagnose() {
      // 找出所有命中 .dbe-recall-x / -circ 且带 border-radius 的规则（含 !important），定位"压圆"真凶
      var hits = [];
      try {
        for (var si = 0; si < document.styleSheets.length; si++) {
          var sheet = document.styleSheets[si];
          var rules; try { rules = sheet.cssRules; } catch (eC) { continue; }
          if (!rules) continue;
          for (var ri = 0; ri < rules.length; ri++) {
            var t = rules[ri].cssText || "";
            if (t.indexOf("dbe-recall-x") !== -1 && t.indexOf("radius") !== -1) hits.push("sheet" + si + ": " + t.slice(0, 220));
          }
        }
      } catch (eD) { hits.push("ERR: " + (eD && eD.message)); }
      var out = { hits: hits };
      try {
        var c = document.querySelector(".dbe-recall-x-circ");
        if (c) {
          var cs = getComputedStyle(c);
          out.computed = { borderRadius: cs.borderRadius, width: cs.width, height: cs.height, display: cs.display, boxSizing: cs.boxSizing };
        } else out.computed = "circ 不在 DOM";
      } catch (eG) { out.computed = "ERR: " + (eG && eG.message); }
      return out;
    }
    // 图片桥接：旧会话 live 时把消息附件取成字节，注册进官方全局 draftAttachments 单例（不进输入框），
    // 返回新草稿 id 列表——供新会话 resume 时 addImages 使用（撤回键/气泡编辑两条路径共用）。
    async function bridgeSessionImages(sessionId, refs) {
      var out = [];
      try {
        if (!refs || !refs.length || !ctxConversationRef || !draftsAvailable()) return out;
        var files = [];
        for (var i = 0; i < refs.length; i++) {
          var ref = refs[i];
          if (!ref || typeof ref.attachmentId !== "string") { log("warn", "attach", "桥接跳过：缺 attachmentId", { i: i }); continue; }
          try {
            var url = await resolveImageCompat(sessionId, ref, null);
            if (!url) { log("warn", "attach", "桥接空 URL", { attachmentId: ref.attachmentId }); continue; }
            var resp2 = await fetch(url);
            if (!resp2.ok) { log("warn", "attach", "桥接 fetch 失败", { status: resp2.status }); continue; }
            var blob = await resp2.blob();
            var nm = (ref.name && typeof ref.name === "string") ? ref.name : ("attachment." + (ref.mediaType === "image/png" ? "png" : (ref.mediaType === "image/jpeg" || ref.mediaType === "image/jpg" ? "jpg" : "img")));
            files.push(new File([blob], nm, { type: ref.mediaType || blob.type || "application/octet-stream" }));
          } catch (eOne) { log("warn", "attach", "桥接单个附件失败", { attachmentId: ref.attachmentId, err: String(eOne && eOne.message ? eOne.message : eOne) }); }
        }
        if (files.length > 0) {
          var imgs = draftsFor(sessionId, files);
          out = imgs.map(function (im) { return im.id; });
          log("info", "attach", "图片桥接完成（进官方单例）", { count: out.length });
        }
      } catch (e) { log("warn", "attach", "bridgeSessionImages 异常", { err: String(e && e.message ? e.message : e) }); }
      return out;
    }
    // ---------- 编辑态图片持久化辅助（bug② 刷新恢复用）：File ↔ dataURL ----------
    function fileToDataUrl(file) {
      return new Promise(function (resolve, reject) {
        try {
          var fr = new FileReader();
          fr.onload = function () { resolve(String(fr.result)); };
          fr.onerror = function () { reject(fr.error || new Error("file-read-failed")); };
          fr.readAsDataURL(file);
        } catch (e) { reject(e); }
      });
    }
    function dataUrlToFile(dataUrl, name) {
      var parts = String(dataUrl).split(",");
      var mimeMatch = parts[0].match(/:(.*?);/);
      var mime = (mimeMatch && mimeMatch[1]) || "image/png";
      var bstr = atob(parts[1] || "");
      var u8 = new Uint8Array(bstr.length);
      for (var i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
      return new File([u8], name || "image." + (mime.split("/")[1] || "png"), { type: mime });
    }

    var ctxConversationRef = null; // apply 时注入 conversation 服务
    var ctxUiConversationRef = null; // v2.4.0: dsh 0.1.2 的 uiConversation 服务（弱引用；0.1.1-rc.2 无此服务时为 null）
    var ctxUiWorkspaceRef = null;    // v2.4.0: dsh 0.1.2 的 uiWorkspace 服务（弱引用）
    /** v2.4.0：图片 URL 解析双宿主兼容——props.loadImage（两代都有）/ rc.2 resolveImage / rc.1 uiConversation.imageUrl */
    async function resolveImageCompat(sessionId, ref, props) {
      if (ctxUiConversationRef && typeof ctxUiConversationRef.imageUrl === "function") {
        try { return await ctxUiConversationRef.imageUrl(sessionId, ref); } catch (e3) { /* ignore */ }
      }
      return null;
    }

    /**
     * 草稿附件 API 跨宿主兼容（v2.5.3）：
     *   rc.2/0.1.x 现行：conversation.createDrafts(sessionId, files) -> [{id, previewUrl}]
     *                      inputFacade.addAttachments(ids)
     *   v2.4 及更早：     conversation.createDraftImages(files) / inputActions.addImages(ids)
     * 旧方法名在当前 dsh 上已不存在，此前图片链因此长期静默失效（日志中零条 attach 记录）。
     */
    var lastDraftsError = null; // 最近一次草稿创建失败原因（供编辑态可见提示，不静默降级）
    var draftsErrorSubs = [];

    /** @returns 当前草稿服务是否可用。 */
    function draftsAvailable() {
      return !!(ctxConversationRef && (typeof ctxConversationRef.createDrafts === "function"
        || typeof ctxConversationRef.createDraftImages === "function"));
    }

    /** 记录/清除草稿失败原因并广播，让编辑态显示可见提示而不是静默丢图。 */
    function setDraftsError(reason) {
      var next = reason || null;
      if (next === lastDraftsError) return;
      lastDraftsError = next;
      for (var di = 0; di < draftsErrorSubs.length; di++) {
        try { draftsErrorSubs[di](); } catch (eSub) { /* ignore */ }
      }
    }


    /** 创建草稿附件（兼容两种宿主命名）。 @returns 草稿描述数组；失败返回空数组并记录原因。 */
    function draftsFor(sessionId, files) {
      if (!ctxConversationRef) {
        setDraftsError("图片草稿服务不可用（宿主未提供 conversation）");
        return [];
      }
      try {
        if (typeof ctxConversationRef.createDrafts === "function") {
          var modern = ctxConversationRef.createDrafts(sessionId, files);
          setDraftsError(null);
          return modern || [];
        }
        if (typeof ctxConversationRef.createDraftImages === "function") {
          var legacy = ctxConversationRef.createDraftImages(files);
          setDraftsError(null);
          return legacy || [];
        }
        setDraftsError("当前宿主没有可用的图片草稿接口");
        return [];
      } catch (err) {
        setDraftsError("图片未能加入草稿：" + String(err && err.message ? err.message : err));
        return [];
      }
    }

    /** 把草稿附件交给当前会话输入框（兼容 addAttachments / addImages）。 */
    function addToComposer(inputApi, ids) {
      if (!inputApi || !ids || ids.length === 0) return false;
      try {
        if (typeof inputApi.addAttachments === "function") return inputApi.addAttachments(ids) !== false;
        if (typeof inputApi.addImages === "function") return inputApi.addImages(ids) !== false;
      } catch (eAdd) { /* 失败按未加入处理 */ }
      return false;
    }


    // ---------- 语义化版本比较（1.2.4 < 1.3.0；缺失段视为 0） ----------
    function versionGt(a, b) {
      var pa = String(a || "0").split(".").map(function (x) { return parseInt(x, 10) || 0; });
      var pb = String(b || "0").split(".").map(function (x) { return parseInt(x, 10) || 0; });
      var len = Math.max(pa.length, pb.length);
      for (var vi = 0; vi < len; vi++) {
        var av = pa[vi] || 0;
        var bv = pb[vi] || 0;
        if (av > bv) return true;
        if (av < bv) return false;
      }
      return false;
    }

    // ---------- dsh 宿主版本比较（v2.4.0） ----------
    var MIN_DSH_VERSION = "0.1.2-rc.1";
    var MAX_TESTED_DSH_VERSION = "0.1.2-rc.1";
    function dshVerRank(v) {
      var m = String(v || "").trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(alpha|rc)\.(\d+))?$/);
      if (!m) return null;
      return { core: [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)], pre: m[4] ? (m[4] === "rc" ? 2 : 1) : 3, preNum: m[5] ? parseInt(m[5], 10) : 0 };
    }
    function cmpDsh(a, b) {
      var va = dshVerRank(a), vb = dshVerRank(b);
      if (!va || !vb) return 0;
      for (var i = 0; i < 3; i++) { if (va.core[i] !== vb.core[i]) return va.core[i] - vb.core[i]; }
      if (va.pre !== vb.pre) return va.pre - vb.pre;
      return va.preNum - vb.preNum;
    }

    function getChatSnapshot(props) {
      try {
        if (props && typeof props.useChat === "function") return props.useChat(function (s) { return s; });
        if (props && typeof props.useSession === "function") {
          var s = props.useSession(function (x) { return x; });
          return s && s.chat ? s.chat : s;
        }
      } catch (eSnap) { /* ignore */ }
      return null;
    }

    // ---------- pending store（按会话；内存缓存 + localStorage 持久化 + 订阅） ----------
    var PENDING_PREFIX = "dsh-message-recall:pending:";
    var pendingCache = {};
    var pendingListeners = [];
    // review M9：跨标签页同步——另一标签页写入/清除 pending 时刷新本地缓存并通知订阅者
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("storage", function (e) {
        try {
          if (!e.key || e.key.indexOf(PENDING_PREFIX) !== 0) return;
          pendingCache[e.key.slice(PENDING_PREFIX.length)] = null; // 强制重读
          for (var li = 0; li < pendingListeners.length; li++) {
            try { pendingListeners[li](); } catch (err) { /* ignore */ }
          }
        } catch (err) { /* ignore */ }
      });
    }
    function loadPendingFromStorage(sessionId) {
      try { var raw = localStorage.getItem(PENDING_PREFIX + sessionId); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
    }
    function readPending(sessionId) {
      if (!(sessionId in pendingCache)) pendingCache[sessionId] = loadPendingFromStorage(sessionId);
      return pendingCache[sessionId];
    }
    function writePending(sessionId, p) {
      pendingCache[sessionId] = p;
      try {
        if (p === null) {
          localStorage.removeItem(PENDING_PREFIX + sessionId);
          // 处理完成（发送/取消/编辑确定）→ 删除自动备份（无感）
          try {
            fetch("/bubble/backup/delete", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId: sessionId }),
              keepalive: true
            }).catch(function () { /* 静默 */ });
          } catch (e) { /* 静默 */ }
        } else {
          localStorage.setItem(PENDING_PREFIX + sessionId, JSON.stringify(p));
        }
      } catch (e) { /* 静默 */ }
      var ls = pendingListeners.slice();
      for (var i = 0; i < ls.length; i++) { try { ls[i](); } catch (e) { /* ignore */ } }
    }
    function subscribePending(fn) {
      pendingListeners.push(fn);
      return function () { var i = pendingListeners.indexOf(fn); if (i !== -1) pendingListeners.splice(i, 1); };
    }
    function usePending(sessionId) {
      return React.useSyncExternalStore(subscribePending, function () { return readPending(sessionId); });
    }


    function extractText(content) {
      var parts = [];
      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          var b = content[i];
          if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
        }
      }
      return parts.join("\n");
    }

    // 官方同款 contentParts：把消息 content 拆为 {text, images, rest}（图片附件用于渲染缩略图）
    function contentParts(content) {
      var texts = [];
      var images = [];
      var rest = [];
      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          var b = content[i];
          if (b && b.type === "text" && typeof b.text === "string") texts.push(b.text);
          else if (b && b.type === "image" && b.attachment !== void 0) images.push({ attachment: b.attachment });
          else rest.push(b);
        }
      }
      return { text: texts.join(""), images: images, rest: rest };
    }

    // 渲染消息图片缩略图：直调官方 renderMessageImages（官方 ImageGallery：大图/宫格/lightbox/重试）。
    // 方法论 review #1：chat.node 注入必带该 prop，自绘 <img> 兜底属重复造轮子——已删；失败 warn 不静默。
    function renderMessageImagesCompat(images, props) {
      if (!images || images.length === 0) return null;
      if (!props || typeof props.renderMessageImages !== "function") {
        log("warn", "attach", "renderMessageImages prop 缺失（官方注入面变化？），图片无法渲染");
        return null;
      }
      try { return props.renderMessageImages({ images: images, align: "end" }); }
      catch (e) { log("warn", "attach", "官方图片渲染抛错", { err: String(e && e.message ? e.message : e) }); return null; }
    }

    /**
     * 原图放大预览（甲方案：照官方 ui-attachment/src/ImageLightbox.tsx 复刻）。
     *
     * 为什么不直接复用官方组件：ui-attachment 的 client 入口刻意不导出任何 React 值
     * （"without exporting React components as package values"），插件规范也禁止
     * 功能插件之间 import 值。故此处按官方实现等价重写，视觉取值全部对齐官方样式表：
     * 遮罩 = bg-mask-1 + mask-blur、图 = 最大 1600px/视口高-80px 圆角 12px、
     * 关闭键 = 固定右上 36px 圆钮 + IconCloseOutline16。
     *
     * 行为同样对齐官方：Escape / 点遮罩 / 点关闭键关闭，卸载时把焦点还给打开它的元素。
     */
    function ImageLightbox(props) {
      var closeRef = React.useRef(null);
      var restoreRef = React.useRef(null);
      React.useEffect(function () {
        restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (closeRef.current) closeRef.current.focus();
        function onKeyDown(event) { if (event.key === "Escape") props.onClose(); }
        window.addEventListener("keydown", onKeyDown);
        return function () {
          window.removeEventListener("keydown", onKeyDown);
          if (restoreRef.current) restoreRef.current.focus();
        };
      }, [props.onClose]);
      return ReactDOM.createPortal(
        React.createElement(
          "div",
          {
            role: "dialog",
            "aria-modal": "true",
            "aria-label": props.dialogLabel,
            style: { position: "fixed", inset: "0", zIndex: 1000, display: "grid", placeItems: "center", padding: "40px" }
          },
          React.createElement("div", {
            "aria-hidden": "true",
            onMouseDown: props.onClose,
            style: {
              position: "absolute", inset: "0",
              background: "var(--dsw-alias-bg-mask-1)",
              backdropFilter: "var(--dsw-mask-blur)",
              WebkitBackdropFilter: "var(--dsw-mask-blur)"
            }
          }),
          React.createElement("img", {
            src: props.src,
            alt: props.alt,
            style: {
              position: "relative",
              maxWidth: "min(100%, 1600px)",
              maxHeight: "calc(100vh - 80px)",
              objectFit: "contain",
              borderRadius: "12px",
              background: "var(--dsw-specific-input-major)",
              boxShadow: "var(--dsw-shadow-lv3)"
            }
          }),
          React.createElement(
            "button",
            {
              ref: closeRef,
              type: "button",
              "aria-label": props.closeLabel,
              onClick: props.onClose,
              style: {
                position: "fixed", top: "20px", right: "20px", zIndex: 1,
                display: "grid", placeItems: "center",
                width: "36px", height: "36px",
                border: "0.5px solid var(--dsw-alias-border-l2-darkmode-thin)",
                borderRadius: "999px",
                background: "var(--dsw-specific-input-major)",
                color: "var(--dsw-alias-label-primary)",
                cursor: "pointer"
              }
            },
            React.createElement(IconCloseOutline16, { size: 16 })
          )
        ),
        document.body
      );
    }


    function actionButton(title, ariaLabel, onClick, children, dataAttr) {
      var bs = 34;
      return React.createElement("button", {
        type: "button",
        title: title,
        "aria-label": ariaLabel,
        "data-dsh-message-recall": dataAttr || undefined,
        style: {
          border: "none",
          background: "transparent",
          cursor: "pointer",
          width: bs,
          height: bs,
          padding: 0,
          borderRadius: "8px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center"
        },
        onMouseEnter: function (e) { e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.1))"; },
        onMouseLeave: function (e) { e.currentTarget.style.background = "transparent"; },
        onClick: onClick
      }, children);
    }

    /**

    /** 时间格式化（对齐官方 formatMessageClock）：今天 HH:MM；同年 M/D HH:MM；跨年 Y/M/D HH:MM。 */
    function pad2(n) { return n < 10 ? "0" + n : "" + n; }
    function formatClock(time) {
      if (typeof time !== "number" || !isFinite(time)) return "";
      var d = new Date(time);
      var n = new Date();
      var clock = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
      if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return clock;
      if (d.getFullYear() === n.getFullYear()) return (d.getMonth() + 1) + "/" + d.getDate() + " " + clock;
      return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + clock;
    }

    /**
     * 统计当前消息之后的内容条数。
     * seqField: "seq"（legacy nodes）或 "anchorSeq"（chat store）。
     * onlyUser: 仅统计用户提问消息（kind === "user"），即「撤回提示统计仅包含用户提问语句」开关。
     */
    function countContentAfter(nodes, anchorSeq, seqField, onlyUser) {
      var field = seqField || "seq";
      var n = 0;
      if (!Array.isArray(nodes)) return n;
      for (var i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        if (nd === null || typeof nd !== "object") continue;
        var s = nd[field];
        if (typeof s !== "number" || s <= anchorSeq) continue;
        if (nd.kind === "turn-tail") continue;
        if (onlyUser && nd.kind !== "user") continue;
        n++;
      }
      return n;
    }

    /** 撤回提示的统计口径：仅用户提问语句（固定行为，不再提供调节项）。 */
    var STAT_ONLY_USER = true;


    // ---------- 设置卡片（设置 → 插件 → 插件配置；中英日三语） ----------
/** 界面文案（单语）。原三语字典的英文/日文值本就是中文，多语机制已移除。 */
    var TEXT = {
      title: "MessageRecall",
      subtitle: "简单易用的撤回重编辑",
      expand: "展开",
      collapse: "收起",
      pluginEnable: "启用 MessageRecall",
      attachWarning: "此消息含无法保留的内容（非图片附件），编辑重发后可能丢失",
      pagerTitle: "版本切换（撤回/编辑重发）",
      pagerPrev: "上一个版本",
      pagerNext: "下一个版本",
      confirm: "确定",
      cancel: "取消",
      copied: "已复制",
      copy: "复制",
      emptyMsg: "（空消息）",
      clickEdit: "点击编辑",
      errGeneric: "操作失败，请重试",
      errMessagePending: "这条消息还没开始处理（尚未进入回合记录），现在撤回会把原消息带到新会话重发。请等它处理完这一回合后再撤回。",
      resetNotice: "对话处于半截状态，已重置——正在回到上一次模型回复处（或空白新对话）",
      currentVersion: "当前版本",
      checkUpdate: "检查更新",
      checking: "检查中…",
      upToDate: "已是最新版本",
      newVersion: "发现新版本 v{ver}",
      updateNow: "更新",
      updating: "更新中…",
      updateDone: "更新完成——重启 dsh web 后生效",
      updateFailed: "更新失败，请稍后重试",
      autoCheckUpdate: "每日检查更新（发现新版本时提示）",
      dshLowWarning: "当前 dsh（{cur}）低于本插件要求的最低版本（{min}）——请先升级 dsh：",
      dshNewNotice: "当前 dsh（{cur}）较新，本插件的适配评估中，如遇异常请回退 dsh 或关注更新",
      copyUpgradeCmd: "复制升级命令",
      dzFull: "拖入此处添加图片至正在编辑的消息",
      openOriginal: "查看原图",
      closeOriginal: "关闭原图预览",
      imageOriginal: "原图预览",
      removeImage: "移除图片",
    };
    /** 设置卡片：注册进 settings.plugin.item（设置 → 插件 → 插件配置）。 */
    function MessageRecallSettingsCard(props) {
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      // —— 更新状态（检查/执行；每日检测开关默认关） ——
      var sUpdateVer = React.useState("");
      var updateVer = sUpdateVer[0];
      var setUpdateVer = sUpdateVer[1];
      var sDshVer = React.useState(null);
      var dshVer = sDshVer[0];
      var setDshVer = sDshVer[1];
      var sUpdateMsg = React.useState("");
      var updateMsg = sUpdateMsg[0];
      var setUpdateMsg = sUpdateMsg[1];
      var sUpdateAvail = React.useState("");
      var updateAvailableVer = sUpdateAvail[0];
      var setUpdateAvailableVer = sUpdateAvail[1];
      var sChecking = React.useState(false);
      var updateChecking = sChecking[0];
      var setUpdateChecking = sChecking[1];
      var sUpdating = React.useState(false);
      var updateUpdating = sUpdating[0];
      var setUpdateUpdating = sUpdating[1];
      var sAutoCheck = React.useState(getBool("dsh-message-recall:autoCheckUpdate", false));
      var autoCheckOn = sAutoCheck[0];
      var setAutoCheckOn = sAutoCheck[1];
      function doCheckUpdate() {
        setUpdateChecking(true);
        setUpdateMsg("");
        fetch("/bubble/check-update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
          keepalive: true
        }).then(function (r) { return r.json(); }).then(function (d) {
          setUpdateChecking(false);
          if (!d || !d.ok) { setUpdateMsg(TEXT.updateFailed); return; }
          setUpdateVer(d.current || "?");
          setDshVer(typeof d.dshVersion === "string" ? d.dshVersion : null);
          if (d.latest && versionGt(d.latest, d.current || "0")) {
            setUpdateAvailableVer(d.latest);
            try { localStorage.setItem("dsh-message-recall:updateAvailable", "1"); } catch (e) { /* ignore */ }
          } else {
            setUpdateAvailableVer("");
            setUpdateMsg(TEXT.upToDate);
            try { localStorage.removeItem("dsh-message-recall:updateAvailable"); } catch (e) { /* ignore */ }
          }
        }).catch(function () { setUpdateChecking(false); setUpdateMsg(TEXT.updateFailed); });
      }
      function doUpdatePlugin() {
        if (!updateAvailableVer) return;
        setUpdateUpdating(true);
        fetch("/bubble/update-plugin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
          keepalive: true
        }).then(function (r) { return r.json(); }).then(function (d) {
          setUpdateUpdating(false);
          if (d && d.ok) {
            setUpdateMsg(TEXT.updateDone);
            setUpdateAvailableVer("");
            try { localStorage.removeItem("dsh-message-recall:updateAvailable"); } catch (e) { /* ignore */ }
          } else {
            setUpdateMsg(TEXT.updateFailed);
          }
        }).catch(function () { setUpdateUpdating(false); setUpdateMsg(TEXT.updateFailed); });
      }
      // 展开折叠时无感触发一次检查（5 分钟节流，防频繁展开刷请求）；
      // 每日检查开关开启时，即使不展开也会按天自动检测
      React.useEffect(function () {
        if (!open) return;
        var now = Date.now();
        var lastCheck = 0;
        try { lastCheck = parseInt(localStorage.getItem("dsh-message-recall:lastUpdateCheckTs") || "0", 10) || 0; } catch (e) { /* ignore */ }
        if (now - lastCheck < 5 * 60 * 1000 && updateVer !== "") { return; }
        try { localStorage.setItem("dsh-message-recall:lastUpdateCheckTs", String(now)); } catch (e) { /* ignore */ }
        if (!updateVer) setUpdateVer("…");
        doCheckUpdate();
      }, [open]);
      // 每日检测：开关开启时每天首次触发一次（不依赖展开）
      React.useEffect(function () {
        var autoOn = getBool("dsh-message-recall:autoCheckUpdate", false);
        if (!autoOn) return;
        var today = new Date().toISOString().slice(0, 10);
        var last = null;
        try { last = localStorage.getItem("dsh-message-recall:lastUpdateCheck"); } catch (e) { /* ignore */ }
        if (last === today) return;
        try { localStorage.setItem("dsh-message-recall:lastUpdateCheck", today); } catch (e) { /* ignore */ }
        doCheckUpdate();
      }, []);
      // 插件总开关（即时生效：可订阅快照，切换后 UI 贡献重新注册）
      var sEnabled = React.useState(getEnabledSnapshot);
      var pluginOn = sEnabled[0];
      var setPluginOn = sEnabled[1];
      React.useEffect(function () {
        return subscribeEnabled(function () { setPluginOn(getEnabledSnapshot()); });
      }, []);

      // 官方 PluginCard 同款：卡片/展开态/头部/标题/描述/箭头/内容区
      var cardStyle = {
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-3)",
        borderRadius: "12px",
        listStyle: "none",
        transition: "border-color .16s, background .16s"
      };
      var cardOpenStyle = { background: "var(--dsw-alias-bg-layer-2)", borderColor: "var(--dsw-alias-label-dimmed)" };
      var headStyle = {
        appearance: "none",
        width: "100%",
        font: "inherit",
        color: "inherit",
        textAlign: "left",
        cursor: "pointer",
        background: "transparent",
        border: "none",
        borderRadius: "12px",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "14px 16px"
      };
      var headTextStyle = { display: "flex", flexDirection: "column", flex: "1", minWidth: "0", gap: "4px" };
      var titleStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "15px", fontWeight: 600, lineHeight: "1.4" };
      var subStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", lineHeight: "1.5" };
      var chevronStyle = { color: "var(--dsw-alias-label-tertiary)", flex: "none", transition: "transform .16s", transform: "rotate(90deg)" };
      var chevronOpenStyle = { transform: "rotate(270deg)" };
      var bodyStyle = {
        borderTop: "1px solid var(--dsw-alias-border-l2)",
        margin: "0 16px",
        // 底部内边距与顶部对称：页脚那条分隔线删除后，最后一行内容原本直接贴着卡片下边缘。
        paddingTop: "14px",
        paddingBottom: "14px",
        display: "flex",
        flexDirection: "column",
        gap: "14px"
      };
      // 卡内所有行共用同一左边缘：缩进只由 bodyStyle 的外边距给，行本身不再自带缩进，
      // 否则开关文字与「当前版本」不在一条竖线上。
      var rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" };
      var labelStyle = { fontSize: "13px", color: "var(--dsw-alias-label-primary)" };
      var hintStyle = { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" };
      // 更新区两处次要按钮共用（检查更新 / 复制升级命令）。
      var ghostButtonStyle = {
        appearance: "none",
        border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary)",
        borderRadius: "6px",
        padding: "3px 10px",
        fontSize: "12px",
        cursor: "pointer",
        fontFamily: "inherit",
        flex: "none"
      };
      // 行内说明与禁用态随「启用 MessageRecall」的副标题一并移除：本卡不再有需要它们
      // 的开关，留着就是无人使用的分支。
      function switchRow(label, value, onChange) {
        // 圆形勾选框：选中 = 白底黑勾（与确认胶囊同设计语言）；未选中 = 灰色圆环
        var checkSize = 20;
        var checkStyle = {
          width: checkSize,
          height: checkSize,
          borderRadius: "50%",
          border: "2px solid " + (value ? "#ffffff" : "var(--dsw-alias-border-l2, rgba(128,128,128,0.45))"),
          background: value ? "#ffffff" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: value ? "#000000" : "transparent",
          fontSize: "13px",
          lineHeight: "13px",
          cursor: "pointer",
          flex: "none",
          margin: "0 2px",
          transition: "border-color .15s, background .15s, color .15s",
          userSelect: "none",
          boxSizing: "border-box"
        };
        return React.createElement("div", {
          style: rowStyle,
          "data-dsh-message-recall": "switch-row"
        },
          React.createElement("span", { style: labelStyle }, label),
          React.createElement("div", {
            role: "checkbox",
            "aria-checked": !!value,
            style: checkStyle,
            onClick: function (e) { e.stopPropagation(); onChange(!value); }
          }, value ? React.createElement(Primitives.IconCheckOutline16, null) : null)
        );
      }

      return React.createElement("li", { style: Object.assign({}, cardStyle, open ? cardOpenStyle : null), "data-dsh-message-recall": "settings-card" },
        React.createElement("button", {
          type: "button",
          style: headStyle,
          "aria-expanded": open,
          "aria-label": (open ? TEXT.collapse : TEXT.expand) + ": " + TEXT.title,
          onClick: function () { setOpen(!open); }
        },
          React.createElement("span", { style: headTextStyle },
            React.createElement("span", { style: titleStyle }, TEXT.title),
            React.createElement("span", { style: subStyle }, TEXT.subtitle)
          ),
          React.createElement("svg", { width: "18", height: "18", viewBox: "0 0 24 24", style: Object.assign({}, chevronStyle, open ? chevronOpenStyle : null) },
            React.createElement("path", { d: "M9 6l6 6-6 6", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }))
        ),
        open ? React.createElement("div", { style: bodyStyle },
          // —— 插件开关 ——
          // 关闭后插件的全部 UI 贡献（气泡编辑与撤回键、版本翻页器）都不注册；
          // 设置卡自身始终可用，否则关掉后就再也打不开了。
          switchRow(TEXT.pluginEnable, pluginOn, function (v) { setPluginOn(v); setPluginEnabled(v); }),
          // —— 更新 ——
          // 更新区的行直接排在 bodyStyle 里，间距由它的 gap 统一给：此前多套一层分组
          // 容器，会让更新区比上面的插件开关多缩进一级，两组左边缘对不齐。
          switchRow(TEXT.autoCheckUpdate, autoCheckOn, function (v) {
            setAutoCheckOn(v);
            setBool("dsh-message-recall:autoCheckUpdate", v);
          }),
          // 版本号、检查结果与检查按钮同一行：三者是同一件事的三个面，分开会散成三段。
          React.createElement("div", { style: rowStyle },
            React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", minWidth: "0", flex: "1" } },
              React.createElement("span", { style: labelStyle }, TEXT.currentVersion + " " + (updateVer || "…")),
              updateMsg ? React.createElement("span", { style: Object.assign({}, hintStyle, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }) }, updateMsg) : null
            ),
            React.createElement("button", {
              type: "button",
              style: Object.assign({}, ghostButtonStyle, updateChecking ? { opacity: 0.5, cursor: "default" } : null),
              disabled: updateChecking,
              onClick: function () { doCheckUpdate(); }
            }, updateChecking ? TEXT.checking : TEXT.checkUpdate)
          ),
          // 发现的版本不满足要求 / 高于已测版本：各自一块说明，属异常态，值得占整行
          (function () {
            if (!dshVer) return null;
            if (cmpDsh(dshVer, MIN_DSH_VERSION) < 0) return React.createElement("div", { key: "dsh-low", style: { display: "flex", flexDirection: "column", gap: "4px", padding: "6px 8px", background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.1))", borderRadius: "8px" } },
              React.createElement("span", { style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-primary)" } }, TEXT.dshLowWarning.replace("{cur}", dshVer).replace("{min}", MIN_DSH_VERSION)),
              React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
                React.createElement("code", { style: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1" } }, "npm install -g @deepseek-ai/dsh@" + MIN_DSH_VERSION),
                React.createElement("button", { type: "button", style: Object.assign({}, ghostButtonStyle, { padding: "2px 8px", fontSize: "11px" }), onClick: function () { try { legacyCopy("npm install -g @deepseek-ai/dsh@" + MIN_DSH_VERSION); } catch (eC1) { /* ignore */ } } }, TEXT.copyUpgradeCmd)
              )
            );
            if (cmpDsh(MAX_TESTED_DSH_VERSION, dshVer) < 0) return React.createElement("div", { key: "dsh-new", style: { padding: "6px 8px", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)", background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.08))", borderRadius: "8px" } }, TEXT.dshNewNotice.replace("{cur}", dshVer));
            return null;
          })(),
          updateAvailableVer ? React.createElement("div", { style: rowStyle },
            React.createElement("span", { style: { fontSize: "12px", color: "var(--dsw-alias-brand-primary, #4d6bfe)", flex: "1", minWidth: "0" } }, TEXT.newVersion.replace("{ver}", updateAvailableVer)),
            React.createElement("button", {
              type: "button",
              style: {
                appearance: "none",
                border: "none",
                background: "var(--dsw-static-deepseek-500, #4d6bfe)",
                color: "#ffffff",
                borderRadius: "6px",
                padding: "3px 12px",
                fontSize: "12px",
                cursor: "pointer",
                fontFamily: "inherit",
                flex: "none"
              },
              onClick: function () { doUpdatePlugin(); }
            }, updateUpdating ? TEXT.updating : TEXT.updateNow)
          ) : null
        ) : null
      );
    }

    /** 受控切换（三路径共用）：准备目标历史 → 切换实际 session（稳定条目保持选中）→ 成功后清理。
     * - prepareSession 预加载目标历史而不选中；失败/取消时保留原会话与草稿，不归档。
     * - open 由调用方经 UI 导航层执行；归档只在切换成功后发生（失败仅重试归档，不重发）。
     * - 同一操作用 opKey 去重，连续点击只执行一次。
     * - 订阅 sessions.list 判断就绪，不用固定时延轮询。
     */
    var switchInFlight = {}; // opKey → true（同一操作并发锁）
    var switchSettled = {};  // targetId → Promise（该目标上的受控切换结算；投递据此排队）
    var switchSettledAt = {}; // targetId → 结算墙钟毫秒（供投递测「切换→接受」残窗）
    var WAIT_SWITCH_TIMEOUT_MS = 10000; // 与 waitForCurrent 同量级：切换挂了不能把投递永久卡住
    /** 投递前的切换屏障：决定「消息区可见内容」的是 current 翻转，不是切换流程结束。
     * 原实现里 claimResume 自己等 current===target 就立刻投递，而 controlledSwitch 的
     * prepare→open→waitForCurrent→归档 是另一条独立链；两者只在 current 上相遇，于是
     * current 一翻转、归档还没做完、文本可能才写进输入框——这就是「消息区先切到新会话、
     * 里面却是空的」那一下闪动。若已知目标上有切换在跑，先等它结算再投递。
     * 必须带超时：等待本身没有别的出口，切换一旦卡住就会把投递永久挂起，
     * 而「投递晚一点」永远好过「永远不投递」。 */
    function settleSwitch(targetId) {
      var pending = switchSettled[targetId];
      if (!pending) return Promise.resolve(false);
      // 归一成「已结算的布尔」：pending 的拒绝在这里被消费掉，所以 settled 永远是 fulfilled
      // 且携带布尔值。不能再对 settled 挂成功/失败两个回调——它不会走失败分支，
      // 那样写会把「切换失败」误判成「切换完成」。
      var settled = pending.then(function () { return true; }, function () { return false; });
      return new Promise(function (resolve) {
        var done = false;
        var finish = function (waited) {
          if (done) return;
          done = true;
          if (timer !== null) { try { clearTimeout(timer); } catch (eT) { /* ignore */ } }
          resolve(waited);
        };
        var timer = setTimeout(function () {
          log("warn", "resume", "等待切换结算超时（转为照常投递）", { targetId: targetId });
          finish(false);
        }, WAIT_SWITCH_TIMEOUT_MS);
        settled.then(finish);
      });
    }
    function waitForCurrent(ctxSessions, targetId, signal) {
      return new Promise(function (resolve, reject) {
        var done = false;
        var unsub = null;
        var check = function () {
          try {
            var cur = ctxSessions && ctxSessions.list && typeof ctxSessions.list.getSnapshot === "function"
              ? ctxSessions.list.getSnapshot().current
              : null;
            if (cur === targetId && !done) {
              done = true;
              if (unsub) { try { unsub(); } catch (eU) { /* ignore */ } }
              if (signal) { try { signal.removeEventListener("abort", onAbort); } catch (eR) { /* ignore */ } }
              resolve(true);
            }
          } catch (e) { /* ignore */ }
        };
        var onAbort = function () {
          if (done) return;
          done = true;
          if (unsub) { try { unsub(); } catch (eU2) { /* ignore */ } }
          reject(new Error("switch-cancelled"));
        };
        if (signal) {
          if (signal.aborted) { onAbort(); return; }
          try { signal.addEventListener("abort", onAbort); } catch (eA) { /* ignore */ }
        }
        try {
          if (ctxSessions && ctxSessions.list && typeof ctxSessions.list.subscribe === "function") {
            unsub = ctxSessions.list.subscribe(check);
          }
        } catch (eS) { unsub = null; }
        check();
      });
    }
    function controlledSwitch(opts) {
      // opts: { opKey, sourceId, targetId, ctxSessions, openSession, archiveSession,
      //         prepareSession, restoreSession, signal, onDelivered }
      var opKey = opts.opKey;
      if (!opKey || switchInFlight[opKey]) return Promise.resolve(false);
      switchInFlight[opKey] = true;
      var startedAt = Date.now();
      var release = function () { delete switchInFlight[opKey]; };
      var prepare = (typeof opts.prepareSession === "function")
        ? opts.prepareSession
        : (opts.ctxSessions && typeof opts.ctxSessions.prepare === "function"
          ? function (id, signal) { return opts.ctxSessions.prepare(id, signal); }
          : null);
      var doArchive = function () {
        if (typeof opts.archiveSession !== "function") return Promise.resolve(false);
        return Promise.resolve(opts.archiveSession(opts.sourceId)).then(function () { return true; }, function () { return false; });
      };
      var doOpen = function () {
        if (typeof opts.openSession === "function") opts.openSession(opts.targetId);
        return waitForCurrent(opts.ctxSessions, opts.targetId, opts.signal);
      };
      var chain = Promise.resolve();
      if (typeof opts.restoreSession === "function") {
        chain = chain.then(function () {
          return opts.restoreSession(opts.targetId).catch(function () { /* 幂等：失败也继续打开 */ });
        });
      }
      if (prepare) {
        chain = chain.then(function () { return prepare(opts.targetId, opts.signal); });
      }
      chain = chain.then(doOpen).then(function () {
        // 打点：current 落到目标。此刻起消息区显示的就是新会话，投递越晚、可见空窗越长。
        var visibleAt = Date.now();
        log("info", "switch", "消息区已切到目标会话", {
          target: opts.targetId, elapsedMs: visibleAt - startedAt
        });
        switchSettledAt[opts.targetId] = visibleAt;
        // 切换成功：先投递待发送记录（明确接受后再清理），再归档旧版本。
        if (typeof opts.onDelivered === "function") {
          try { opts.onDelivered(); } catch (eD) { /* ignore */ }
        }
        return doArchive().then(function (archived) {
          if (!archived) log("warn", "switch", "归档失败（新版本保持，仅需重试归档）", { source: opts.sourceId, target: opts.targetId });
          release();
          return true;
        });
      });
      var settled = chain.then(function (ok) {
        log("info", "switch", "受控切换结算", { target: opts.targetId, ok: ok, elapsedMs: Date.now() - startedAt });
        return ok;
      }, function (e) {
        // 失败/取消：保留原会话与草稿，不归档；调用方恢复可重试草稿。
        if (e && e.message !== "switch-cancelled") log("warn", "switch", "受控切换失败（保留原会话与草稿）", { err: String(e && e.message ? e.message : e) });
        release();
        throw e;
      });
      // 屏障值保留拒绝语义：切换失败后 claimResume 的 settleSwitch 仍会返回，
      // 但那时 current 不是目标，它会走自己的等待分支，不会被屏障卡死。
      switchSettled[opts.targetId] = settled;
      return settled.catch(function () { return false; });
    }

    /** 切换版本（按钮与键盘共用；无组件闭包依赖）：
     * 恢复目标（unarchive）→ 准备目标历史 → 先打开目标 → 确认当前会话==目标后归档家族其余。
     * 先 open 后归档：归档当前选中会清空选中，先让 current 落到目标就不会产生高亮空档。
     * 明确关系优先：有登记时只切换登记成员并更新目标；无登记时回退 lineage 派生展示。 */
    function goToVersion(fam, sessionId, nextIndex, props) {
      var next = fam.versions[nextIndex];
      if (!next) return;
      log("info", "pager", "切换版本", { from: sessionId, to: next, index: nextIndex + 1, count: fam.versions.length });
      // 明确关系优先：登记成员走受控切换（准备→打开→成功后归档其余），并更新登记目标；
      // 无登记时回退原行为（恢复→打开→订阅确认后归档其余），但同样先 open 后归档。
      var rel = relationOfSession(sessionId) || relationOfSession(next);
      var opKey = "goto:" + sessionId + ">" + next;
      if (switchInFlight[opKey]) return;
      var archiveRest = function () {
        var rest = (rel ? rel.memberSessionIds : fam.versions).filter(function (vid) { return vid !== next; });
        rest.forEach(function (vid) {
          try {
            if (typeof props.archiveSession === "function") props.archiveSession(vid);
          } catch (eA) { /* 单个归档失败不影响其余 */ }
        });
      };
      // 历史版本都是归档会话（无痕替换副作用），先恢复再打开；恢复失败也照常打开（幂等）
      var restore = (typeof props.restoreSession === "function") ? props.restoreSession : null;
      controlledSwitch({
        opKey: opKey,
        sourceId: sessionId,
        targetId: next,
        ctxSessions: props.ctxSessions,
        openSession: props.openSession,
        archiveSession: function () { archiveRest(); return Promise.resolve(true); },
        prepareSession: (props.ctxSessions && typeof props.ctxSessions.prepare === "function")
          ? function (id, signal) { return props.ctxSessions.prepare(id, signal); }
          : null,
        restoreSession: restore,
        onDelivered: function () {
          if (rel) retargetRelation(rel.rowId, next);
        }
      });
    }

    /** 该消息是否为会话第一条 user 消息（首条/截断会话首条无前置闭合边界）——模块级，UserBubbleView 共用 */
    function isFirstUserMessage(props, myKey) {
      try {
        var snap = getChatSnapshot(props);
        if (snap && Array.isArray(snap.order) && snap.nodes && typeof snap.nodes.get === "function") {
          var ord = snap.order;
          for (var oi = 0; oi < ord.length; oi++) {
            var on = snap.nodes.get(ord[oi]);
            if (on && on.kind === "user") return on.key === myKey;
          }
        }
      } catch (e) { /* ignore */ }
      return false;
    }

    /** 极限场景重置（首条消息/截断会话首条，无前置闭合边界，无法 fork）：
     * - 家族会话（截断/分叉产物，版本 ≥2）：先打开**父版本**（上一次模型回复处），成功后再归档当前；
     *   编辑模式经 resume 机制把修改文本带到父版本自动重发。
     * - 全新会话首条（无家族）：先打开空白新会话，成功后再归档当前（编辑模式经 resume 消费者自动发送编辑文本）。
     * 三路径共用 controlledSwitch：准备→打开→订阅确认→成功后归档；失败保留原会话与草稿。
     * 首条编辑创建新的空白版本时，仍沿用原侧栏条目标识（rowId=源会话）。
     * @param mode - "recall" | "edit"
     * @param text - edit 模式的修改后文本
     * @param props - 组件 inject 面
     */
    function resetConversation(sessionId, mode, text, props, imageIds, selOverride, stagedDraft) {
      log("info", "reset", "首条消息重置对话", { sessionId: sessionId, mode: mode });
      // v2.1.1：目标会话（父版本或空白新会话）发送前需要恢复当前模型/挡位
      // v2.2：气泡编辑 chip 的本地选择优先（selOverride），撤回键路径不传 → 原语义
      var msel = selOverride || (props.modelSel ? props.modelSel.capture(sessionId) : null);
      writePending(sessionId, null);
      var opKey = "reset:" + sessionId;
      if (switchInFlight[opKey]) return;
      var archiver = null;
      try {
        archiver = typeof props.archiveSession === "function"
          ? props.archiveSession
          : (props.ctxWorkspaces && typeof props.ctxWorkspaces.archiveSession === "function"
            ? function (id) { return props.ctxWorkspaces.archiveSession(id); }
            : null);
      } catch (eA) { archiver = null; }
      var archiveSource = function () {
        if (!archiver) { log("warn", "reset", "归档能力不可用", { sessionId: sessionId }); return Promise.resolve(false); }
        return Promise.resolve(archiver(sessionId)).then(function () { return true; }, function () {
          log("warn", "reset", "归档失败（目标会话保持，仅需重试归档）", { sessionId: sessionId });
          return false;
        });
      };
      var stageResume = function (targetId) {
        if (!(mode === "edit" && typeof text === "string")) return;
        try { localStorage.setItem(RESUME_PREFIX + targetId, JSON.stringify({ draftText: text, t: Date.now(), imageIds: imageIds || [], sel: msel, stagedDraft: stagedDraft || null })); } catch (e) { /* ignore */ }
        try { claimResume(targetId); } catch (eClaim) { /* 订阅兜底仍会认领 */ }
      };
      // 2) 场景 2：家族父版本（截断/分叉会话 → 回到上一次模型回复）
      //    父版本只认登记的编辑关系。此处曾用 parentId 派生：用户主动 fork 后编辑其首条消息时，
      //    lineage 会把「被 fork 出来的父会话」当成上一版，于是编辑重发把用户送回一个无关会话。
      //    没有登记关系就不进这个场景，直接落到场景 1 新建空白版本——这才是「首条消息」的语义。
      try {
        var fam = familyOfRelation(sessionId);
        log("info", "reset", "场景2家族判定", { sessionId: sessionId, found: !!fam, verLen: fam ? fam.versions.length : -1, index: fam ? fam.index : -1 });
        var parentId = fam && fam.versions.length >= 2 && fam.index > 0 ? fam.versions[fam.index - 1] : null;
        if (parentId) {
          stageResume(parentId);
          controlledSwitch({
            opKey: opKey,
            sourceId: sessionId,
            targetId: parentId,
            ctxSessions: props.ctxSessions,
            openSession: props.openSession,
            archiveSession: archiveSource,
            prepareSession: (props.ctxSessions && typeof props.ctxSessions.prepare === "function")
              ? function (id, signal) { return props.ctxSessions.prepare(id, signal); }
              : null,
            restoreSession: (typeof props.restoreSession === "function") ? props.restoreSession : null,
            onDelivered: function () {
              var rel = relationOfSession(sessionId);
              if (rel) retargetRelation(rel.rowId, parentId);
            }
          });
          return;
        }
      } catch (e) { /* ignore */ }
      // 3) 场景 1：全新会话首条 → 先打开空白新会话，成功后再归档当前。
      // 首条编辑创建新的空白版本时，仍沿用原侧栏条目标识（rowId=源会话 id）。
      try {
        var wsId = null;
        if (props.ctxWorkspaces && typeof props.ctxWorkspaces.list === "object" && typeof props.ctxWorkspaces.list.getSnapshot === "function") {
          var wsList = props.ctxWorkspaces.list.getSnapshot();
          if (wsList && Array.isArray(wsList.items)) {
            for (var wi = 0; wi < wsList.items.length; wi++) {
              if (wsList.items[wi] && Array.isArray(wsList.items[wi].sessionIds) && wsList.items[wi].sessionIds.indexOf(sessionId) >= 0) {
                wsId = wsList.items[wi].workspaceId;
                break;
              }
            }
          }
        }
          log("info", "reset", "场景1工作区定位", { sessionId: sessionId, wsId: wsId, hasConnect: !!(props.ctxWorkspaces && typeof props.ctxWorkspaces.connectWorkspace === "function") });
        var wsConnector = (ctxUiWorkspaceRef && typeof ctxUiWorkspaceRef.connectWorkspace === "function") ? ctxUiWorkspaceRef : ((props.ctxWorkspaces && typeof props.ctxWorkspaces.connectWorkspace === "function") ? props.ctxWorkspaces : null);
        if (wsId && wsConnector) {
          wsConnector.connectWorkspace(wsId).then(function (newId) {
            if (!newId) return;
            stageResume(newId);
            log("info", "reset", "空白新会话已就绪", { newId: newId, mode: mode });
            controlledSwitch({
              opKey: opKey,
              sourceId: sessionId,
              targetId: newId,
              ctxSessions: props.ctxSessions,
              openSession: props.openSession,
              archiveSession: archiveSource,
              prepareSession: (props.ctxSessions && typeof props.ctxSessions.prepare === "function")
                ? function (id, signal) { return props.ctxSessions.prepare(id, signal); }
                : null,
              restoreSession: null,
              onDelivered: function () {
                // 首条编辑的新空白版本沿用原条目：登记家族（rowId=源会话），目标=新会话。
                var rel = relationOfSession(sessionId);
                if (rel) {
                  var members = rel.memberSessionIds.slice();
                  if (members.indexOf(newId) < 0) members.push(newId);
                  registerRelation(rel.rowId, newId, members);
                } else if (mode === "edit") {
                  registerRelation(sessionId, newId, [sessionId, newId]);
                }
              }
            });
            // 投递走模块级 resume 消费者（claimResume→deliverResume）：它用读时快照
            // 取目标会话的 inputActions。旧实现误用源会话的 props.inputActions，
            // 在新会话上永远发不出去——已删。
          }).catch(function () { log("warn", "reset", "空白会话创建失败（回 hero）"); });
          return;
        }
      } catch (e) { /* ignore */ }
      // 兜底：目标会话不可用才依赖归档回 hero（目标可用时一律先打开后归档）。
      archiveSource().then(function () {
        log("info", "reset", "重置完成（兜底路径）", { sessionId: sessionId, mode: mode });
      });
    }

    /** 版本翻页器 < X >：撤回/编辑重发产生的版本家族切换（官方 assistant-actions 操作区）。
     * 仅在该次问询的**最后一条 assistant 消息**（当前版本的回答）显示；点击 ‹/› 或键盘 ←/→
     * 切换版本（sessions.open 兄弟会话），切换后滚动锚定保持文本位置不动。 */
    function VersionPager(props) {
      var sessionId = props.sessionId;
      // —— hooks 无条件前置（React 规则：任何 return null 不得出现在 hooks 之前，否则 hook 数量漂移 → error #300）——
      // 键盘 ←/→（输入框/可编辑区未聚焦时；实时读家族，避免陈旧闭包）
      React.useEffect(function () {
        function onKey(e) {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          var tgt = e.target;
          if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
          var fam = familyOfRelation(sessionId);
          if (!fam || fam.versions.length < 2) return;
          var idx = fam.index;
          if (e.key === "ArrowLeft" && idx > 0) { e.preventDefault(); goToVersion(fam, sessionId, idx - 1, props); }
          else if (e.key === "ArrowRight" && idx < fam.versions.length - 1) { e.preventDefault(); goToVersion(fam, sessionId, idx + 1, props); }
        }
        window.addEventListener("keydown", onKey, true);
        return function () { window.removeEventListener("keydown", onKey, true); };
      }, []);
      // —— 数据与显示条件（无 hooks，可安全 return null）——
      // 只认宿主登记的明确编辑关系：无登记即不显示翻页器（判别结论见 familyOfRelation）。
      var family = familyOfRelation(sessionId);
      if (!family || family.versions.length < 2) return null;
      // 只挂在**会话最后一个回合**的 TurnTail 上（历史回合的 TurnTail 也渲染本槽，须排除）：
      // order 最后一项是 turn-tail 且其 data.closing.finalNode.messageId == 本组件的 messageId
      var isLastTail = false;
      try {
        var snapshot = getChatSnapshot(props);
        if (snapshot && Array.isArray(snapshot.order) && snapshot.nodes && typeof snapshot.nodes.get === "function") {
          var order = snapshot.order;
          if (order.length > 0) {
            var tt = snapshot.nodes.get(order[order.length - 1]);
            if (tt && tt.kind === "turn-tail" && tt.data && tt.data.closing && tt.data.closing.finalNode) {
              isLastTail = tt.data.closing.finalNode.messageId === props.messageId;
            }
          }
        }
      } catch (e) { /* ignore */ }
      if (!isLastTail) return null;
      var index = family.index;
      var count = family.versions.length;
      var atFirst = index <= 0;
      var atLast = index >= count - 1;
      function go(delta) {
        goToVersion(family, sessionId, index + delta, props);
      }
      var pagerStyle = {
        display: "inline-flex",
        alignItems: "center",
        gap: "3px",
        fontSize: "14px",
        color: "var(--dsw-alias-label-tertiary)",
        fontVariantNumeric: "tabular-nums"
      };
      var btnStyle = {
        appearance: "none",
        border: "none",
        background: "transparent",
        cursor: "pointer",
        color: "var(--dsw-alias-label-secondary)",
        padding: "3px 7px",
        borderRadius: "6px",
        fontSize: "15px",
        lineHeight: "19px",
        fontFamily: "inherit"
      };
      function btnDisabled(flag) { return Object.assign({}, btnStyle, flag ? { opacity: 0.35, cursor: "default" } : {}); }
      return React.createElement("span", { style: pagerStyle, "data-dsh-message-recall": "version-pager", title: TEXT.pagerTitle },
        React.createElement("button", {
          type: "button",
          className: "dbe-pager-btn",
          style: btnDisabled(atFirst),
          disabled: atFirst,
          "aria-label": TEXT.pagerPrev,
          onClick: function () { go(-1); }
        }, React.createElement(Primitives.IconChevronLeftOutline14, null)),
        React.createElement("span", { style: { padding: "0 4px", fontSize: "14px", whiteSpace: "nowrap" } }, (index + 1) + "/" + count),
        React.createElement("button", {
          type: "button",
          className: "dbe-pager-btn",
          style: btnDisabled(atLast),
          disabled: atLast,
          "aria-label": TEXT.pagerNext,
          onClick: function () { go(1); }
        }, React.createElement(Primitives.IconChevronRightOutline14, null))
      );
    }

    /** 复制键：官方 IconCopyOutline16，点击复制消息原文（clipboard，带成功反馈）。
     * 注意：复制键保持原始小尺寸（14px 图标），不随撤回/编辑的 1.3 倍放大。 */
    function CopyButton({ text }) {
      var copyState = React.useState(false);
      var copied = copyState[0];
      var setCopied = copyState[1];
      function copy() {
        var done = function () { setCopied(true); setTimeout(function () { setCopied(false); }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
        } else { legacyCopy(text); done(); }
      }
      return React.createElement("button", {
        type: "button",
        title: copied ? TEXT.copied : TEXT.copy,
        "aria-label": TEXT.copy,
        style: {
          border: "none",
          background: "transparent",
          cursor: "pointer",
          width: 34,
          height: 34,
          padding: 0,
          borderRadius: "8px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center"
        },
        onMouseEnter: function (e) { e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.1))"; },
        onMouseLeave: function (e) { e.currentTarget.style.background = "transparent"; },
        onClick: function (e) { e.stopPropagation(); copy(); }
      }, copied
        ? React.createElement(Primitives.IconCheckOutline16, { size: 14 })
        : React.createElement(Primitives.IconCopyOutline16, { size: 14 }));
    }

    /** clipboard API 不可用时的回退复制。 */
    function legacyCopy(text) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    }


    /** 撤回待定态展开原文时的单张图片（v2.4.0）：loadImage 异步解析→<img>；圆角+气泡同宽约束，复刻原生气泡内图片观感；失败静默。 */

    function UserBubbleView(props) {
      var node = props.node;
      var data = node && node.data ? node.data : {};
      var text = extractText(data.content);
      // review M4：附件检测——图片附件可保留重发（M4 闭环）；其他块无法保留，进入编辑态时提示
      var hasUnpreservable = false;
      try {
        if (data && Array.isArray(data.content)) {
          for (var bi = 0; bi < data.content.length; bi++) {
            var blk = data.content[bi];
            if (blk && blk.type !== "text" && blk.type !== "image") { hasUnpreservable = true; break; }
          }
        }
      } catch (e) { /* ignore */ }

      var sessionId = props.sessionId;
      var myKey = node && typeof node.key === "string" ? node.key : "";
      var pending = usePending(sessionId);


      // 渲染期读取输入框草稿（存 ref 供确认时使用）
      var draftRef = React.useRef("");
      var inputState = typeof props.useInput === "function" ? props.useInput(function (s) { return s; }) : (props.inputState || null);
      if (inputState) draftRef.current = typeof inputState.draft === "string" ? inputState.draft : "";
        // 镜像输入框当前图片 id（供撤回/编辑发送时精确搬运）
        try { if (Array.isArray(inputState.imageIds)) latestInputImageIds = inputState.imageIds.slice(); } catch (eMir) { /* ignore */ }
        // v2.4.0：rc.1 input门面（props.inputState）的 imageIds 同步
        try { if (props.inputState && Array.isArray(props.inputState.imageIds)) latestInputImageIds = props.inputState.imageIds.slice(); } catch (eMir2) { /* ignore */ }

      // 编辑态（气泡 rewrite）：textarea 内容 + 是否编辑中；pending{type:"edit"} 持久化支持跨会话/刷新恢复
      var editState = React.useState(false);
      var editing = editState[0];
      var setEditing = editState[1];
      var editTextState = React.useState("");
      var editText = editTextState[0];
      var setEditText = editTextState[1];
      // 可见错误提示（no-boundary / turn-open 等失败原因）
      var errState = React.useState(null);
      var opError = errState[0];
      var setOpError = errState[1];
      // 编辑卡片宽度固定跟随底部输入卡片，不再有宽度档位
      var isEditPending = pending && pending.type === "edit" && pending.targetKey === myKey;
      var sEditImgs = React.useState([]); // 气泡编辑图片工作集 [{id, url, dataUrl}]
      var editImages = sEditImgs[0];
      var setEditImages = sEditImgs[1];
      var editImagesRef = React.useRef([]); // 渲染期镜像（异步回调读取最新集合，同 draftRef 模式）
      editImagesRef.current = editImages;
      // 编辑卡片实宽（供缩略图尺寸算术）。必须声明在组件顶层：
      // 放进 `if (editing)` 分支会让 hook 数随编辑态变化 → React #310，整条消息行渲染失败、
      // 撤回按钮消失（已踩过）。CSS 变量无法参与算术，故渲染后量一次 DOM 宽度。
      var editBoxElRef = React.useRef(null);
      var sMeasuredEditW = React.useState(0);
      var measuredEditW = sMeasuredEditW[0];
      var setMeasuredEditW = sMeasuredEditW[1];
      React.useEffect(function () {
        if (!editing) return;
        var el = editBoxElRef.current;
        if (!el) return;
        var w = el.getBoundingClientRect().width;
        if (w > 0) setMeasuredEditW(w);
      }, [editing]);
      // 原图放大预览（与底部草稿栏一致的交互）：点缩略图开、Escape/点遮罩/点关闭键关。
      // 同 editBoxElRef：必须声明在组件顶层，不能放进 `if (editing)` 分支（React #310）。
      var lightboxState = React.useState(null);
      var lightboxSrc = lightboxState[0];
      var setLightboxSrc = lightboxState[1];
      var closeLightbox = React.useCallback(function () { setLightboxSrc(null); }, []);
      var editRestoredRef = React.useRef(false); // 刷新恢复每挂载只跑一次
      var hadEditPendingAtMount = React.useRef(false); // 挂载瞬间是否已带编辑待定（区分"恢复"与"正常进入编辑"）
      if (hadEditPendingAtMount.current === false && pending && pending.type === "edit" && pending.targetKey === myKey) hadEditPendingAtMount.current = true;
      // 拖入虚线框（dropzone）：dzActive=文件拖拽在窗口内（灰虚线框+毛玻璃浮现）；dzOver=光标悬停在图片预览容器上（变蓝高亮）
      var sDzActive = React.useState(false);
      var dzActive = sDzActive[0];
      var setDzActive = sDzActive[1];
      var sDzOver = React.useState(false);
      var dzOver = sDzOver[0];
      var setDzOver = sDzOver[1];
      var sDzBottomOver = React.useState(false); // 底部输入框悬停高亮
      var dzBottomOver = sDzBottomOver[0];
      var setDzBottomOver = sDzBottomOver[1];
      var dzActiveRef = React.useRef(false); // 事件回调内读最新值（避免闭包旧态）
      var dzOverRef = React.useRef(false);
      var dzBottomOverRef = React.useRef(false);
      var dzWatchdogRef = React.useRef(0);   // 拖拽事件流中断兜底（2.5s 无事件自动复位，防卡死）
      var stagedBottomImageIdsRef = React.useRef([]); // 气泡编辑期间拖入底部输入框的暂存图片 ID 列表
      /** 把当前编辑图片集合同步进 pending（含 dataUrl 字节快照；超限降级只丢字节、引用仍在） */
      function syncEditImgsToPending(items) {
        try {
          var p = readPending(sessionId);
          if (!p || p.type !== "edit") return;
          var total = 0, stripped = 0;
          var snap = items.map(function (it) {
            var du = it && it.dataUrl ? String(it.dataUrl) : null;
            if (du) total += du.length;
            return { id: it.id, dataUrl: du };
          });
          if (total > 4000000) { // localStorage 配额保护：>~4MB 放弃字节持久化（原图仍走 attachRefs 恢复）
            snap = snap.map(function (it) { if (it.dataUrl) { it.dataUrl = null; stripped++; } return it; });
            log("warn", "edit", "编辑图片过大，跳过刷新持久化（本次会话内仍有效）", { stripped: stripped, total: total });
          }
          writePending(sessionId, Object.assign({}, p, { editImgs: snap, updatedAt: Date.now() }));
        } catch (eSp) { /* ignore */ }
      }
      React.useEffect(function () {
        if (!isEditPending || editing) return;
        setEditing(true);
        setEditText(pending.draftText);
        // bug②：刷新/重挂载恢复——原图按 attachRefs 重桥接 + 拖入图按 dataUrl 重建字节。
        // 仅当"挂载时就带着编辑待定"才走恢复（正常点击进入编辑由 enterEdit 自行桥接，避免重复）。
        if (!hadEditPendingAtMount.current || editRestoredRef.current) return;
        editRestoredRef.current = true;
        (async function () {
          try {
            var items = [];
            var refs = (cachedEditMsg[myKey] && cachedEditMsg[myKey].attachRefs) || [];
            for (var ri = 0; ri < refs.length; ri++) {
              try {
                if (!ctxConversationRef || !draftsAvailable()) break;
                var rUrl = await resolveImageCompat(sessionId, refs[ri], null);
                if (!rUrl) continue;
                var rResp = await fetch(rUrl);
                if (!rResp.ok) continue;
                var rBlob = await rResp.blob();
                var rD = draftsFor(sessionId, [new File([rBlob], refs[ri].name || "image.png", { type: refs[ri].mediaType || rBlob.type || "image/png" })]);
                if (rD && rD.length > 0) items.push({ id: rD[0].id, url: rD[0].previewUrl, dataUrl: null });
              } catch (eRo) { log("warn", "edit", "恢复原图失败", { err: String(eRo && eRo.message ? eRo.message : eRo) }); }
            }
            var origCount = items.length;
            var savedList = (pending && Array.isArray(pending.editImgs)) ? pending.editImgs : [];
            for (var si = 0; si < savedList.length; si++) {
              var sv = savedList[si];
              if (!sv || !sv.dataUrl) continue;
              try {
                if (!ctxConversationRef || !draftsAvailable()) break;
                var sD = draftsFor(sessionId, [dataUrlToFile(sv.dataUrl)]);
                if (sD && sD.length > 0) items.push({ id: sD[0].id, url: sD[0].previewUrl, dataUrl: sv.dataUrl });
              } catch (eRa) { log("warn", "edit", "恢复拖入图失败", { err: String(eRa && eRa.message ? eRa.message : eRa) }); }
            }
            if (items.length > 0) {
              setEditImages(items);
              syncEditImgsToPending(items);
            }
            log("info", "edit", "编辑态刷新恢复完成", { orig: origCount, added: items.length - origCount });
          } catch (eRe) { log("warn", "edit", "编辑态刷新恢复异常", { err: String(eRe && eRe.message ? eRe.message : eRe) }); }
        })();
      }, [isEditPending]);

      // 辅助：获取底部输入组件的操作栏/工具栏容器（包含模型选择、发送键等）
      function getComposerToolbar(card) {
        try {
          if (!card) return null;
          var btn = card.querySelector("button[aria-label*='发送'], button[aria-label*='Send'], button[data-send-button]");
          if (!btn) {
            var btns = card.querySelectorAll("button");
            if (btns.length > 0) btn = btns[btns.length - 1];
          }
          if (btn) {
            var cur = btn;
            while (cur && cur.parentNode && cur.parentNode !== card) {
              cur = cur.parentNode;
            }
            if (cur && cur.parentNode === card) return cur;
          }
        } catch (e) { /* ignore */ }
        return null;
      }

      // 辅助：光标坐标判定是否在底部虚线框的矩形区域内（支持高度扩大后超出卡片上边缘时的精准命中）
      function isPointInBottomDz(e) {
        try {
          if (!e || typeof e.clientX !== "number" || typeof e.clientY !== "number") return false;
          var ov = document.querySelector("[data-messagerecall-bottom-dz]");
          if (ov) {
            var r = ov.getBoundingClientRect();
            return (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
          }
        } catch (err) { /* ignore */ }
        return false;
      }

      // 辅助：判定事件目标是否在输入框组件区域（排除底部的模型选择和发送键等 UI）
      function isTargetInComposerInput(target) {
        try {
          if (!target) return false;
          var card = target.closest("[data-composer-card='true']") || target.closest("[data-composer-card]");
          if (!card) return false;
          var toolbar = getComposerToolbar(card);
          if (toolbar && (toolbar === target || toolbar.contains(target))) {
            return false;
          }
          return true;
        } catch (e) { return false; }
      }

      // 底部输入框 Dropzone 蒙层与输入框尺寸联动（气泡编辑拖拽时，输入框与虚线框同步按比例放大至 2.5x，严丝合缝贴合输入框组件内；不遮挡底部操作区）
      React.useEffect(function () {
        var card = document.querySelector("[data-composer-card='true']") || document.querySelector("[data-composer-card]");
        var scrollEl = card ? card.querySelector("[data-input-scroll]") : document.querySelector("[data-input-scroll]");

        function restoreInputBox() {
          try {
            var oldOv = document.querySelector("[data-messagerecall-bottom-dz]");
            if (oldOv && oldOv.parentNode) {
              var pNode = oldOv.parentNode;
              oldOv.remove();
              if (pNode && pNode.dataset && pNode.dataset.messagerecallOriginPos) {
                pNode.style.position = pNode.dataset.messagerecallOriginPos;
                delete pNode.dataset.messagerecallOriginPos;
              }
            }
            if (scrollEl && scrollEl.dataset && scrollEl.dataset.messagerecallOrigMinH !== undefined) {
              scrollEl.style.minHeight = scrollEl.dataset.messagerecallOrigMinH;
              delete scrollEl.dataset.messagerecallOrigMinH;
              delete scrollEl.dataset.messagerecallBaseH;
            }
          } catch (eR) { /* ignore */ }
        }

        if (!editing || !dzActive) {
          restoreInputBox();
          return;
        }

        if (!card) return;
        var compStyle = window.getComputedStyle ? window.getComputedStyle(card) : null;
        if (compStyle && compStyle.position === "static") {
          card.dataset.messagerecallOriginPos = card.style.position || "";
          card.style.position = "relative";
        }

        // 1) 输入框组件本身协同平滑放大至 2.5x（严丝合缝扩展，杜绝悬浮超框）
        if (scrollEl) {
          if (!scrollEl.dataset.messagerecallOrigMinH) {
            scrollEl.dataset.messagerecallOrigMinH = scrollEl.style.minHeight || "";
            scrollEl.dataset.messagerecallBaseH = String(Math.max(28, scrollEl.offsetHeight || 32));
          }
          var baseH = parseFloat(scrollEl.dataset.messagerecallBaseH) || 32;
          var targetH = Math.min(240, Math.max(80, Math.round(baseH * 2.5)));
          scrollEl.style.transition = "min-height .15s ease";
          scrollEl.style.minHeight = targetH + "px";
        }

        // 2) 测量底部工具栏（模型选择与发送键等）
        var toolbar = getComposerToolbar(card);
        var bottomGap = 44;
        try {
          if (toolbar) {
            var cRect = card.getBoundingClientRect();
            var tRect = toolbar.getBoundingClientRect();
            if (tRect.top >= cRect.top && tRect.top < cRect.bottom) {
              bottomGap = Math.max(36, Math.round(cRect.bottom - tRect.top));
            }
          }
        } catch (eG) { /* ignore */ }

        // 3) 虚线框严丝合缝贴合放大的输入框内部（从卡片顶部到工具栏上方，绝不超出输入框卡片）
        var ov = card.querySelector("[data-messagerecall-bottom-dz]");
        if (!ov) {
          ov = document.createElement("div");
          ov.setAttribute("data-messagerecall-bottom-dz", "1");
          ov.style.position = "absolute";
          ov.style.top = "6px";
          ov.style.left = "8px";
          ov.style.right = "8px";
          ov.style.bottom = (bottomGap + 4) + "px";
          ov.style.zIndex = "25";
          ov.style.display = "flex";
          ov.style.alignItems = "center";
          ov.style.justifyContent = "center";
          ov.style.borderRadius = "12px";
          ov.style.boxSizing = "border-box";
          ov.style.pointerEvents = "none";
          ov.style.backdropFilter = "blur(14px)";
          ov.style.webkitBackdropFilter = "blur(14px)";
          ov.style.animation = "dshMessageRecallDzFadeIn 0.16s ease-out";
          ov.style.transition = "border-color .12s ease, background-color .12s ease, color .12s ease";
          var txtSpan = document.createElement("span");
          txtSpan.className = "dsh-message-recall-bottom-dz-text";
          txtSpan.style.fontSize = "13.5px";
          txtSpan.style.fontWeight = "500";
          txtSpan.style.textAlign = "center";
          txtSpan.style.padding = "0 14px";
          txtSpan.style.maxWidth = "100%";
          txtSpan.style.overflow = "hidden";
          txtSpan.style.textOverflow = "ellipsis";
          txtSpan.style.whiteSpace = "nowrap";
          ov.appendChild(txtSpan);
          card.appendChild(ov);
        } else {
          ov.style.top = "6px";
          ov.style.bottom = (bottomGap + 4) + "px";
        }
        var dzBlue = "var(--dsw-static-deepseek-500, #4d6bfe)";
        var dzGrey = "rgba(128,128,128,0.45)";
        ov.style.border = "3px dashed " + (dzBottomOver ? dzBlue : dzGrey);
        ov.style.background = dzBottomOver ? "rgba(77,107,254,0.10)" : "rgba(128,128,128,0.06)";
        var spanEl = ov.querySelector(".dsh-message-recall-bottom-dz-text");
        if (spanEl) {
          spanEl.textContent = dzBottomOver ? "松开暂存至输入框（新对话中保留）" : "拖入此处暂存至输入框（新对话中保留）";
          spanEl.style.color = dzBottomOver ? dzBlue : "rgba(128,128,128,0.85)";
        }
        return function () {
          restoreInputBox();
        };
      }, [editing, dzActive, dzBottomOver]);

      // 编辑态：document 捕获级接管文件拖拽（bug①）。官方全屏提示层由 dsh-client-ui-attachment
      // 在 document 冒泡阶段以 dragenter/dragleave 计数驱动、drop 时才 reset——旧实现只拦 drop 且
      // stopPropagation，官方收不到任何后续事件 → 提示层永久卡死。现在 dragenter/dragover 一并在
      // 捕获阶段拦下：提示层根本不出现；drop 按目标分流至编辑气泡或底部输入框暂存区。随编辑态启停。
      React.useEffect(function () {
        if (!editing) return;
        function looksLikeFileDrag(e) {
          try { var t = e.dataTransfer; return !!(t && t.types && Array.prototype.indexOf.call(t.types, "Files") !== -1); } catch (eT) { return false; }
        }
        function suppress(e) { e.preventDefault(); e.stopPropagation(); }
        function armWatchdog() {
          try { if (dzWatchdogRef.current) clearTimeout(dzWatchdogRef.current); } catch (eW) { /* ignore */ }
          dzWatchdogRef.current = setTimeout(function () {
            dzActiveRef.current = false; dzOverRef.current = false; dzBottomOverRef.current = false;
            setDzActive(false); setDzOver(false); setDzBottomOver(false);
          }, 2500);
        }
        function onDragEnter(e) {
          if (!looksLikeFileDrag(e)) return;
          suppress(e);
          armWatchdog();
          if (!dzActiveRef.current) { dzActiveRef.current = true; setDzActive(true); }
          // 悬停判定：气泡图片容器
          var over = false;
          try { over = !!(e.target && e.target.closest && e.target.closest("[data-messagerecall-dropzone]")); } catch (eC) { /* ignore */ }
          if (over !== dzOverRef.current) { dzOverRef.current = over; setDzOver(over); }
          // 悬停判定：底部输入框组件区域（坐标或 target，排除模型选择与发送键）
          var bOver = false;
          try { bOver = isPointInBottomDz(e) || isTargetInComposerInput(e.target); } catch (eBC) { /* ignore */ }
          if (bOver !== dzBottomOverRef.current) { dzBottomOverRef.current = bOver; setDzBottomOver(bOver); }
        }
        function onDragOver(e) {
          if (!looksLikeFileDrag(e)) return;
          suppress(e);
          armWatchdog();
          if (!dzActiveRef.current) { dzActiveRef.current = true; setDzActive(true); }
          var over2 = false;
          try { over2 = !!(e.target && e.target.closest && e.target.closest("[data-messagerecall-dropzone]")); } catch (eC2) { /* ignore */ }
          if (over2 !== dzOverRef.current) { dzOverRef.current = over2; setDzOver(over2); }
          var bOver2 = false;
          try { bOver2 = isPointInBottomDz(e) || isTargetInComposerInput(e.target); } catch (eBC2) { /* ignore */ }
          if (bOver2 !== dzBottomOverRef.current) { dzBottomOverRef.current = bOver2; setDzBottomOver(bOver2); }
        }
        function dzReset() {
          try { if (dzWatchdogRef.current) { clearTimeout(dzWatchdogRef.current); dzWatchdogRef.current = 0; } } catch (eW2) { /* ignore */ }
          dzActiveRef.current = false; dzOverRef.current = false; dzBottomOverRef.current = false;
          setDzActive(false); setDzOver(false); setDzBottomOver(false);
        }
        function onDrop(e) {
          suppress(e);
          var isBubble = false;
          var isBottom = false;
          try {
            isBubble = !!(e.target && e.target.closest && e.target.closest("[data-messagerecall-dropzone]"));
            isBottom = isPointInBottomDz(e) || isTargetInComposerInput(e.target);
          } catch (eCl) { /* ignore */ }
          dzReset();
          try {
            var imgFiles = [];
            var dt = e.dataTransfer;
            if (dt && dt.files) {
              for (var di = 0; di < dt.files.length; di++) {
                var df = dt.files[di];
                if (df.type && df.type.indexOf("image") === 0) imgFiles.push(df);
              }
            }
            if (imgFiles.length === 0 || !ctxConversationRef || !draftsAvailable()) return;

            if (isBottom) {
              // 分流 A：释放到底部输入框暂存区
              var bImgs = draftsFor(sessionId, imgFiles);
              if (bImgs && bImgs.length > 0) {
                var bIds = bImgs.map(function (im) { return im.id; });
                if (props.inputActions) {
addToComposer(props.inputActions, bIds);
                }
                stagedBottomImageIdsRef.current = stagedBottomImageIdsRef.current.concat(bIds);
                log("info", "edit", "图片已添加到底部输入框暂存区", { count: bIds.length, ids: bIds });
              }
              return;
            }

            if (!isBubble) return;

            // 分流 B：释放到气泡编辑区（修改当前消息）
            var dImgs = draftsFor(sessionId, imgFiles);
            var addedItems = dImgs.map(function (im) { return { id: im.id, url: im.previewUrl, dataUrl: null }; });
            // 异步补 dataUrl 字节快照（bug② 刷新后可重建）
            for (var ai = 0; ai < addedItems.length; ai++) {
              (function (item, srcFile) {
                fileToDataUrl(srcFile).then(function (du) {
                  item.dataUrl = du;
                  setEditImages(function (prev) {
                    var nxt = prev.map(function (x) { return x.id === item.id ? Object.assign({}, x, { dataUrl: du }) : x; });
                    syncEditImgsToPending(nxt);
                    return nxt;
                  });
                }).catch(function () { /* ignore */ });
              })(addedItems[ai], imgFiles[ai]);
            }
            setEditImages(function (prev) { var nxt = prev.concat(addedItems); syncEditImgsToPending(nxt); return nxt; });
            log("info", "edit", "拦截到拖入图片至气泡", { count: addedItems.length });
          } catch (eDr) { log("warn", "edit", "拖入拦截异常", { err: String(eDr && eDr.message ? eDr.message : eDr) }); }
        }
        function onDragLeave(e) {
          // 离开窗口（relatedTarget=null）→ 整体复位；跨元素边界的假离开交给 dragover 刷新
          if (!looksLikeFileDrag(e)) return;
          if (e.relatedTarget === null) dzReset();
        }
        document.addEventListener("dragenter", onDragEnter, true);
        document.addEventListener("dragover", onDragOver, true);
        document.addEventListener("drop", onDrop, true);
        document.addEventListener("dragleave", onDragLeave, true);
        return function () {
          document.removeEventListener("dragenter", onDragEnter, true);
          document.removeEventListener("dragover", onDragOver, true);
          document.removeEventListener("drop", onDrop, true);
          document.removeEventListener("dragleave", onDragLeave, true);
          // 编辑退出/组件卸载：清看门狗 + 复位虚线框状态（防下次进入编辑带残留）
          try { if (dzWatchdogRef.current) { clearTimeout(dzWatchdogRef.current); dzWatchdogRef.current = 0; } } catch (eC3) { /* ignore */ }
          dzActiveRef.current = false; dzOverRef.current = false; dzBottomOverRef.current = false;
          setDzActive(false); setDzOver(false); setDzBottomOver(false);
          try {
            var ovOld = document.querySelector("[data-messagerecall-bottom-dz]");
            if (ovOld && ovOld.parentNode) {
              var pNode2 = ovOld.parentNode;
              ovOld.remove();
              if (pNode2 && pNode2.dataset && pNode2.dataset.messagerecallOriginPos) {
                pNode2.style.position = pNode2.dataset.messagerecallOriginPos;
                delete pNode2.dataset.messagerecallOriginPos;
              }
            }
            var scOld = document.querySelector("[data-input-scroll]");
            if (scOld && scOld.dataset && scOld.dataset.messagerecallOrigMinH !== undefined) {
              scOld.style.minHeight = scOld.dataset.messagerecallOrigMinH;
              delete scOld.dataset.messagerecallOrigMinH;
              delete scOld.dataset.messagerecallBaseH;
            }
          } catch (eRem) { /* ignore */ }
        };
      }, [editing]);

      // 渲染时无条件缓存消息图片 refs（confirmEdit 异步回调安全读取）
      var _pcCache = contentParts(data.content);
      var _imgsCache = _pcCache && _pcCache.images ? _pcCache.images : [];
      if (_imgsCache.length > 0) {
        var _arC = [];
        for (var _aci = 0; _aci < _imgsCache.length; _aci++) {
          var _ca2 = _imgsCache[_aci].attachment;
          if (_ca2 && typeof _ca2.attachmentId === "string") _arC.push({ attachmentId: _ca2.attachmentId, mediaType: _ca2.mediaType, name: _ca2.name });
        }
        if (_arC.length > 0) cachedEditMsg[myKey] = { seq: (data && typeof data.seq === "number") ? data.seq : anchorSeq, attachRefs: _arC };
      }



      // 统计该消息之后的内容条数（x 条内容）——防御式读取：任何异常都不影响气泡渲染
      var anchorSeq = node && typeof node.anchorSeq === "number" ? node.anchorSeq : (node && typeof node.seq === "number" ? node.seq : 0);
      var afterCount = 0;
      var onlyUser = STAT_ONLY_USER;
      try {
        // 注意：useSession 必须传 selector（官方 bindSnapshotSelector 契约），无参调用会崩
        var snapshot = getChatSnapshot(props);
        if (snapshot) {
          // 主路径：order（权威渲染顺序）+ 当前节点 key（v2.4.0：快照经 getChatSnapshot 归一化）
          if (Array.isArray(snapshot.order) && snapshot.nodes && typeof snapshot.nodes.get === "function") {
            var order = snapshot.order;
            var myKey = node && typeof node.key === "string" ? node.key : "";
            var myIdx = order.indexOf(myKey);
            if (myIdx !== -1) {
              for (var k = myIdx + 1; k < order.length; k++) {
                var afterNode = snapshot.nodes.get(order[k]);
                if (!afterNode || afterNode.kind === "turn-tail") continue;
                if (onlyUser && afterNode.kind !== "user") continue;
                afterCount++;
              }
            }
          }
          // 回退路径 1：legacy 顶层 nodes（seq）
          if (afterCount === 0 && Array.isArray(snapshot.nodes)) {
            afterCount = countContentAfter(snapshot.nodes, anchorSeq, "seq", onlyUser);
          }
          // 回退路径 2：chat store values（anchorSeq）
          if (afterCount === 0 && snapshot.nodes && typeof snapshot.nodes.values === "function") {
            afterCount = countContentAfter(snapshot.nodes.values(), anchorSeq, "anchorSeq", onlyUser);
          }
        }
      } catch (err) {
        log("warn", "count", "会话快照读取失败（数量显示 0）", { err: String(err && err.message ? err.message : err) });
      }
      // 发送时间（hover 显示，对齐官方 data-time-hover-root 机制）
      var msgTime = data && typeof data.time === "number" ? data.time : (typeof node.time === "number" ? node.time : 0);

      var rowStyle = { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px", padding: "2px 0" };
      var bubbleStyle = {
        maxWidth: "min(80%, var(--dsh-chat-content-width, 748px))",
        background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))",
        borderRadius: "14px",
        padding: "8px 14px",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontSize: "14px",
        lineHeight: "22px",
        color: "var(--dsw-alias-label-primary, inherit)"
      };
      var actionsStyle = { display: "flex", gap: "2px", alignItems: "center" };

      // 撤回待定且为本消息：按视觉模式显示（数据未变，仅显示层）

      // ---------- 编辑态（气泡 rewrite） ----------
      function enterEdit() {
        // 单待定约束：仅"撤回待定"算真正冲突（此时输入框里已有待发送的撤回草稿）。
        // 编辑待定不再拦截——它要么是本条消息的残留（编辑态未恢复/已退出），要么是别的消息留下的；
        // 两种情况都应当由本次编辑接管。此前一律 return，会在刷新带回一条陈旧 pending 时
        // 形成死锁：进入不了编辑态，而清掉 pending 的入口（旧确认胶囊 / × 条）在本次改造中已删除。
        var staleEditPending = pending && pending.type === "edit";
        if (pending && !staleEditPending) {
          log("warn", "edit", "已有撤回待定（单待定约束），请先发送或取消");
          return;
        }
        if (staleEditPending && editing) {
          // 恢复路径已进入编辑态：按"已取消"处理，交还给用户重新点撤回
          cancelEdit();
          return;
        }
        var realSeq = (data && typeof data.seq === "number") ? data.seq : anchorSeq;
        writePending(sessionId, { type: "edit", targetKey: myKey, targetSeq: realSeq, draftText: text, updatedAt: Date.now() });
        setEditing(true);
        setEditText(text);
        setEditImages([]); // v2.4.0：每次进入编辑=干净起点（防反复进出叠加）
        stagedBottomImageIdsRef.current = []; // 暂存列表重置
        log("info", "edit", "进入编辑态", { sessionId: sessionId, targetSeq: realSeq, tookOverStale: !!staleEditPending });
        // 带图编辑：把原消息图片桥接成 draft attachments（供编辑态预览和确认发送）
        try {
          var _er = [];
          var _epc = contentParts(data.content);
          if (_epc.images && _epc.images.length > 0) {
            for (var _ei = 0; _ei < _epc.images.length; _ei++) {
              var _ea = _epc.images[_ei].attachment;
              if (_ea && typeof _ea.attachmentId === "string") _er.push({ attachmentId: _ea.attachmentId, mediaType: _ea.mediaType, name: _ea.name });
            }
          }
          if (_er.length > 0) {
            (async function() {
              try {
                var eFiles = [];
                for (var ei2 = 0; ei2 < _er.length; ei2++) {
                  var eUrl = await resolveImageCompat(sessionId, _er[ei2], props);
                  if (!eUrl) continue;
                  var eResp = await fetch(eUrl); if (!eResp.ok) continue;
                  var eBlob = await eResp.blob();
                  eFiles.push(new File([eBlob], _er[ei2].name || "image.png", { type: _er[ei2].mediaType || eBlob.type || "image/png" }));
                }
                if (eFiles.length > 0 && draftsAvailable()) {
                  var eDrafts = draftsFor(sessionId, eFiles);
                  var newItems = eDrafts.map(function(im) { return { id: im.id, url: im.previewUrl }; });
                  setEditImages(function(prev) { return prev.concat(newItems); });
                  log("info", "edit", "enterEdit 图片桥接完成", { count: newItems.length });
                }
              } catch (eBe) { log("warn", "edit", "enterEdit 图片桥接异常", { err: String(eBe && eBe.message ? eBe.message : eBe) }); }
            })();
          }
        } catch (eEe) { /* ignore */ }
      }
      function cancelEdit() {
        if (isEditPending) writePending(sessionId, null);
        setEditing(false);
        log("info", "edit", "编辑取消（原样不变）");
      }
      var editInFlight = false; // review M2：编辑重发并发锁（同一操作去重，见 controlledSwitch.opKey）
      async function confirmEdit() {
        if (editInFlight) return;
        var opKey = "edit:" + sessionId + ":" + myKey;
        if (switchInFlight[opKey]) return;
        editInFlight = true;
        try {
          // 惰性提交：编辑的「确定」= 真正修改点（与撤回的「发送」等价）——截断重发
          var newText = editText;
          var sid = sessionId;
          var realSeq = (data && typeof data.seq === "number") ? data.seq : anchorSeq;
          // host 需要消息 id 才能在"尚未被回合认领"时识别出它仍排在待处理 inbox 里
          // （那一刻还没有 user/message 事件，只有 inbox 入队记录，按 seq 找不到）。
          var realMsgId = (data && typeof data.id === "string" && data.id.length > 0) ? data.id : null;
          // v2.4.0：首条/截断场景交由宿主判定树（下方 no-boundary/turn-open 分支统一走 resetConversation），
          // 窗口化快照上的 isFirstUserMessage 本地判定已移除（误判源）。图片桥接随命中分支执行。
          // review M3：pending 不清除前置——失败时保留草稿并恢复编辑态
          // M4：收集本条消息的图片附件引用（随 resume 数据传递，重发保留）
          // 诊断：dump content 块类型
          var editImgIds = editImages.map(function(x) { return x.id; });
          // 模型/挡位：编辑框不再自带选择器，统一取底部输入框当前值，随 resume 带到新会话
          var msel = props.modelSel ? props.modelSel.capture(sid) : null;

          // 收集底部输入框暂存草稿（文本与图片）：新会话中隔离保留
          // 渲染期 inputState 是当前会话的 InputState 快照（含 draft 文本；附件见 imageIds 镜像）。
          var bDraftText = "";
          try {
            var curSnap = (typeof props.useInput === "function")
              ? props.useInput(function (s) { return s; })
              : (props.inputState || null);
            if (curSnap && typeof curSnap.draft === "string") bDraftText = curSnap.draft;
            else if (curSnap && typeof curSnap.text === "string") bDraftText = curSnap.text;
          } catch (eBT) { /* ignore */ }
          var bImgIds = [];
          try {
            var curInState = props.inputState || null;
            if (curInState && Array.isArray(curInState.imageIds)) {
              bImgIds = curInState.imageIds.slice();
            }
          } catch (eBImgs) { /* ignore */ }
          if (bImgIds.length === 0 && stagedBottomImageIdsRef.current.length > 0) {
            bImgIds = stagedBottomImageIdsRef.current.slice();
          }
          var stagedDraftPayload = (bDraftText || (bImgIds && bImgIds.length > 0)) ? {
            text: bDraftText,
            imageIds: bImgIds
          } : null;

          setEditing(false);
          log("info", "edit", "确定：编辑重发", { sessionId: sid, targetSeq: realSeq, len: newText.length, hasStaged: !!stagedDraftPayload });
          var resp = await fetch("/bubble/recall", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: sid, targetSeq: realSeq, targetMessageId: realMsgId })
          });
          var data = await resp.json();
          if (!data || !data.ok) {
            var errCode2 = (data && data.error) || "unknown";
            log("warn", "edit", "编辑重发失败（边界）", { error: errCode2 });
            if (errCode2 === "message-pending") {
              // 目标消息仍在 agent inbox 里待处理（尚未进入任何回合记录）。
              // 此时撤回会让 fork 把这条消息复制进新会话重发、编辑文本反而丢失，
              // 故 host 直接拒绝：这里只提示等待，恢复编辑态，绝不做 resetConversation
              // （那会丢弃整个会话，代价远大于等一个回合）。
              setEditing(true);
              setOpError(TEXT.errMessagePending);
              setTimeout(function () { setOpError(null); }, 6000);
            } else if (errCode2 === "turn-open" || errCode2 === "no-boundary") {
              // 极限场景（说一半截断 / 首条无边界）：重置对话，编辑文本带到新起点
              setEditing(false);
              setOpError(TEXT.resetNotice);
              setTimeout(function () { setOpError(null); }, 5000);
              resetConversation(sid, "edit", newText, props, editImgIds, null, stagedDraftPayload);
            } else {
              // review M3：失败恢复编辑态（草稿仍在 editText），不丢内容；显示可见原因
              setEditing(true);
              setOpError(TEXT.errGeneric);
              setTimeout(function () { setOpError(null); }, 5000);
            }
            return;
          }
          var newId = null;
          // 发布前登记归属：先铸好子会话 id 并用它登记关系，再拿同一个 id 去 fork。
          // 顺序是关键——宿主 fork 子会话一创建就同步进入 client 列表，且列表发布同样由宿主的
          // api-session/added 帧驱动，client 侧无法推迟。若等 fork 返回再登记，就必须再等
          // /bubble/relations/register 与 /bubble/relations 两次往返，这段时间里新行是完整可见的
          // （旧实现的闪行窗口）。提前登记后，子会话在列表里一出现就已被投影折叠进原条目。
          var preRel = relationOfSession(sid);
          var rowId = preRel ? preRel.rowId : sid;
          var expectedId = mintChildSessionId();
          var preMembers = preRel ? preRel.memberSessionIds.slice() : [sid];
          if (preMembers.indexOf(expectedId) < 0) preMembers.push(expectedId);
          var preRegistered = await registerRelation(rowId, expectedId, preMembers);
          if (!preRegistered) log("warn", "edit", "预登记版本关系失败（侧栏会短暂显示两行，切换仍继续）", { rowId: rowId, expected: expectedId });
          try {
            newId = await props.ctxSessions.fork({
              sessionId: sid,
              atSeq: data.boundary,
              childSessionId: expectedId
            });
          } catch (e) {
            // fork 失败：子会话从未存在，预登记的关系里留着它的 id。整条重登记（而不是只改目标）
            // 才能把这个不存在的成员一并剔除——成员表残留会让条目在后备显示时被固定到一个空洞上。
            if (preRegistered) {
              var keep = [];
              for (var pm = 0; pm < preMembers.length; pm++) {
                if (preMembers[pm] !== expectedId) keep.push(preMembers[pm]);
              }
              if (keep.length === 0) keep.push(sid);
              try { registerRelation(rowId, sid, keep); } catch (eRb) { /* 关系残留无害：目标已回落到源会话 */ }
            }
            log("error", "edit", "fork 失败（编辑重发中止，保留原会话与草稿）", { err: String(e && e.message ? e.message : e) });
            setEditing(true); // 恢复编辑态
            return;
          }
          // 旧宿主（内嵌 client 未带 childSessionId）会自行生成 id：把关系改挂到真实子会话，
          // 不留指向不存在会话的记录。改挂成功后关系已正确，无需再走下面的一次登记。
          var relationSettled = preRegistered;
          if (newId !== expectedId) {
            relationSettled = await reconcileForkChild(rowId, expectedId, newId, sid);
          } else if (preRegistered) {
            log("info", "edit", "版本关系已在子会话发布前登记", { rowId: rowId, child: newId });
          }
          var rel = relationOfSession(sid);
          var members = rel ? rel.memberSessionIds.slice() : [sid];
          if (members.indexOf(newId) < 0) members.push(newId);
          // 待发送记录保留到明确接受：此处只登记关系与 resume，不清除 pending；
          // 投递成功（deliverResume 回调）后才清理，失败恢复可重试草稿。
          try {
            localStorage.setItem(RESUME_PREFIX + newId, JSON.stringify({
              draftText: newText,
              t: Date.now(),
              imageIds: editImgIds,
              sel: msel,
              stagedDraft: stagedDraftPayload
            }));
          } catch (e) { /* ignore */ }
          if (!relationSettled) {
            var registered = await registerRelation(rowId, newId, members);
            if (!registered) log("warn", "edit", "版本关系登记失败（侧栏暂显示两行，切换仍继续）", { rowId: rowId, newId: newId });
          }
          try { claimResume(newId); } catch (eClaim) { /* 订阅兜底仍会认领 */ }
          // 受控切换：后台准备新版本（prepare 不选中）→ 打开 → 订阅确认 → 成功后归档旧版本。
          // 用户等待时切到其他会话：controlledSwitch 只管自己的目标，不强行切回；
          // 编辑结果经 resume 记录保持可恢复（TTL 内）。
          var switched = await controlledSwitch({
            opKey: opKey,
            sourceId: sid,
            targetId: newId,
            ctxSessions: props.ctxSessions,
            openSession: props.openSession,
            archiveSession: (props.ctxWorkspaces && typeof props.ctxWorkspaces.archiveSession === "function")
              ? function (id) { return props.ctxWorkspaces.archiveSession(id); }
              : (typeof props.archiveSession === "function" ? props.archiveSession : null),
            prepareSession: (props.ctxSessions && typeof props.ctxSessions.prepare === "function")
              ? function (id, signal) { return props.ctxSessions.prepare(id, signal); }
              : null,
            restoreSession: null,
            onDelivered: function () {
              // 投递已认领（读一次即删，防重发）：此处不清 resume，deliverResume 成功后由其回调清理 pending。
              if (isEditPending) writePending(sid, null);
              log("info", "edit", "编辑重发：新版本已接受，旧版本归档", { newId: newId });
            }
          });
          if (!switched) {
            // fork/准备/切换失败：保留原会话和编辑草稿，不归档原会话，恢复编辑态可重试。
            setEditing(true);
            setEditText(newText);
          }
        } catch (err) {
          log("error", "edit", "编辑重发请求失败", { err: String(err && err.message ? err.message : err) });
          setEditing(true); // 网络异常也恢复编辑态
        } finally {
          editInFlight = false;
        }
      }
      function onBubbleClick(e) {
        if (editing) return;
        var sel = window.getSelection && window.getSelection();
        if (sel && typeof sel.toString === "function" && sel.toString().length > 0) return; // 有选区不进入
        if (e.target && typeof e.target.closest === "function" && e.target.closest("a")) return; // 点链接不进入
        enterEdit();
      }
      if (editing) {
        // 拖入虚线框 fade-in 动画（官方 DropOverlay 同款 .16s ease-out；幂等注入一次；尊重 reduced-motion）
        try {
          if (typeof document !== "undefined" && document.querySelector("style[data-dsh-message-recall-dz]") === null) {
            var dzSt = document.createElement("style");
            dzSt.setAttribute("data-dsh-message-recall-dz", "1");
            dzSt.textContent = "@keyframes dshMessageRecallDzFadeIn{0%{opacity:0}to{opacity:1}}@media (prefers-reduced-motion:reduce){[data-messagerecall-dropzone-overlay]{animation:none}}";
            document.head.appendChild(dzSt);
          }
        } catch (eDzSt) { /* ignore */ }
        // 高度完全由 CSS 约束决定（minHeight 32px / maxHeight 336px = 输入框同一套变量），
        // rows 固定 1：省得行数与行高两条路径互相打架（onChange 里按 scrollHeight 自增）。
        var taRows = 1;
        // 尺寸对齐底部输入卡片（宿主 ConversationRoot 的 --dsh-composer-card-max-width = W + 32px）：
        // 消息行左右各留 16px（与气泡一致的公共间距），编辑卡片再吃满剩余宽度，
        // 两者相加正好等于输入卡片的宽度，因此窗口缩放/侧栏折叠/拖动宽度手柄时都自动一致。
        var editRowStyle = { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px", padding: "2px 16px", boxSizing: "border-box" };
        var editBoxStyle = {
          width: "100%",
          maxWidth: "var(--dsh-composer-card-max-width, 780px)",
          boxSizing: "border-box",
          position: "relative",
          background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))",
          borderRadius: "14px",
          padding: "8px 14px",
          display: "flex",
          flexDirection: "column",
          gap: "12px"
        };
        var editWidthForThumbs = measuredEditW > 0 ? measuredEditW : 748;
        // 高度对齐底部输入框（官方 InputBar.module.css）：
        //   .input     min-height 36px（一行 24px + 4px 上内边距 + 8px 余量），line-height inherit = 24px
        //   .scroll    max-height var(--dsh-composer-text-max-height) = 336px（14 行 × 24px）
        // 这里处于卡片内部，故下限取 32px（36 − 4px 上内边距），上限与行高直接引用同两个宿主变量。
        var taStyle = {
          width: "100%",
          border: "none",
          outline: "none",
          background: "transparent",
          resize: "none",
          font: "inherit",
          fontSize: "var(--dsh-content-font-size, 14px)",
          lineHeight: "calc(24px + var(--dsh-content-font-delta, 0px))",
          color: "var(--dsw-alias-label-primary)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          minHeight: "32px",
          maxHeight: "var(--dsh-composer-text-max-height, 336px)",
          overflowY: "auto"
        };
        // 按钮行内边距对齐官方工具条 .row（InputBar.module.css: 2px 8px 6px）
        var btnRowStyle = { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "12px", padding: "2px 8px 6px" };
        var primaryBtnStyle = {
          border: "none",
          background: "var(--dsw-static-deepseek-500, #4d6bfe)",
          color: "#ffffff",
          borderRadius: "999px",
          padding: "4px 16px",
          fontSize: "13px",
          cursor: "pointer",
          whiteSpace: "nowrap"
        };
        var ghostBtnStyle = {
          border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))",
          background: "transparent",
          color: "var(--dsw-alias-label-secondary)",
          borderRadius: "999px",
          padding: "4px 16px",
          fontSize: "13px",
          cursor: "pointer",
          whiteSpace: "nowrap"
        };
        // 编辑态：图片缩略图保持在编辑框上方（不因进入编辑而消失）
        var pcEd = contentParts(data.content);
        var editImgs = pcEd && pcEd.images ? pcEd.images : [];
        return React.createElement(
          "div", {
            style: editRowStyle,
            "data-dsh-message-recall": "user-editing",
            onDrop: function (e) {
              e.preventDefault(); e.stopPropagation();
              try {
                var dt = e.dataTransfer;
                if (!dt || !dt.files) return;
                var imgFiles = [];
                for (var di = 0; di < dt.files.length; di++) {
                  var df = dt.files[di];
                  if (df.type && df.type.indexOf("image") === 0) imgFiles.push(df);
                }
                if (imgFiles.length > 0 && draftsAvailable()) {
                  var dImgs = draftsFor(sessionId, imgFiles);
                  var newItems = dImgs.map(function(im) { return { id: im.id, url: im.previewUrl }; });
                  setEditImages(function(prev) { return prev.concat(newItems); });
                  log("info", "edit", "拖入图片已加入编辑", { count: newItems.length });
                }
              } catch (eDr) { log("warn", "edit", "拖入处理异常", { err: String(eDr && eDr.message ? eDr.message : eDr) }); }
            },
            onDragOver: function (e) { e.preventDefault(); e.stopPropagation(); }
          },
        (function () {
          // 拖入虚线框（dropzone）：dzActive=文件拖拽在窗口内 → 虚线框+毛玻璃浮现；dzOver=光标悬停框内 → 蓝框高亮。
          // 同布局双尺寸模型（用户定稿）：平时与拖入态都是"与输入框等宽的 4 张/行"，差别只在图片尺寸——
          // 平时 padding 0（图片行与输入框左右边缘齐平、尺寸最大）；拖入时框 border 3px+padding 5px 11px 出现，
          // 图片整体微缩进框内（每张缩 ~7px，发生在毛玻璃浮现的 0.16s 里 → "透视收缩+视觉中心转移"效果）。
          // 透明虚线边框两态常驻占位（几何稳定）；覆盖层 pointerEvents:none 纯装饰，事件只在 document 捕获层。
          var dzShow = dzActive;
          var hasImgs = editImages.length > 0;
          if (!hasImgs && !dzShow) return null; // 无图且未拖入：不占任何空间
          var dzGrey = "rgba(128,128,128,0.45)";
          var dzBlue = "var(--dsw-static-deepseek-500, #4d6bfe)";
          var dzBorder = 3, dzPadX = 11, dzGap = 6;
          // 缩略图尺寸：内容宽 = 框宽 − 常驻透明边框 6px −（拖入态再加内边距 22px）；4 张均分，第 5 张起换行；
          // 宽度基准用实测 DOM 宽度（CSS 变量无法参与算术）；同输入框宽度时自然得到与底部草稿栏相近的尺寸。
          var thumbBaseW = editWidthForThumbs;
          var dzThumbUsual = Math.max(44, Math.floor((thumbBaseW - 2 * dzBorder - 3 * dzGap) / 4));
          var dzThumbDrag = Math.max(44, Math.floor((thumbBaseW - 2 * dzBorder - 2 * dzPadX - 3 * dzGap) / 4));
          var thumbSize = dzShow ? dzThumbDrag : dzThumbUsual;
          // 无图占位框：比一张图略大（拖入态图高 + 上下各留 8px 空）
          var dzMinH = !hasImgs ? dzThumbDrag + 16 : void 0;
          return React.createElement(
            "div", {
              "data-messagerecall-dropzone": "1",
              style: {
                position: "relative",
                width: "100%", maxWidth: "100%", boxSizing: "border-box",
                display: "flex", flexWrap: "wrap", gap: dzGap + "px", alignItems: "flex-start",
                padding: dzShow ? "5px " + dzPadX + "px" : "0px",
                marginBottom: "6px",
                minHeight: dzMinH,
                borderRadius: "16px",
                border: dzBorder + "px dashed " + (dzShow ? (dzOver ? dzBlue : dzGrey) : "transparent"),
                transition: "border-color .12s ease, padding .15s ease"
              }
            },
            editImages.map(function(ei, eiIdx) {
              // boxSizing:border-box：1px 边框计入 thumbSize（content-box 下每张多占 2px，会挤走第 4 张——已踩坑）
              return React.createElement("div", { key: ei.id, style: { position: "relative", boxSizing: "border-box", width: thumbSize + "px", height: thumbSize + "px", borderRadius: "8px", overflow: "hidden", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))", transition: "width .15s ease, height .15s ease" } },
                // 缩略图本体是可点按钮（与官方草稿栏一致：cursor:zoom-in，点击开原图预览）
                React.createElement("button", {
                  type: "button",
                  title: TEXT.openOriginal,
                  "aria-label": TEXT.openOriginal,
                  onClick: function (ev) { ev.stopPropagation(); setLightboxSrc(ei.url); },
                  style: { display: "block", width: "100%", height: "100%", padding: "0", border: "none", background: "transparent", cursor: "zoom-in" }
                },
                  React.createElement("img", { src: ei.url, alt: ei.name || "", style: { width: "100%", height: "100%", objectFit: "cover", display: "block" } })
                ),
                React.createElement("button", { type: "button", onClick: function(ev) { ev.stopPropagation(); var nxtRm = editImagesRef.current.filter(function(x) { return x.id !== ei.id; }); setEditImages(nxtRm); syncEditImgsToPending(nxtRm); }, style: { position: "absolute", top: "2px", right: "2px", width: "18px", height: "18px", borderRadius: "50%", border: "none", background: "rgba(0,0,0,0.55)", color: "#fff", fontSize: "12px", lineHeight: "18px", textAlign: "center", cursor: "pointer", padding: "0" }, title: TEXT.removeImage, "aria-label": TEXT.removeImage }, "\u00d7")
              );
            }),
            dzShow ? React.createElement(
              "div", {
                "data-messagerecall-dropzone-overlay": "1",
                style: {
                  position: "absolute", inset: "0",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  borderRadius: "13px",
                  background: dzOver ? "rgba(77,107,254,0.10)" : "rgba(128,128,128,0.06)",
                  backdropFilter: "blur(12px)",
                  WebkitBackdropFilter: "blur(12px)",
                  pointerEvents: "none",
                  zIndex: 5,
                  boxSizing: "border-box",
                  animation: "dshMessageRecallDzFadeIn 0.16s ease-out",
                  transition: "background-color .12s ease"
                }
              },
              React.createElement("div", { style: { color: dzOver ? dzBlue : "rgba(128,128,128,0.85)", fontSize: "13px", lineHeight: "20px", fontWeight: 500, padding: "0 12px", textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" } },
                TEXT.dzFull
              )
            ) : null
          );
        })(),
          React.createElement(
            "div", { style: editBoxStyle, ref: editBoxElRef },
            hasUnpreservable ? React.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-warning, #b7791f)", marginBottom: "6px", lineHeight: "1.5" } }, TEXT.attachWarning) : null,
            opError ? React.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-error, #d9534f)", marginBottom: "6px", lineHeight: "1.5" } }, opError) : null,
            React.createElement("textarea", {
              value: editText,
              rows: taRows,
              autoFocus: true,
              placeholder: TEXT.emptyMsg,
              style: taStyle,
              onChange: function (e) { setEditText(e.target.value); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; },
              onKeyDown: function (e) {
                if (e.key === "Escape") { e.stopPropagation(); cancelEdit(); }
                else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); confirmEdit(); }
              },
              onPaste: function (e) {
                try {
                  var items = e.clipboardData ? e.clipboardData.items : [];
                  for (var pi = 0; pi < items.length; pi++) {
                    if (items[pi].type && items[pi].type.indexOf("image") === 0) {
                      var pf = items[pi].getAsFile();
                      if (pf) {
                        e.preventDefault();
                        var pImgs = draftsAvailable() ? draftsFor(sessionId, [pf]) : null;
                        if (pImgs && pImgs.length > 0) {
                          var pItem = { id: pImgs[0].id, url: pImgs[0].previewUrl, dataUrl: null };
                          setEditImages(function(prev) { var nxt = prev.concat([pItem]); syncEditImgsToPending(nxt); return nxt; });
                          fileToDataUrl(pf).then(function (du) {
                            pItem.dataUrl = du;
                            setEditImages(function (prev2) {
                              var nxt2 = prev2.map(function (x) { return x.id === pItem.id ? Object.assign({}, x, { dataUrl: du }) : x; });
                              syncEditImgsToPending(nxt2);
                              return nxt2;
                            });
                          }).catch(function () { /* ignore */ });
                        }
                        break;
                      }
                    }
                  }
                } catch (pe) { /* ignore */ }
              },
            }),
            React.createElement(
              "div", { style: btnRowStyle },
              // 模型/挡位不在此处选择：统一交给底部输入框（其状态在确认时经 modelSel.capture 捕获并带到新会话）。
              React.createElement(
                "div", { style: { display: "flex", gap: "8px", marginLeft: "auto" } },
                React.createElement("button", { type: "button", style: ghostBtnStyle, onClick: function (e) { e.stopPropagation(); cancelEdit(); } }, TEXT.cancel),
                React.createElement("button", { type: "button", style: primaryBtnStyle, onClick: function (e) { e.stopPropagation(); confirmEdit(); } }, TEXT.confirm)
              )
            )
          ),
          React.createElement(
            "div", { style: actionsStyle },
            actionButton("撤回", "撤回", function (e) {
              e.stopPropagation();
              // 编辑态下的撤回键 = 放弃本次编辑（等同于取消，零副作用）
              cancelEdit();
            }, React.createElement(IconRefreshOutline16, { size: 16 }), "recall-key")
          ),
          // 原图预览：与底部草稿栏同一交互（点缩略图开、Escape/遮罩/关闭键关）
          lightboxSrc ? React.createElement(ImageLightbox, {
            src: lightboxSrc,
            alt: "",
            dialogLabel: TEXT.imageOriginal,
            closeLabel: TEXT.closeOriginal,
            onClose: closeLightbox
          }) : null
        );
      }

      var timeStyle = {
        color: "var(--dsw-alias-label-tertiary)",
        whiteSpace: "nowrap",
        fontSize: "14px",
        lineHeight: "24px",
        display: "inline-flex",
        alignItems: "center",
        height: 28,
        paddingRight: "4px"
      };

      // 问题1 修复：气泡上方渲染消息中的图片附件（覆盖 chat.node 后官方图片槽不再自动注入）
      var pc = contentParts(data.content);
      var msgImages = pc && pc.images ? pc.images : [];

      return React.createElement(
        "div", { style: rowStyle, "data-dsh-message-recall": "user", "data-time-hover-root": true },
        renderMessageImagesCompat(msgImages, props),
        React.createElement(
          "div", { style: bubbleStyle, onClick: onBubbleClick, title: TEXT.clickEdit },
          text || TEXT.emptyMsg
        ),
React.createElement(
              "div", { style: actionsStyle },
              React.createElement("span", { className: "dbe-time", style: timeStyle }, formatClock(msgTime)),
              actionButton("撤回", "撤回", function (e) {
                e.stopPropagation();
                if (pending && pending.type === "recall") {
                  log("warn", "recall", "已有待处理撤回（单待定约束）");
                  return;
                }
                // 撤回 = 就地进入编辑态（原文与图片预填，原气泡被编辑器取代）。
                // 纯本地动作：不写 pending、不动输入框，点多少次都无副作用；
                // 真正的截断重发只发生在编辑器里的「确认」。
                enterEdit();
              }, React.createElement(IconRefreshOutline16, { size: 16 }), "recall-key"),
              React.createElement(CopyButton, { text: text })
            )
      );
    }

    /** 主题自适应样式：深色模式（body[data-ds-dark-theme]，rc.6 已确认标记）下图标反白。 */
    function injectThemeStyle() {
      var id = "dsh-message-recall-theme";
      if (document.querySelector("style[data-plugin=\"" + id + "\"]") !== null) return null;
      var tag = document.createElement("style");
      tag.dataset.plugin = id;
      tag.textContent =
        "[data-dsh-message-recall] .dbe-icon-img{transition:filter .15s}" +
        "body[data-ds-dark-theme] [data-dsh-message-recall] .dbe-icon-img{filter:invert(1)}" +
        "@media (hover:hover){[data-dsh-message-recall][data-time-hover-root] .dbe-time{opacity:0;transition:opacity 80ms}" +
        "[data-dsh-message-recall][data-time-hover-root]:hover .dbe-time,[data-dsh-message-recall][data-time-hover-root]:focus-within .dbe-time{opacity:1}}" +
        "[data-dsh-message-recall=\"recall-bar\"] .dbe-recall-x:hover .dbe-recall-x-bg{fill:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,0.28))}" +
        "[data-dsh-message-recall=\"recall-bar\"] .dbe-recall-x:hover .dbe-recall-x-glyph{stroke:var(--dsw-alias-label-primary)}" +
        "[data-dsh-message-recall=\"version-pager\"] .dbe-pager-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.14));color:var(--dsw-alias-label-primary)}";
      document.head.appendChild(tag);
      return tag;
    }

    function apply(ctx) {
      ctx.effect(function () {
        var disposers = [];
        var styleTag = injectThemeStyle();
        log("info", "lifecycle", "client half active");
        // 调试 API：撤回条实时调参（调试模式门控：localStorage dsh-message-recall:debug=1；set/get/diagnose/export）
        try {
          var wRef = (typeof window !== "undefined") ? window : null;
          if (wRef && !wRef.__dshMessageRecall) wRef.__dshMessageRecall = { bar: {} };
          if (wRef) {
            // 注意：方法内一律用闭包 apiRef 而非 this（用户把方法赋给变量再调用时 this 会断链）
            var apiRef = {
              _on: function () { try { return localStorage.getItem("dsh-message-recall:debug") === "1"; } catch (e) { return false; } },
              help: function () {
                try {
                  if (!apiRef._on()) return "调试模式未开启：先执行 localStorage.setItem('dsh-message-recall:debug','1')（当前页即时生效，无需刷新）";
                  return [
                    "__dshMessageRecall.bar.get()                看现状（bar 内缩/圆钮计算样式）",
                    "__dshMessageRecall.bar.set({inset:-1})       偏移 px：0=与预览图齐平，负=向外，正=向内；null 回退自动测量",
                    "__dshMessageRecall.bar.set({size:26.4})      圆钮直径 px",
                    "__dshMessageRecall.bar.set({radius:'999px'}) 圆钮圆角（'0px' 可对照方形）",
                    "__dshMessageRecall.bar.set({bg:'red'})       圆钮底色（调试对比用）",
                    "__dshMessageRecall.bar.diagnose()            扫样式表找压圆角规则 + 计算样式",
                    "__dshMessageRecall.bar.export()              导出 JSON（发给我固化进代码）"
                  ].join("\n");
                } catch (eH) { return "ERR: " + ((eH && eH.stack) || eH); }
              },
              get: function () {
                try {
                  if (!apiRef._on()) return "调试模式未开启：localStorage.setItem('dsh-message-recall:debug','1')";
                  var out = { tune: JSON.parse(JSON.stringify(barTune)) };
                  var barEl = document.querySelector('[data-dsh-message-recall="recall-bar"]');
                  if (!barEl) { out.bar = "不在 DOM（需先进入撤回态）"; return JSON.stringify(out, null, 2); }
                  var cs = getComputedStyle(barEl);
                  out.bar = { width: cs.width, paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight };
                  var circ = barEl.querySelector(".dbe-recall-x-circ");
                  var btn = barEl.querySelector(".dbe-recall-x");
                  if (circ) {
                    var c2 = getComputedStyle(circ);
                    out.circ = { width: c2.width, height: c2.height, borderRadius: c2.borderTopLeftRadius, background: c2.backgroundColor, display: c2.display, boxSizing: c2.boxSizing };
                  } else out.circ = "不在 DOM";
                  if (btn) { var b2 = getComputedStyle(btn); out.button = { width: b2.width, height: b2.height, background: b2.backgroundColor, borderRadius: b2.borderTopLeftRadius }; }
                  return JSON.stringify(out, null, 2);
                } catch (eG) { return "ERR: " + ((eG && eG.stack) || eG); }
              },
              set: function (o) {
                try {
                  if (!apiRef._on()) return "调试模式未开启：localStorage.setItem('dsh-message-recall:debug','1')";
                  if (o && "inset" in o) barTune.inset = (o.inset === null ? null : +o.inset);
                  if (o && "size" in o) barTune.size = (o.size === null ? null : +o.size);
                  if (o && "radius" in o) barTune.radius = (o.radius === null ? null : String(o.radius));
                  if (o && "bg" in o) barTune.bg = (o.bg === null ? null : String(o.bg));
                  return barApplyTune();
                } catch (eS) { return "ERR: " + ((eS && eS.stack) || eS); }
              },
              diagnose: function () {
                try {
                  if (!apiRef._on()) return "调试模式未开启：localStorage.setItem('dsh-message-recall:debug','1')";
                  return JSON.stringify(barDiagnose(), null, 2);
                } catch (eDg) { return "ERR: " + ((eDg && eDg.stack) || eDg); }
              },
              export: function () {
                try {
                  if (!apiRef._on()) return "调试模式未开启：localStorage.setItem('dsh-message-recall:debug','1')";
                  return JSON.stringify(barTune);
                } catch (eEx) { return "ERR: " + ((eEx && eEx.stack) || eEx); }
              },
              reset: function () {
                try {
                  if (!apiRef._on()) return "调试模式未开启：localStorage.setItem('dsh-message-recall:debug','1')";
                  barTune.inset = null; barTune.size = null; barTune.radius = null; barTune.bg = null;
                  document.dispatchEvent(new CustomEvent("dsh-message-recall:bar-tune"));
                  var xC = document.querySelector('.dbe-recall-x-circ');
                  if (xC) barApplyCircTune(xC);
                  return "tune 已清空 → 固化默认值（inset=-7 / size=22）";
                } catch (eRz) { return "ERR: " + ((eRz && eRz.stack) || eRz); }
              }
            };
            wRef.__dshMessageRecall.bar = apiRef;
          }
        } catch (eDbg) { /* ignore */ }
        try { ctxConversationRef = ctx.conversation; } catch (e) { ctxConversationRef = null; }
        try { ctxUiConversationRef = (typeof ctx.get === "function") ? (ctx.get("uiConversation") || null) : null; } catch (eUic) { ctxUiConversationRef = null; }
        try { ctxUiWorkspaceRef = (typeof ctx.get === "function") ? (ctx.get("uiWorkspace") || null) : null; } catch (eUiw) { ctxUiWorkspaceRef = null; }
          // 陈旧 localStorage 键清扫：已移除的功能与旧版本树留下的键都是死数据，启动时一次清掉。
          // 先快照键名再删——边遍历边 remove 会跳过下标。
          try {
            var stale = [];
            for (var sk = 0; sk < localStorage.length; sk++) {
              var skey = localStorage.key(sk);
              if (!skey) continue;
              if (skey.indexOf("dsh-message-recall:versions:") === 0) { stale.push(skey); continue; }
              if (STALE_SETTING_KEYS[skey] === true) stale.push(skey);
            }
            for (var sv = 0; sv < stale.length; sv++) localStorage.removeItem(stale[sv]);
            if (stale.length > 0) log("info", "lifecycle", "已清扫陈旧 localStorage 键", { count: stale.length, keys: stale });
          } catch (e) { /* ignore */ }
        // ---------- 模型/思考挡位随行（v2.1.1） ----------
        // fork 出的新会话是全新 agent：无进程内选择、无请求日志，host 会落到全局默认——
        // 导致撤回/编辑重发丢失用户在输入框里选的模型与挡位。这里在 fork 前用官方
        // modelDirectories 服务（与选择器同一数据源）捕获当前值，随 resume 标记携带，
        // 新会话自动发送前经官方 selectModel 写回（即用户手动切换的同款通道）。
        //
        // modelSelApply 供模块级 resume 消费者（deliverResume）复用：apply 前必须
        // 声明在 deliverResume 之前？——不，deliverResume 只在运行时调用，此处赋值
        // 给外层 var，调用时已就绪。
        var modelSelApply = function (sessionId, sel) {
          try {
            var md = ctx.modelDirectories;
            if (!md || typeof md.directoryFor !== "function") return Promise.resolve(false);
            return md.directoryFor(sessionId).select(sel).then(function () {
              log("info", "model", "新会话已应用原模型/挡位选择", { provider: sel.provider, model: sel.model });
              return true;
            }, function (e) {
              log("warn", "model", "应用模型/挡位失败（按默认发送）", { err: String(e && e.message ? e.message : e) });
              return false;
            });
          } catch (e) { return Promise.resolve(false); }
        };
        try { ctxSessionsRef = ctx.sessions; } catch (eCtxS) { ctxSessionsRef = null; }
        try { modelSelApplyRef = modelSelApply; } catch (eMSA) { modelSelApplyRef = null; }
        try {
          if (ctxUiWorkspaceRef) ctxUiWorkspaceRef = ctxUiWorkspaceRef;
          else if (typeof ctx.get === "function") ctxUiWorkspaceRef = ctx.get("uiWorkspace") || null;
          else ctxUiWorkspaceRef = ctx.uiWorkspace || null;
        } catch (eCtxU) { ctxUiWorkspaceRef = null; }
        // 关系同步：启动拉一次全量并发布投影扩展；sessions.list 变化只刷新缓存
        // （跨通道到达顺序由投影层协调：fork 先登记关系再 open，缓存刷新后合并）。
        // 多标签页各自保持选中：此处只发布行投影，从不广播 open。
        try { refreshRelations(); } catch (eR) { /* ignore */ }
        try {
          if (ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.subscribe === "function") {
            if (relationsUnsub) { try { relationsUnsub(); } catch (eRU) { /* ignore */ } }
            relationsUnsub = ctx.sessions.list.subscribe(function () {
              try { refreshRelations(); } catch (eRR) { /* ignore */ }
            });
            disposers.push(function () { try { relationsUnsub(); } catch (eU2) { /* ignore */ } relationsUnsub = null; });
          }
        } catch (eSub2) { /* ignore */ }
        disposers.push(function () {
          if (recallRowsDisposer) { try { recallRowsDisposer(); } catch (eRD) { /* ignore */ } recallRowsDisposer = null; }
        });
        // resume 认领订阅：fork/reset 的 openSession 翻 current 后消费一次。
        // 订阅挂在 sessions.list 快照源上（插件自己的 pending store 同款机制），
        // 回调只做“读 key→claimResume”，重投递由 claimResume 内的轮询完成。
        // 注意：localStorage 在遍历中被 claimResume 删除会跳过下标——先快照全部 key。
        try {
          if (ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.subscribe === "function") {
            var resumeUnsub = ctx.sessions.list.subscribe(function () {
              try {
                if (typeof localStorage === "undefined") return;
                var found = [];
                for (var ki = 0; ki < localStorage.length; ki++) {
                  var k = null;
                  try { k = localStorage.key(ki); } catch (eK) { k = null; }
                  if (k && k.indexOf(RESUME_PREFIX) === 0) found.push(k.slice(RESUME_PREFIX.length));
                }
                for (var fi = 0; fi < found.length; fi++) claimResume(found[fi]);
              } catch (eScan) { /* ignore */ }
            });
            disposers.push(function () { try { resumeUnsub(); } catch (eU) { /* ignore */ } });
          }
        } catch (eSub) { /* ignore */ }
        var modelSel = {
          capture: function (sessionId) {
            try {
              var md = ctx.modelDirectories;
              if (!md || typeof md.directoryFor !== "function") return null;
              var cur = md.directoryFor(sessionId).store.getSnapshot().current;
              if (cur && cur.provider && cur.model) {
                return { provider: cur.provider, model: cur.model, reasoningEffort: cur.reasoningEffort };
              }
            } catch (e) { log("warn", "model", "读取当前模型/挡位失败（将按默认发送）", { err: String(e && e.message ? e.message : e) }); }
            return null;
          },
          apply: function (sessionId, sel) {
            if (!sel || !sel.provider || !sel.model) return Promise.resolve(false);
            return modelSelApply(sessionId, sel);
          }
        };
        /** 受总开关门控的槽注册：关闭时整块不注册，宿主官方的渲染接管这一格。
         * 之所以要「不注册」而不是「渲染 null」——`conversation.chat.node` 是 keyed 槽且 key="user"，
         * 本插件顶替的是**官方那条用户消息格**（fallback 只对未知 kind 生效）。组件里 return null
         * 会让用户气泡整个消失；只有撤掉注册，renderSlot 才会回落到官方格子。
         * 开关变化靠重新执行 register 生效（slots.inject 的回调本身只在声明期跑一次）。 */
        var gateDisposers = [];
        var gateRunners = [];
        function gatedSlot(name, registerFn) {
          var current = null;
          var run = function () {
            if (current) { try { current(); } catch (e) { /* ignore */ } current = null; }
            if (!getEnabledSnapshot()) return;
            try { current = registerFn(); } catch (e) {
              log("warn", "lifecycle", "槽注册失败", { slot: name, err: String(e && e.message ? e.message : e) });
            }
          };
          gateRunners.push(run);
          var outer = ctx.slots.inject(name, function () {
            run();
            return function () {
              if (current) { try { current(); } catch (e) { /* ignore */ } current = null; }
            };
          });
          gateDisposers.push(function () {
            try { if (current) current(); } catch (e) { /* ignore */ }
            current = null;
            if (typeof outer === "function") outer();
          });
        }
        gatedSlot("conversation.chat.node", function () {
          return ctx.slots.register({
            name: "conversation.chat.node",
            key: "user",
            priority: -1,
            inject: function (sessionId) {
              // v2.4.0：chat.node 槽同样经 input 门面自取 inputActions（dsh 0.1.2 不再下发）
              var inputShell2 = null;
              try {
                if (sessionId) {
                  var scope2 = ctx.sessions.scope(sessionId);
                  var conv2 = scope2 ? scope2.get("conversation") : null;
                  if (conv2 && conv2.input && typeof conv2.input.for === "function") inputShell2 = conv2.input.for(scope2);
                }
              } catch (eSh2) { inputShell2 = null; }
              return {
                openSession: function (id) { ctx.sessions.open(id); },
                ctxWorkspaces: ctx.workspaces,
                ctxSessions: ctx.sessions,
                modelSel: modelSel,
                modelDirectories: ctx.modelDirectories,
                inputActions: inputShell2 && inputShell2.actions ? inputShell2.actions : null,
                inputState: inputShell2,
                restoreSession: function (id) {
                  return fetch("/bubble/unarchive", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ sessionId: id }),
                    keepalive: true
                  }).then(function (r) { return r.json(); }).then(function (d) {
                    log("debug", "reset", "恢复完成（unarchive）", { sessionId: id, ok: !!(d && d.ok) });
                    return !!(d && d.ok);
                  }).catch(function () { return false; });
                },
              };
            }
          }, UserBubbleView);
        });
        // 设置卡片（设置 → 插件 → 插件配置）：不受总开关门控，否则关掉后就再也打不开了
        var d4 = ctx.slots.inject("settings.plugin.item", function () {
          return ctx.slots.register({
            name: "settings.plugin.item",
            key: "dsh-message-recall",
            id: "dsh-message-recall",
            order: 30,
            inject: function () {
              return {
                openSession: function (id) { ctx.sessions.open(id); },
                ctxSessions: ctx.sessions
              };
            }
          }, MessageRecallSettingsCard);
        });
        if (typeof d4 === "function") disposers.push(d4);
        // 版本翻页器 < X >：assistant 消息操作区（最后回答底部）；同样受总开关门控
        gatedSlot("conversation.chat.assistant-actions", function () {
          return ctx.slots.register({
            name: "conversation.chat.assistant-actions",
            id: "dsh-message-recall-version-pager",
            order: 10,
            inject: function () {
              return {
                openSession: function (id) { ctx.sessions.open(id); },
                ctxSessions: ctx.sessions,
                archiveSession: function (id) {
                  // review #5：官方 archiveSession 幂等且 sessionKnown 接受归档会话（dsh-workspace L424/L439）——
                  // 旧观察"非 live 必抛"不成立，删 host /bubble/archive 中转，直调官方
                  try {
                    return Promise.resolve(ctx.workspaces.archiveSession(id)).then(function (ok) {
                      log("debug", "pager", "归档结果（官方直调）", { id: id, ok: ok !== false });
                      return ok !== false;
                    }).catch(function (e) {
                      log("warn", "pager", "归档失败（官方直调）", { id: id, err: String(e && e.message ? e.message : e) });
                      return false;
                    });
                  } catch (e) {
                    log("warn", "pager", "归档异常", { id: id, err: String(e && e.message ? e.message : e) });
                    return Promise.resolve(false);
                  }
                },
                currentSessionId: function () {
                  try { var s = ctx.sessions.list.getSnapshot(); return s ? s.current : null; } catch (e) { return null; }
                },
                restoreSession: function (id) {
                  return fetch("/bubble/unarchive", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ sessionId: id }),
                    keepalive: true
                  }).then(function (r) { return r.json(); }).then(function (d) {
                    if (d && d.ok && d.restored) log("info", "pager", "版本会话已恢复（unarchive）", { sessionId: id });
                    return !!(d && d.ok);
                  }).catch(function () { return false; });
                }
              };
            }
          }, VersionPager);
        });
        // 总开关变化 → 重新执行门控注册（关闭即撤掉贡献，宿主官方渲染接管）
        var gateUnsub = subscribeEnabled(function () {
          for (var gi = 0; gi < gateRunners.length; gi++) {
            try { gateRunners[gi](); } catch (e) { /* ignore */ }
          }
        });
        disposers.push(function () { try { gateUnsub(); } catch (e) { /* ignore */ } });
        for (var gd = 0; gd < gateDisposers.length; gd++) disposers.push(gateDisposers[gd]);
        return function () {
          for (var i = 0; i < disposers.length; i++) disposers[i]();
          if (styleTag !== null) styleTag.remove();
          log("info", "lifecycle", "client half unloaded");
        };
      }, "dsh-message-recall: UserBubbleView overlay");
    }

    return { name: "dsh-message-recall", inject: ["slots", "sessions", "workspaces", "conversation", "locale", "modelDirectories"], apply: apply };
  }
});

