// This is the Edge Chat Demo Worker, built using Durable Objects!

// ===============================
// Introduction to Modules
// ===============================

import HTML from "./chat.html";

// `handleErrors()` utility
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack}));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, {status: 500});
    }
  }
}

// Main Worker export (fetch handler only, no need for scheduled)
export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      }

      switch (path[0]) {
        case "api":
          return handleApiRequest(path.slice(1), request, env);
        default:
          return new Response("Not found", {status: 404});
      }
    });
  }
}

// API request handler
async function handleApiRequest(path, request, env) {
  switch (path[0]) {
    case "room": {
      if (!path[1]) {
        if (request.method == "POST") {
          let id = env.rooms.newUniqueId();
          return new Response(id.toString(), {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type"
            }
          });
        } else if (request.method === "OPTIONS") {
          // 处理跨域预检请求
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
            headers: {"Access-Control-Allow-Origin": "*"}
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
          headers: {"Access-Control-Allow-Origin": "*"}
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
        headers: {"Access-Control-Allow-Origin": "*"}
      });
  }
}

// ChatRoom Durable Object Class
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.sessions = new Map();
    this.onlineUsers = new Set();
    this.lastTimestamp = 0;
    // 新增：维护已广播的消息ID集合，防止重复广播（全局去重）
    this.broadcastedMsgIds = new Set();
    // 新增：消息ID过期时间（5分钟，与前端队列清理时间一致）
    this.msgIdExpireTime = 5 * 60 * 1000;

    // 恢复重连的 WebSocket 会话
    this.state.getWebSockets().forEach((webSocket) => {
      let meta = webSocket.deserializeAttachment() || {}; // 兜底空对象
      let limiterId = meta.limiterId ? this.env.limiters.idFromString(meta.limiterId) : this.env.limiters.idFromName("default");
      let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack)
      );
      let blockedMessages = [];
      this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
      // 恢复重连用户到在线列表
      if (meta.name) this.onlineUsers.add(meta.name);
    });

    // 新增：定时清理过期的消息ID，释放内存
    this.cleanExpiredMsgIds = setInterval(() => {
      const now = Date.now();
      this.broadcastedMsgIds.forEach((item) => {
        if (typeof item === 'object' && item.msgId && item.timestamp && (now - item.timestamp > this.msgIdExpireTime)) {
          this.broadcastedMsgIds.delete(item);
        }
      });
    }, 60 * 1000); // 每分钟清理一次
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);
      // 处理跨域预检请求
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
              headers: {"Access-Control-Allow-Origin": "*"}
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
            headers: {"Access-Control-Allow-Origin": "*"}
          });
      }
    });
  }

  async handleSession(webSocket, ip) {
    // 接受 WebSocket 连接并绑定到 Durable Object 状态
    this.state.acceptWebSocket(webSocket);
    // 基于 IP 创建限流器 ID
    let limiterId = this.env.limiters.idFromName(ip);
    let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack)
    );
    // 初始化会话信息
    let session = { 
      limiterId: limiterId.toString(), 
      limiter, 
      blockedMessages: [],
      name: "",
      quit: false
    };
    // 序列化附件（用于重连恢复）
    webSocket.serializeAttachment({ 
      ...(webSocket.deserializeAttachment() || {}), 
      limiterId: limiterId.toString() 
    });
    this.sessions.set(webSocket, session);

    // 预加载在线用户列表到新连接
    session.blockedMessages.push(JSON.stringify({
      type: "system",
      onlineUsers: Array.from(this.onlineUsers)
    }));

    // 通知新连接已有在线用户
    for (let otherSession of this.sessions.values()) {
      if (otherSession.name && otherSession.name !== session.name) {
        session.blockedMessages.push(JSON.stringify({
          type: "system",
          joined: otherSession.name
        }));
      }
    }

    // 加载历史消息（最多100条有效消息）
    try {
      let storage = await this.storage.list({reverse: true, limit: 100});
      let backlog = [...storage.values()].reverse().filter(item => {
        try {
          const msg = JSON.parse(item);
          // 只保留有效聊天消息，同时记录消息ID用于去重
          const isValid = !!msg && typeof msg === "object" 
            && !!msg.name && !!msg.message && !!msg.timestamp;
          if (isValid && msg.messageId) {
            this.broadcastedMsgIds.add({
              msgId: msg.messageId,
              timestamp: msg.timestamp
            });
          }
          return isValid;
        } catch (e) {
          return false; // 过滤解析失败的消息
        }
      });
      backlog.forEach(value => session.blockedMessages.push(value));
    } catch (err) {
      console.error("加载历史消息失败:", err);
    }

    // 注册消息、关闭、错误处理回调
    webSocket.addEventListener("message", (event) => this.webSocketMessage(webSocket, event.data));
    webSocket.addEventListener("close", (event) => this.webSocketClose(webSocket, event.code, event.reason, event.wasClean));
    webSocket.addEventListener("error", (error) => this.webSocketError(webSocket, error));

    // 立即发送阻塞的初始化消息
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
      console.error("发送阻塞消息失败:", err);
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

    // 解析消息数据（兜底空对象）
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

    // 标记是否需要限流（心跳/获取用户/获取历史消息跳过限流）
    const needLimit = !['heartbeat', 'getUsers', 'getHistory'].includes(data.type);
    
    // 检查限流（传入是否需要限流的标记）
    if (!session.limiter.checkLimit(needLimit)) {
      webSocket.send(JSON.stringify({
        type: "error",
        message: "Your IP is being rate-limited, please try again later."
      }));
      return;
    }

    // 处理获取在线用户请求
    if (data.type === 'getUsers') {
      webSocket.send(JSON.stringify({
        type: "system",
        onlineUsers: Array.from(this.onlineUsers)
      }));
      return;
    }

    // 处理心跳请求（维持连接）
    if (data.type === 'heartbeat') {
      webSocket.send(JSON.stringify({
        type: 'heartbeat',
        time: Date.now()
      }));
      return;
    }

    // 处理历史消息请求（优化：过滤前端已渲染的消息ID）
    if (data.type === 'getHistory') {
      try {
        let storage = await this.storage.list({reverse: true, limit: 100});
        let backlog = [...storage.values()].reverse().map(item => {
          try {
            const msg = JSON.parse(item);
            // 消息字段兜底
            return {
              type: "chat",
              name: msg.name || "未知用户",
              message: msg.message || "",
              timestamp: msg.timestamp || Date.now(),
              isImage: !!msg.isImage,
              clientId: msg.clientId || "",
              messageId: msg.messageId || ""
            };
          } catch (e) {
            return null;
          }
        }).filter(Boolean); // 过滤无效消息

        // 过滤前端已渲染的消息
        const renderedMsgIds = data.renderedMsgIds || [];
        backlog = backlog.filter(msg => !renderedMsgIds.includes(msg.messageId));

        webSocket.send(JSON.stringify({
          type: "history",
          history: backlog
        }));
      } catch (err) {
        console.error("获取历史消息失败:", err);
        webSocket.send(JSON.stringify({
          type: "error",
          message: "Failed to load history messages"
        }));
      }
      return;
    }

    // 处理用户登录（设置用户名）
    if (!session.name) {
      session.name = (data.name || "anonymous").trim();
      // 用户名长度校验
      if (session.name.length > 32) {
        webSocket.send(JSON.stringify({
          type: "error",
          message: "Name too long (max 32 characters)"
        }));
        webSocket.close(1009, "Name too long");
        return;
      }
      // 序列化用户名到附件（重连恢复）
      webSocket.serializeAttachment({
        ...(webSocket.deserializeAttachment() || {}),
        name: session.name,
        limiterId: session.limiterId
      });
      // 将用户加入在线列表
      this.onlineUsers.add(session.name);
      // 刷新初始化消息
      this.flushBlockedMessages(webSocket);
      // 广播用户加入通知
      this.broadcast({
        type: "system",
        joined: session.name,
        onlineUsers: Array.from(this.onlineUsers)
      });
      // 发送就绪通知
      webSocket.send(JSON.stringify({ready: true}));
      return;
    }

    // 处理普通聊天消息（优化：消息ID去重，避免重复处理）
    const chatMessage = {
      type: "chat",
      name: session.name || "未知用户",
      message: (data.message || "").trim(),
      isImage: !!data.isImage || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(data.message),
      clientId: data.clientId || "",
      messageId: data.messageId || "",
      timestamp: Math.max(Date.now(), this.lastTimestamp + 1)
    };

    // 消息长度校验
    if (chatMessage.message.length > 256) {
      webSocket.send(JSON.stringify({
        type: "error",
        message: "Message too long (max 256 characters)"
      }));
      return;
    }
    if (chatMessage.message.length === 0 && !chatMessage.isImage) {
      return; // 忽略空消息
    }

    // 新增：消息ID去重，已广播过的消息不再处理
    if (chatMessage.messageId) {
      const isMsgExisted = Array.from(this.broadcastedMsgIds).some(item => item.msgId === chatMessage.messageId);
      if (isMsgExisted) {
        // 已存在的消息，直接返回msgAck，不重复广播和存储
        webSocket.send(JSON.stringify({
          type: "msgAck",
          msgId: chatMessage.messageId,
          timestamp: chatMessage.timestamp
        }));
        return;
      }
      // 记录新消息ID，用于后续去重
      this.broadcastedMsgIds.add({
        msgId: chatMessage.messageId,
        timestamp: chatMessage.timestamp
      });
    }

    // 更新最后消息时间戳
    this.lastTimestamp = chatMessage.timestamp;
    const messageStr = JSON.stringify(chatMessage);

	// 优化：确保msgAck仅发送给消息发送方，不广播
	if (chatMessage.messageId) {
	  webSocket.send(JSON.stringify({
		type: "msgAck",
		msgId: chatMessage.messageId, // 与前端msgId完全一致
		timestamp: chatMessage.timestamp
	  }));
	}

    // 广播消息
    this.broadcast(messageStr, webSocket); // 传入发送方，避免给自己重复发送

    // 保存消息到持久化存储
    try {
      const key = new Date(chatMessage.timestamp).toISOString();
      await this.storage.put(key, messageStr);
    } catch (err) {
      console.error("保存消息失败:", err);
    }

    // 清理7天前的旧消息
    try {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const sevenDaysAgoISO = new Date(sevenDaysAgo).toISOString();
      let oldMessages = await this.storage.list({end: sevenDaysAgoISO});
      let oldKeys = [...oldMessages.keys()];
      if (oldKeys.length > 0) {
        const batchSize = 10;
        // 分批删除，避免请求超时
        for (let i = 0; i < oldKeys.length; i += batchSize) {
          const batch = oldKeys.slice(i, i + batchSize);
          await Promise.all(
            batch.map(key => this.storage.delete(key).catch(err => console.error(`删除旧消息失败: ${key}`, err)))
          );
        }
      }
    } catch (err) {
      console.error("清理旧消息失败:", err);
    }

  } catch (err) {
    console.error("处理WebSocket消息失败:", err);
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
    
    // 从在线列表移除用户并广播
    if (session.name) {
      this.onlineUsers.delete(session.name);
      this.broadcast({
        type: "system",
        quit: session.name,
        onlineUsers: Array.from(this.onlineUsers)
      });
    }

    // 新增：会话关闭时，清理定时器（避免内存泄漏）
    if (this.cleanExpiredMsgIds) {
      clearInterval(this.cleanExpiredMsgIds);
    }
  }

  async webSocketClose(webSocket, code, reason, wasClean) {
    await this.closeOrErrorHandler(webSocket);
  }

  async webSocketError(webSocket, error) {
    console.error("WebSocket错误:", error);
    await this.closeOrErrorHandler(webSocket);
  }

  // 消息广播方法（优化：排除发送方，避免重复接收）
  broadcast(message, senderWebSocket = null) {
    // 过滤无效消息
    if (!message) {
      console.warn("忽略空消息广播");
      return;
    }

    // 统一消息格式为JSON字符串
    let messageStr;
    if (typeof message === "object" && message !== null) {
      // 给系统消息自动标记类型
      if (!message.type) {
        message.type = (message.joined || message.quit || message.onlineUsers) ? "system" : "chat";
      }
      messageStr = JSON.stringify(message);
    } else if (typeof message === "string") {
      // 验证字符串是否为有效JSON
      try {
        JSON.parse(message);
        messageStr = message;
      } catch (e) {
        console.error("广播消息解析失败:", e, message);
        return;
      }
    } else {
      console.warn("无效的广播消息类型:", typeof message);
      return;
    }

    let quitters = [];
    // 遍历所有会话发送消息（排除发送方）
    this.sessions.forEach((session, webSocket) => {
      // 排除发送方，避免自己收到自己发送的消息
      if (webSocket === senderWebSocket || session.quit) return;
      try {
        if (session.name) {
          // 已登录用户直接发送
          webSocket.send(messageStr);
        } else {
          // 未登录用户加入阻塞队列
          session.blockedMessages.push(messageStr);
        }
      } catch (err) {
        // 发送失败标记为退出
        console.error("广播消息到会话失败:", err);
        session.quit = true;
        quitters.push({ session, webSocket });
      }
    });

    // 处理发送失败的会话
    quitters.forEach(({ session, webSocket }) => {
      this.sessions.delete(webSocket);
      if (session.name) {
        this.onlineUsers.delete(session.name);
        // 广播该用户退出
        this.broadcast({
          type: "system",
          quit: session.name,
          onlineUsers: Array.from(this.onlineUsers)
        });
      }
    });
  }
}

//----------------------------------

// 优化后的 RateLimiter Durable Object Class（放宽限流规则）
export class RateLimiter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.nextAllowedTime = 0;
    // 宽松限流规则：10秒内最多允许10条消息（可根据需求调整）
    this.maxRequests = 10; // 最大请求数
    this.timeWindow = 10;  // 时间窗口（秒）
    this.requests = [];    // 存储近期请求时间
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      // 从持久化存储恢复请求记录和限流时间
      let storedRequests = await this.state.storage.get("requests") || [];
      let storedNextAllowed = await this.state.storage.get("nextAllowedTime") || 0;
      this.requests = storedRequests;
      this.nextAllowedTime = storedNextAllowed;

      const now = Date.now() / 1000;
      // 清理时间窗口外的旧请求记录
      this.requests = this.requests.filter(time => time > now - this.timeWindow);
      
      let cooldown = 0;
      // 处理限流请求（仅聊天消息需要限流）
      if (request.method === "POST") {
        // 检查当前窗口内请求数是否超限
        if (this.requests.length >= this.maxRequests) {
          // 计算冷却时间（等待窗口内第一条请求过期）
          const earliestRequest = this.requests[0];
          cooldown = Math.max(0, earliestRequest + this.timeWindow - now);
          this.nextAllowedTime = now + cooldown;
        } else {
          // 未超限，记录当前请求时间
          this.requests.push(now);
          this.nextAllowedTime = now;
          cooldown = 0;
        }
      }

      // 批量持久化数据，提升性能
      await Promise.all([
        this.state.storage.put("requests", this.requests),
        this.state.storage.put("nextAllowedTime", this.nextAllowedTime)
      ]);
      
      // 返回跨域响应头
      return new Response(cooldown.toString(), {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "text/plain"
        }
      });
    });
  }
}

// 优化后的 RateLimiterClient Class（支持跳过限流+快速重置）
class RateLimiterClient {
  constructor(getLimiterStub, reportError) {
    this.getLimiterStub = getLimiterStub;
    this.reportError = reportError;
    this.limiter = getLimiterStub();
    this.inCooldown = false;
  }

  // 支持传入是否需要限流，非聊天消息直接跳过
  checkLimit(needLimit = true) {
    if (!needLimit) return true; // 无需限流直接通过
    if (this.inCooldown) return false;
    
    this.inCooldown = true;
    // 异步调用限流器（不阻塞当前消息处理）
    this.callLimiter().catch(err => this.reportError(err));
    return true;
  }

  async callLimiter() {
    try {
      let response;
      // 首次尝试调用限流器
      try {
        response = await this.limiter.fetch("https://dummy-url", { method: "POST" });
      } catch (err) {
        // 失败时重新获取stub并重试
        console.warn("限流器调用失败，重试中:", err);
        this.limiter = this.getLimiterStub();
        response = await this.limiter.fetch("https://dummy-url", { method: "POST" });
      }
      // 解析冷却时间
      const cooldown = parseFloat(await response.text());
      // 冷却结束后重置状态（无冷却时立即重置）
      if (cooldown > 0) {
        await new Promise(resolve => setTimeout(resolve, cooldown * 1000));
      }
      this.inCooldown = false;
    } catch (err) {
      this.reportError(err);
      // 异常时5秒后重置，避免永久限流
      setTimeout(() => {
        this.inCooldown = false;
      }, 5000);
    }
  }
}