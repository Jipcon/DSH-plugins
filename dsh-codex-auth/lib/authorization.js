/**
 * dsh-codex-auth — authorization 缝的本地兼容实现（host 半边，无外部依赖）。
 *
 * 背景：生产组合（dsh-base 系）挂载了 credentials-local 与 dsh-llm-pi-ai，
 * 却没有挂载 `@deepseek-ai/dsh-authorization`——全仓库只有测试在挂它，
 * 正式代码对它全是 `import type`。于是 `ctx.authorization` 在运行时根本不存在：
 *  - dsh-llm-pi-ai 的 `ctx.inject(['authorization'], …)` 永远等不到，Codex 等
 *    OAuth 流从未注册（官方 Models 页那句 "not supported here yet" 的底层原因）；
 *  - 任何声明 `inject: […'authorization'…]` 的第三方插件会静默 pending，apply
 *    永不执行（本插件第一版就是这么哑火的：有卡片、无路由、无日志）。
 *
 * 本文件是官方 `AuthorizationService`（packages/credentials/authorization/src/index.ts）
 * 的同语义 plain-JS 移植：零导入，只用传进来的 `ctx`（`ctx.effect / ctx.on /
 * ctx.emit|events / ctx.logger / ctx.credentials`）。方法名、校验顺序、错误码
 * （NO_FLOW / UNKNOWN_METHOD / ALREADY_IN_FLIGHT / NOT_COMMITTED）、单 key 单尝试、
 * 提交确认（attempt 内观察到 record-updated 且结束后仍 configured）、
 * `authorization/settled` 扇出（含监听器失败的 containment）都与官方一致，
 * 因此 dsh-llm-pi-ai 会把它当成原生 seam 用，把 Codex 流注册上来。
 *
 * 生效方式（见 lib/index.js）：启动时若 `ctx.get('authorization')` 缺失，
 * 就 `ctx.provide('authorization', local)` 就地补上；若未来官方组合自带了该服务，
 * 则直接用官方的，绝不重复提供（ DUPLICATE 由上游 Cordis 守卫，见下）。
 */

export class AuthorizationError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'AuthorizationError';
    this.code = code;
  }
}

export class AuthorizationDeclinedError extends AuthorizationError {
  constructor(message = 'the authorization prompt was declined') {
    super(message, 'DECLINED');
    this.name = 'AuthorizationDeclinedError';
  }
}

export class AuthorizationService {
  constructor(ctx) {
    this.ctx = ctx;
    this.flows = new Map();
    this.running = new Map();
  }

  /**
   * 登记一个凭据的获取方式。一 key 一流；重复认领抛 DUPLICATE_FLOW。
   * @returns 注销函数（同时撤回进行中的尝试）。
   */
  registerFlow(flow) {
    const self = this;
    const dispose = this.ctx.effect(function* () {
      if (self.flows.has(flow.key)) {
        throw new AuthorizationError(
          `an authorization flow for "${flow.key}" is already registered`, 'DUPLICATE_FLOW');
      }
      self.flows.set(flow.key, flow);
      yield () => {
        self.flows.delete(flow.key);
        try { self.running.get(flow.key)?.controller.abort(); } catch { /* ignore */ }
      };
    }, 'authorization.registerFlow()');
    return () => void dispose();
  }

  /** 全部已登记流的公开视图（注册顺序）。 */
  list() {
    return [...this.flows.values()].map((flow) => this.entry(flow));
  }

  /** 单个已登记流的公开视图，未认领返回 undefined。 */
  describe(key) {
    const flow = this.flows.get(key);
    return flow === undefined ? undefined : this.entry(flow);
  }

  entry(flow) {
    return {
      key: flow.key,
      label: flow.label,
      methods: flow.methods,
      inFlight: this.running.has(flow.key),
    };
  }

  /**
   * 从第二次调用撤回进行中的尝试（给拿不到第一次调用 signal 的请求/响应式
   * 传输准备，比如取消按钮）。
   */
  cancel(key) {
    try { this.running.get(key)?.controller.abort(); } catch { /* ignore */ }
  }

  /**
   * 跑一次授权尝试。成功（attempt 内提交并被观察到）返回
   * `{ status: 'authorized' }`；人拒绝或调用方撤回返回 `{ status: 'cancelled' }`；
   * 其余失败直接抛出（NO_FLOW / UNKNOWN_METHOD / ALREADY_IN_FLIGHT / NOT_COMMITTED）。
   */
  async begin(request) {
    const { key } = request;
    const flow = this.flows.get(key);
    if (flow === undefined) {
      throw new AuthorizationError(`no authorization flow is registered for "${key}"`, 'NO_FLOW');
    }
    const method = request.method ?? flow.methods[0].id;
    if (!flow.methods.some((candidate) => candidate.id === method)) {
      throw new AuthorizationError(
        `authorization flow for "${key}" offers no method "${method}"`, 'UNKNOWN_METHOD');
    }
    if (this.running.has(key)) {
      throw new AuthorizationError(
        `an authorization attempt for "${key}" is already running`, 'ALREADY_IN_FLIGHT');
    }
    // 调用前已撤回：不占槽、不跑 flow（把已 abort 的 signal 交给 flow，
    // 指望每个 flow 都在首个 await 前检查它——做不到的 flow 会占着 key 挂起）。
    if (request.signal?.aborted === true) return { status: 'cancelled' };
    const controller = new AbortController();
    const withdraw = () => { controller.abort(request.signal?.reason); };
    request.signal?.addEventListener('abort', withdraw, { once: true });
    this.running.set(key, { controller });
    let settlement = 'failed';
    try {
      const outcome = await this.attempt(flow, method, controller.signal, request.interaction);
      settlement = outcome.status;
      return outcome;
    } finally {
      request.signal?.removeEventListener('abort', withdraw);
      this.running.delete(key);
      // 先放槽再扇出：监听里紧接着开下一次尝试不会被拒。
      this.settle(key, settlement);
    }
  }

  /**
   * `authorization/settled` 扇出：每个监听器都跑，同步抛错与异步拒绝只记日志，
   * 不改变已结束尝试的自身结果——唯 `INVARIANT` 编码的失败在全部跑完后重抛。
   * 优先走 `ctx.events.dispatch` 拿监听器表做 containment；拿不到则退化为
   * `ctx.emit`（单个坏监听器可能挡住后面的——桥接场景下无监听器，此为纯保险）。
   */
  settle(key, settlement) {
    const dispatchable = this.ctx?.events;
    if (dispatchable && typeof dispatchable.dispatch === 'function') {
      let invariantFailure;
      let listeners = [];
      try {
        listeners = dispatchable.dispatch('emit', ['authorization/settled', key, settlement]);
      } catch (error) {
        this.warnSettledListenerFailure(key, error);
        return;
      }
      for (const listener of listeners) {
        try {
          const returned = listener(key, settlement);
          if (returned != null && typeof returned.then === 'function') {
            void Promise.resolve(returned).then(undefined, (error) => {
              this.warnSettledListenerFailure(key, error);
            });
          }
        } catch (error) {
          if (error?.code === 'INVARIANT') {
            invariantFailure ??= error;
            continue;
          }
          this.warnSettledListenerFailure(key, error);
        }
      }
      if (invariantFailure !== undefined) throw invariantFailure;
      return;
    }
    try {
      this.ctx.emit('authorization/settled', key, settlement);
    } catch (error) {
      this.warnSettledListenerFailure(key, error);
    }
  }

  warnSettledListenerFailure(key, error) {
    try {
      this.ctx.logger.warn('authorization: an authorization/settled listener for "%s" failed', key);
      this.ctx.logger.warn(error);
    } catch { /* 日志路径自身异常不破坏结算 */ }
  }

  /**
   * 跑 flow 并守住它的提交契约：`run()` 返回即代表本 attempt 内已提交。
   * 撤回的尝试无论 flow 理不理 signal 都立即以 cancelled 结算（被遗弃的 run
   * 任其自行结束；它若仍提交了记录，那也是人确实授权过的）。
   */
  async attempt(flow, method, signal, interaction) {
    const withdrawn = new Promise((resolve) => {
      signal.addEventListener('abort', () => { resolve('withdrawn'); }, { once: true });
    });
    // 闭包属性而非局部变量：prompt 包装第一手看到 decline（flow 半路重包
    // 也藏不住）；提交确认必须确认"发生在当下"（重授权时记录本就存在，
    // 只看存在会让没写任何东西的 flow 拿陈旧凭据冒充新鲜授权）。
    const observed = { declined: false, committed: false };
    let unwatch = () => {};
    try {
      unwatch = this.ctx.on('credentials/record-updated', (updatedKey) => {
        if (updatedKey === flow.key) observed.committed = true;
      });
    } catch { unwatch = () => {}; }
    try {
      const running = flow.run({
        method,
        signal,
        notify: (notice) => {
          try {
            interaction.notify(notice);
          } catch (error) {
            try {
              this.ctx.logger.warn('authorization: the interaction surface failed to render a notice');
              this.ctx.logger.warn(error);
            } catch { /* ignore */ }
          }
        },
        prompt: (prompt) => interaction.prompt(prompt).catch((error) => {
          if (error instanceof AuthorizationDeclinedError) observed.declined = true;
          throw error;
        }),
      });
      try {
        if (await Promise.race([running.then(() => 'ran'), withdrawn]) === 'withdrawn') {
          void running.catch(() => {
            try { this.ctx.logger.debug('authorization: withdrawn flow failed after the fact'); } catch { /* ignore */ }
          });
          return { status: 'cancelled' };
        }
      } catch (error) {
        // 撤回与被拒是"结果"不是"故障"；其余一律是 flow 失败，原样抛给调用方。
        if (signal.aborted || observed.declined) return { status: 'cancelled' };
        throw error;
      }
    } finally {
      try { unwatch(); } catch { /* ignore */ }
    }
    if (!observed.committed) {
      throw new AuthorizationError(
        `authorization flow for "${flow.key}" resolved without committing a credential record in this attempt`,
        'NOT_COMMITTED');
    }
    let stored = null;
    try {
      stored = await this.ctx.credentials.describeRecord(flow.key);
    } catch (error) {
      throw new AuthorizationError(
        `authorization flow for "${flow.key}" cannot be confirmed: ${error?.message ?? error}`,
        'NOT_COMMITTED');
    }
    if (!stored?.configured) {
      throw new AuthorizationError(
        `authorization flow for "${flow.key}" deleted its credential record instead of committing one`,
        'NOT_COMMITTED');
    }
    return { status: 'authorized' };
  }
}

export default AuthorizationService;
