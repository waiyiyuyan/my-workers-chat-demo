var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-VcloFa/checked-fetch.js
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
import HTML from "./2a4d9efe104a4d3a896c95c5930df6e016214a34-chat.html";
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({ error: err.stack }));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, { status: 500 });
    }
  }
}
__name(handleErrors, "handleErrors");
var chat_default = {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);
      let path = url.pathname.slice(1).split("/");
      if (!path[0]) {
        return new Response(HTML, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }
      switch (path[0]) {
        case "api":
          return handleApiRequest(path.slice(1), request, env);
        default:
          return new Response("Not found", { status: 404 });
      }
    });
  }
};
async function handleApiRequest(path, request, env) {
  switch (path[0]) {
    case "room": {
      if (!path[1]) {
        if (request.method == "POST") {
          let id2 = env.rooms.newUniqueId();
          return new Response(id2.toString(), {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type"
            }
          });
        } else if (request.method === "OPTIONS") {
          return new Response(null, {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
              "Access-Control-Max-Age": "86400"
            }
          });
        } else {
          return new Response("Method not allowed", {
            status: 405,
            headers: { "Access-Control-Allow-Origin": "*" }
          });
        }
      }
      let name = path[1];
      let id;
      if (name.match(/^[0-9a-f]{64}$/)) {
        id = env.rooms.idFromString(name);
      } else if (name.length <= 32) {
        id = env.rooms.idFromName(name);
      } else {
        return new Response("Name too long", {
          status: 404,
          headers: { "Access-Control-Allow-Origin": "*" }
        });
      }
      let roomObject = env.rooms.get(id);
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");
      return roomObject.fetch(newUrl, request);
    }
    default:
      return new Response("Not found", {
        status: 404,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
  }
}
__name(handleApiRequest, "handleApiRequest");
var ChatRoom = class {
  static {
    __name(this, "ChatRoom");
  }
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.sessions = /* @__PURE__ */ new Map();
    this.onlineUsers = /* @__PURE__ */ new Set();
    this.lastTimestamp = 0;
    this.state.getWebSockets().forEach((webSocket) => {
      let meta = webSocket.deserializeAttachment() || {};
      let limiterId = meta.limiterId ? this.env.limiters.idFromString(meta.limiterId) : this.env.limiters.idFromName("default");
      let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        (err) => webSocket.close(1011, err.stack)
      );
      let blockedMessages = [];
      this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
      if (meta.name) this.onlineUsers.add(meta.name);
    });
  }
  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS, Upgrade",
            "Access-Control-Allow-Headers": "Content-Type, Upgrade",
            "Access-Control-Max-Age": "86400"
          }
        });
      }
      switch (url.pathname) {
        case "/websocket": {
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", {
              status: 400,
              headers: { "Access-Control-Allow-Origin": "*" }
            });
          }
          let ip = request.headers.get("CF-Connecting-IP") || "unknown-ip";
          let pair = new WebSocketPair();
          await this.handleSession(pair[1], ip);
          return new Response(null, { status: 101, webSocket: pair[0] });
        }
        default:
          return new Response("Not found", {
            status: 404,
            headers: { "Access-Control-Allow-Origin": "*" }
          });
      }
    });
  }
  async handleSession(webSocket, ip) {
    this.state.acceptWebSocket(webSocket);
    let limiterId = this.env.limiters.idFromName(ip);
    let limiter = new RateLimiterClient(
      () => this.env.limiters.get(limiterId),
      (err) => webSocket.close(1011, err.stack)
    );
    let session = {
      limiterId: limiterId.toString(),
      limiter,
      blockedMessages: [],
      name: "",
      quit: false
    };
    webSocket.serializeAttachment({
      ...webSocket.deserializeAttachment() || {},
      limiterId: limiterId.toString()
    });
    this.sessions.set(webSocket, session);
    session.blockedMessages.push(JSON.stringify({
      type: "system",
      onlineUsers: Array.from(this.onlineUsers)
    }));
    for (let otherSession of this.sessions.values()) {
      if (otherSession.name && otherSession.name !== session.name) {
        session.blockedMessages.push(JSON.stringify({
          type: "system",
          joined: otherSession.name
        }));
      }
    }
    try {
      let storage = await this.storage.list({ reverse: true, limit: 100 });
      let backlog = [...storage.values()].reverse().filter((item) => {
        try {
          const msg = JSON.parse(item);
          return !!msg && typeof msg === "object" && !!msg.name && !!msg.message && !!msg.timestamp;
        } catch (e) {
          return false;
        }
      });
      backlog.forEach((value) => session.blockedMessages.push(value));
    } catch (err) {
      console.error("\u52A0\u8F7D\u5386\u53F2\u6D88\u606F\u5931\u8D25:", err);
    }
    webSocket.addEventListener("message", (event) => this.webSocketMessage(webSocket, event.data));
    webSocket.addEventListener("close", (event) => this.webSocketClose(webSocket, event.code, event.reason, event.wasClean));
    webSocket.addEventListener("error", (error) => this.webSocketError(webSocket, error));
    this.flushBlockedMessages(webSocket);
  }
  // 刷新阻塞消息队列
  flushBlockedMessages(webSocket) {
    const session = this.sessions.get(webSocket);
    if (!session || !session.blockedMessages || session.quit) return;
    try {
      while (session.blockedMessages.length > 0) {
        const msg = session.blockedMessages.shift();
        webSocket.send(msg);
      }
    } catch (err) {
      console.error("\u53D1\u9001\u963B\u585E\u6D88\u606F\u5931\u8D25:", err);
      session.quit = true;
      this.sessions.delete(webSocket);
    }
  }
  async webSocketMessage(webSocket, msg) {
    try {
      let session = this.sessions.get(webSocket);
      if (!session || session.quit) {
        webSocket.close(1011, "Session invalid or closed");
        return;
      }
      let data = {};
      try {
        data = msg ? JSON.parse(msg) : {};
      } catch (e) {
        webSocket.send(JSON.stringify({
          type: "error",
          message: "Invalid JSON format"
        }));
        return;
      }
      const needLimit = !["heartbeat", "getUsers", "getHistory"].includes(data.type);
      if (!session.limiter.checkLimit(needLimit)) {
        webSocket.send(JSON.stringify({
          type: "error",
          message: "Your IP is being rate-limited, please try again later."
        }));
        return;
      }
      if (data.type === "getUsers") {
        webSocket.send(JSON.stringify({
          type: "system",
          onlineUsers: Array.from(this.onlineUsers)
        }));
        return;
      }
      if (data.type === "heartbeat") {
        webSocket.send(JSON.stringify({
          type: "heartbeat",
          time: Date.now()
        }));
        return;
      }
      if (data.type === "getHistory") {
        try {
          let storage = await this.storage.list({ reverse: true, limit: 100 });
          let backlog = [...storage.values()].reverse().map((item) => {
            try {
              const msg2 = JSON.parse(item);
              return {
                type: "chat",
                name: msg2.name || "\u672A\u77E5\u7528\u6237",
                message: msg2.message || "",
                timestamp: msg2.timestamp || Date.now(),
                isImage: !!msg2.isImage,
                clientId: msg2.clientId || "",
                messageId: msg2.messageId || ""
              };
            } catch (e) {
              return null;
            }
          }).filter(Boolean);
          webSocket.send(JSON.stringify({
            type: "history",
            history: backlog
          }));
        } catch (err) {
          console.error("\u83B7\u53D6\u5386\u53F2\u6D88\u606F\u5931\u8D25:", err);
          webSocket.send(JSON.stringify({
            type: "error",
            message: "Failed to load history messages"
          }));
        }
        return;
      }
      if (!session.name) {
        session.name = (data.name || "anonymous").trim();
        if (session.name.length > 32) {
          webSocket.send(JSON.stringify({
            type: "error",
            message: "Name too long (max 32 characters)"
          }));
          webSocket.close(1009, "Name too long");
          return;
        }
        webSocket.serializeAttachment({
          ...webSocket.deserializeAttachment() || {},
          name: session.name,
          limiterId: session.limiterId
        });
        this.onlineUsers.add(session.name);
        this.flushBlockedMessages(webSocket);
        this.broadcast({
          type: "system",
          joined: session.name,
          onlineUsers: Array.from(this.onlineUsers)
        });
        webSocket.send(JSON.stringify({ ready: true }));
        return;
      }
      const chatMessage = {
        type: "chat",
        name: session.name || "\u672A\u77E5\u7528\u6237",
        message: (data.message || "").trim(),
        isImage: !!data.isImage || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(data.message),
        clientId: data.clientId || "",
        messageId: data.messageId || "",
        timestamp: Math.max(Date.now(), this.lastTimestamp + 1)
      };
      if (chatMessage.message.length > 256) {
        webSocket.send(JSON.stringify({
          type: "error",
          message: "Message too long (max 256 characters)"
        }));
        return;
      }
      if (chatMessage.message.length === 0 && !chatMessage.isImage) {
        return;
      }
      this.lastTimestamp = chatMessage.timestamp;
      const messageStr = JSON.stringify(chatMessage);
      if (chatMessage.messageId) {
        const content = chatMessage.message || "";
        const contentHash = content ? btoa(unescape(encodeURIComponent(content.substring(0, 20)))) : "empty";
        const combinedMsgId = `${chatMessage.name}_${chatMessage.timestamp}_${contentHash}_${chatMessage.messageId}`;
        webSocket.send(JSON.stringify({
          type: "msgAck",
          msgId: combinedMsgId,
          // 改为组合msgId
          originalMsgId: chatMessage.messageId,
          // 可选：携带原始msgId，兼容旧逻辑
          timestamp: chatMessage.timestamp
        }));
      }
      this.broadcast(messageStr);
      try {
        const key = new Date(chatMessage.timestamp).toISOString();
        await this.storage.put(key, messageStr);
      } catch (err) {
        console.error("\u4FDD\u5B58\u6D88\u606F\u5931\u8D25:", err);
      }
      try {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1e3;
        const sevenDaysAgoISO = new Date(sevenDaysAgo).toISOString();
        let oldMessages = await this.storage.list({ end: sevenDaysAgoISO });
        let oldKeys = [...oldMessages.keys()];
        if (oldKeys.length > 0) {
          const batchSize = 10;
          for (let i = 0; i < oldKeys.length; i += batchSize) {
            const batch = oldKeys.slice(i, i + batchSize);
            await Promise.all(
              batch.map((key) => this.storage.delete(key).catch((err) => console.error(`\u5220\u9664\u65E7\u6D88\u606F\u5931\u8D25: ${key}`, err)))
            );
          }
        }
      } catch (err) {
        console.error("\u6E05\u7406\u65E7\u6D88\u606F\u5931\u8D25:", err);
      }
    } catch (err) {
      console.error("\u5904\u7406WebSocket\u6D88\u606F\u5931\u8D25:", err);
      const session = this.sessions.get(webSocket);
      if (session) session.quit = true;
      webSocket.send(JSON.stringify({
        type: "error",
        message: "Failed to process message"
      }));
      webSocket.close(1011, "Internal error");
    }
  }
  // 通用关闭/错误处理
  async closeOrErrorHandler(webSocket) {
    let session = this.sessions.get(webSocket) || {};
    if (session.quit) return;
    session.quit = true;
    this.sessions.delete(webSocket);
    if (session.name) {
      this.onlineUsers.delete(session.name);
      this.broadcast({
        type: "system",
        quit: session.name,
        onlineUsers: Array.from(this.onlineUsers)
      });
    }
  }
  async webSocketClose(webSocket, code, reason, wasClean) {
    await this.closeOrErrorHandler(webSocket);
  }
  async webSocketError(webSocket, error) {
    console.error("WebSocket\u9519\u8BEF:", error);
    await this.closeOrErrorHandler(webSocket);
  }
  // 消息广播方法
  broadcast(message) {
    if (!message) {
      console.warn("\u5FFD\u7565\u7A7A\u6D88\u606F\u5E7F\u64AD");
      return;
    }
    let messageStr;
    if (typeof message === "object" && message !== null) {
      if (!message.type) {
        message.type = message.joined || message.quit || message.onlineUsers ? "system" : "chat";
      }
      messageStr = JSON.stringify(message);
    } else if (typeof message === "string") {
      try {
        JSON.parse(message);
        messageStr = message;
      } catch (e) {
        console.error("\u5E7F\u64AD\u6D88\u606F\u89E3\u6790\u5931\u8D25:", e, message);
        return;
      }
    } else {
      console.warn("\u65E0\u6548\u7684\u5E7F\u64AD\u6D88\u606F\u7C7B\u578B:", typeof message);
      return;
    }
    let quitters = [];
    this.sessions.forEach((session, webSocket) => {
      if (session.quit) return;
      try {
        if (session.name) {
          webSocket.send(messageStr);
        } else {
          session.blockedMessages.push(messageStr);
        }
      } catch (err) {
        console.error("\u5E7F\u64AD\u6D88\u606F\u5230\u4F1A\u8BDD\u5931\u8D25:", err);
        session.quit = true;
        quitters.push({ session, webSocket });
      }
    });
    quitters.forEach(({ session, webSocket }) => {
      this.sessions.delete(webSocket);
      if (session.name) {
        this.onlineUsers.delete(session.name);
        this.broadcast({
          type: "system",
          quit: session.name,
          onlineUsers: Array.from(this.onlineUsers)
        });
      }
    });
  }
};
var RateLimiter = class {
  static {
    __name(this, "RateLimiter");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.nextAllowedTime = 0;
    this.maxRequests = 10;
    this.timeWindow = 10;
    this.requests = [];
  }
  async fetch(request) {
    return await handleErrors(request, async () => {
      let storedRequests = await this.state.storage.get("requests") || [];
      let storedNextAllowed = await this.state.storage.get("nextAllowedTime") || 0;
      this.requests = storedRequests;
      this.nextAllowedTime = storedNextAllowed;
      const now = Date.now() / 1e3;
      this.requests = this.requests.filter((time) => time > now - this.timeWindow);
      let cooldown = 0;
      if (request.method === "POST") {
        if (this.requests.length >= this.maxRequests) {
          const earliestRequest = this.requests[0];
          cooldown = Math.max(0, earliestRequest + this.timeWindow - now);
          this.nextAllowedTime = now + cooldown;
        } else {
          this.requests.push(now);
          this.nextAllowedTime = now;
          cooldown = 0;
        }
      }
      await Promise.all([
        this.state.storage.put("requests", this.requests),
        this.state.storage.put("nextAllowedTime", this.nextAllowedTime)
      ]);
      return new Response(cooldown.toString(), {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "text/plain"
        }
      });
    });
  }
};
var RateLimiterClient = class {
  static {
    __name(this, "RateLimiterClient");
  }
  constructor(getLimiterStub, reportError) {
    this.getLimiterStub = getLimiterStub;
    this.reportError = reportError;
    this.limiter = getLimiterStub();
    this.inCooldown = false;
  }
  // 支持传入是否需要限流，非聊天消息直接跳过
  checkLimit(needLimit = true) {
    if (!needLimit) return true;
    if (this.inCooldown) return false;
    this.inCooldown = true;
    this.callLimiter().catch((err) => this.reportError(err));
    return true;
  }
  async callLimiter() {
    try {
      let response;
      try {
        response = await this.limiter.fetch("https://dummy-url", { method: "POST" });
      } catch (err) {
        console.warn("\u9650\u6D41\u5668\u8C03\u7528\u5931\u8D25\uFF0C\u91CD\u8BD5\u4E2D:", err);
        this.limiter = this.getLimiterStub();
        response = await this.limiter.fetch("https://dummy-url", { method: "POST" });
      }
      const cooldown = parseFloat(await response.text());
      if (cooldown > 0) {
        await new Promise((resolve) => setTimeout(resolve, cooldown * 1e3));
      }
      this.inCooldown = false;
    } catch (err) {
      this.reportError(err);
      setTimeout(() => {
        this.inCooldown = false;
      }, 5e3);
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

// .wrangler/tmp/bundle-VcloFa/middleware-insertion-facade.js
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

// .wrangler/tmp/bundle-VcloFa/middleware-loader.entry.ts
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
