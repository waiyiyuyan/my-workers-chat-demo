var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-tXNC6k/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// src/chat.mjs
import HTML from "./bdc088fe4da6acfd8cb850837a916dd180025579-chat.html";
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") === "websocket") {
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({ error: err.stack || String(err) }));
      pair[1].close(1011, "Error");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response(err.stack || "Error", { status: 500 });
  }
}
__name(handleErrors, "handleErrors");
var chat_default = {
  // 每天 UTC 04:00（北京时间中午12点）自动清空所有房间
  async scheduled(event, env, ctx) {
    const list = await env.rooms.list();
    for (const key of list.keys) {
      const id = env.rooms.idFromName(key.name);
      const room = env.rooms.get(id);
      await room.fetch("https://fake.host/clear-all-2025");
    }
  },
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      const url = new URL(request.url);
      const path = url.pathname.slice(1).split("/");
      if (!path[0]) {
        return new Response(HTML, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }
      if (path[0] === "api" && path[1] === "room") {
        if (!path[2] && request.method === "POST") {
          const id2 = env.rooms.newUniqueId();
          return new Response(id2.toString());
        }
        const name = path[2];
        if (!name) return new Response("Bad Request", { status: 400 });
        const id = /^[0-9a-f]{64}$/.test(name) ? env.rooms.idFromString(name) : env.rooms.idFromName(name);
        const room = env.rooms.get(id);
        const newUrl = new URL(request.url);
        newUrl.pathname = "/" + path.slice(3).join("/");
        return room.fetch(newUrl, request);
      }
      return new Response("Not found", { status: 404 });
    });
  }
};
var ChatRoom = class {
  static {
    __name(this, "ChatRoom");
  }
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.sessions = /* @__PURE__ */ new Map();
    this.lastTimestamp = 0;
  }
  async fetch(request) {
    return await handleErrors(request, async () => {
      const url = new URL(request.url);
      if (url.pathname === "/clear-all-2025") {
        await this.storage.deleteAll();
        this.lastTimestamp = 0;
        this.broadcast({ ready: true });
        return new Response("Room cleared");
      }
      if (url.pathname === "/websocket") {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("expected websocket", { status: 400 });
        }
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const pair = new WebSocketPair();
        await this.handleSession(pair[1], ip);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      return new Response("Not found", { status: 404 });
    });
  }
  async handleSession(ws, ip) {
    this.state.acceptWebSocket(ws);
    const limiterId = this.env.limiters.idFromName(ip);
    const limiter = new RateLimiterClient(
      () => this.env.limiters.get(limiterId),
      () => ws.close(1011, "Rate limited")
    );
    this.sessions.set(ws, {
      name: null,
      limiter,
      blockedMessages: []
    });
    const entries = await this.storage.list({ reverse: true, limit: 300 });
    const messages = [...entries.values()].reverse();
    messages.forEach((m) => ws.send(m));
  }
  async webSocketMessage(ws, message) {
    const session = this.sessions.get(ws);
    if (!session) return;
    try {
      const data = JSON.parse(message);
      if (data.name) {
        const raw = "" + data.name;
        const [displayName, uniqueId] = raw.split("##");
        const safeName = (displayName || "\u533F\u540D").slice(0, 32);
        const sessionId = uniqueId || crypto.randomUUID();
        session.displayName = safeName;
        session.sessionId = sessionId;
        ws.serializeAttachment({ sessionId });
        session.blockedMessages.forEach((m) => ws.send(m));
        session.blockedMessages = null;
        ws.send(JSON.stringify({ ready: true }));
        this.broadcast({ joined: safeName });
        return;
      }
      if (data.message && data.message.length > 256) {
        ws.send(JSON.stringify({ error: "\u6D88\u606F\u8FC7\u957F\uFF0C\u8BF7\u5206\u6BB5\u53D1\u9001" }));
        return;
      }
      if (data.message && session.displayName && session.limiter.checkLimit()) {
        const msgObj = {
          name: session.displayName,
          message: "" + data.message,
          timestamp: Math.max(Date.now(), this.lastTimestamp + 1)
        };
        this.lastTimestamp = msgObj.timestamp;
        const msgStr = JSON.stringify(msgObj);
        this.broadcast(msgStr);
        const keys = await this.storage.list({ limit: 1e3 });
        const toDelete = [...keys.keys()].sort().slice(0, -300);
        if (toDelete.length) {
          await Promise.all(toDelete.map((k) => this.storage.delete(k)));
        }
        await this.storage.put(msgObj.timestamp.toString(), msgStr);
      }
    } catch (e) {
      console.error(e);
    }
  }
  webSocketClose(ws) {
    this.cleanup(ws);
  }
  webSocketError(ws) {
    this.cleanup(ws);
  }
  cleanup(ws) {
    try {
      const session = this.sessions.get(ws);
      if (session?.displayName) {
        this.broadcast({ quit: session.displayName });
      }
      this.sessions.delete(ws);
    } catch (e) {
      console.error("Cleanup error:", e);
    }
  }
  broadcast(message) {
    const str = typeof message === "string" ? message : JSON.stringify(message);
    this.sessions.forEach((s, ws) => {
      try {
        if (s.blockedMessages) {
          s.blockedMessages.push(str);
        } else {
          ws.send(str);
        }
      } catch (e) {
      }
    });
  }
};
var RateLimiter = class {
  static {
    __name(this, "RateLimiter");
  }
  constructor() {
    this.nextAllowedTime = 0;
  }
  async fetch(request) {
    const now = Date.now() / 1e3;
    this.nextAllowedTime = Math.max(now, this.nextAllowedTime);
    if (request.method === "POST") this.nextAllowedTime += 5;
    const cooldown = Math.max(0, this.nextAllowedTime - now - 20);
    return new Response(cooldown);
  }
};
var RateLimiterClient = class {
  static {
    __name(this, "RateLimiterClient");
  }
  constructor(getStub, onError) {
    this.getStub = getStub;
    this.onError = onError;
    this.stub = getStub();
    this.cooldown = false;
  }
  checkLimit() {
    if (this.cooldown) return false;
    this.cooldown = true;
    this.apply();
    return true;
  }
  async apply() {
    try {
      const resp = await this.stub.fetch("https://fake.host", { method: "POST" });
      const wait = Number(await resp.text());
      await new Promise((r) => setTimeout(r, wait * 1e3));
      this.cooldown = false;
    } catch (e) {
      this.stub = this.getStub();
      this.apply();
    }
  }
};

// C:/Users/Administrator/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// C:/Users/Administrator/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-tXNC6k/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = chat_default;

// C:/Users/Administrator/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-tXNC6k/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  ChatRoom,
  RateLimiter,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=chat.js.map
