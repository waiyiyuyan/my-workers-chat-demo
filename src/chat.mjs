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
          return new Response(id.toString(), {headers: {"Access-Control-Allow-Origin": "*"}});
        } else {
          return new Response("Method not allowed", {status: 405});
        }
      }

      let name = path[1];
      let id;
      if (name.match(/^[0-9a-f]{64}$/)) {
        id = env.rooms.idFromString(name);
      } else if (name.length <= 32) {
        id = env.rooms.idFromName(name);
      } else {
        return new Response("Name too long", {status: 404});
      }

      let roomObject = env.rooms.get(id);
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");
      return roomObject.fetch(newUrl, request);
    }

    default:
      return new Response("Not found", {status: 404});
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
    
    this.state.getWebSockets().forEach((webSocket) => {
	  let meta = webSocket.deserializeAttachment() || {}; // 兜底空对象
	  let limiterId = this.env.limiters.idFromString(meta.limiterId || ""); // 兜底空字符串
      let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack));
      let blockedMessages = [];
      this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
      // 恢复重连用户到在线列表
      if (meta.name) this.onlineUsers.add(meta.name);
    });
    this.lastTimestamp = 0;
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);
      switch (url.pathname) {
        case "/websocket": {
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", {status: 400});
          }
          let ip = request.headers.get("CF-Connecting-IP");
          let pair = new WebSocketPair();
          await this.handleSession(pair[1], ip);
          return new Response(null, { status: 101, webSocket: pair[0] });
        }
        default:
          return new Response("Not found", {status: 404});
      }
    });
  }

  async handleSession(webSocket, ip) {
    this.state.acceptWebSocket(webSocket);
    let limiterId = this.env.limiters.idFromName(ip);
    let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack));
    let session = { limiterId, limiter, blockedMessages: [] };
    // webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), limiterId: limiterId.toString() });
	webSocket.serializeAttachment({ ...(webSocket.deserializeAttachment() || {}), limiterId: limiterId.toString() });
    this.sessions.set(webSocket, session);

    // 预加载历史在线用户到新连接的阻塞消息中
    session.blockedMessages.push(JSON.stringify({
      onlineUsers: Array.from(this.onlineUsers)
    }));

    for (let otherSession of this.sessions.values()) {
      if (otherSession.name) {
        session.blockedMessages.push(JSON.stringify({
          type: "system", // 新增类型标记
          joined: otherSession.name
        }));
      }
    }

    let storage = await this.storage.list({reverse: true, limit: 100});
    let backlog = [...storage.values()].reverse().filter(item => {
      try {
        const msg = JSON.parse(item);
        // 只保留有效聊天消息（必须有name/message/timestamp）
        return !!msg && typeof msg === "object" && !!msg.name && !!msg.message && !!msg.timestamp;
      } catch (e) {
        return false; // 解析失败的消息直接过滤
      }
    });
    backlog.forEach(value => {
      session.blockedMessages.push(value);
    });
  }

  async webSocketMessage(webSocket, msg) {
    try {
      let session = this.sessions.get(webSocket);
      if (session.quit) {
        webSocket.close(1011, "WebSocket broken.");
        return;
      }

      if (!session.limiter.checkLimit()) {
        webSocket.send(JSON.stringify({
          error: "Your IP is being rate-limited, please try again later."
        }));
        return;
      }

	  let data = JSON.parse(msg || "{}"); // 兜底空字符串

      // 新增：处理客户端的getUsers请求
      if (data.type === 'getUsers') {
		  webSocket.send(JSON.stringify({
			type: "system",
			onlineUsers: Array.from(this.onlineUsers)
		  }));
		  return;
		}

      // 新增：处理心跳请求（避免客户端断连）
      if (data.type === 'heartbeat') {
        webSocket.send(JSON.stringify({type: 'heartbeat', time: Date.now()}));
        return;
      }

      // 新增：处理历史消息请求
      if (data.type === 'getHistory') {
        let storage = await this.storage.list({reverse: true, limit: 100});
		
        let backlog = [...storage.values()].reverse().map(item => {
          try {
            const msg = JSON.parse(item);
            // 给缺失字段兜底，避免前端undefined
            return {
              name: msg.name || "未知用户",
              message: msg.message || "",
              timestamp: msg.timestamp || Date.now(),
              isImage: !!msg.isImage, // 布尔值兜底
              clientId: msg.clientId || "",
              messageId: msg.messageId || ""
            };
          } catch (e) {
            return null; // 解析失败返回null
          }
        }).filter(Boolean); // 过滤null/undefined
		
        webSocket.send(JSON.stringify({
			type: "history",
			history: backlog // backlog已经是处理好的对象数组
		}));
		  return;
      }

      if (!session.name) {
        session.name = "" + (data.name || "anonymous");
        webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name });
        if (session.name.length > 32) {
          webSocket.send(JSON.stringify({error: "Name too long."}));
          webSocket.close(1009, "Name too long.");
          return;
        }
        // 新增：将用户加入在线列表
        this.onlineUsers.add(session.name);
        
        session.blockedMessages.forEach(queued => {
          webSocket.send(queued);
        });
        delete session.blockedMessages;
        
        // 标记系统消息，避免混入历史记录
        this.broadcast({
          type: "system",
          joined: session.name,
          onlineUsers: Array.from(this.onlineUsers)
        });
        
        webSocket.send(JSON.stringify({ready: true}));
        return;
      }

      // 处理普通消息
      data = {
        ...data, 
        type: "chat", // 新增类型标记
        name: session.name || "未知用户", 
        message: "" + (data.message || ""), // 兜底空字符串
        // isImage: !!data.isImage, // 布尔值兜底
		isImage: !!data.isImage || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(data.message), 
        clientId: data.clientId || "",
        messageId: data.messageId || "",
        timestamp: Math.max(Date.now(), this.lastTimestamp + 1)
      };
      if (data.message.length > 256) {
        webSocket.send(JSON.stringify({error: "Message too long."}));
        return;
      }

      // data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
      this.lastTimestamp = data.timestamp;

      let dataStr = JSON.stringify(data);
      this.broadcast(dataStr);

      // Save message
      let key = new Date(data.timestamp).toISOString();
      await this.storage.put(key, dataStr);

      // 清理7天前的旧消息
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const sevenDaysAgoISO = new Date(sevenDaysAgo).toISOString();
      let oldMessages = await this.storage.list({end: sevenDaysAgoISO});
      let oldKeys = [...oldMessages.keys()];
      if (oldKeys.length > 0) {
        const batchSize = 10;
        for (let i = 0; i < oldKeys.length; i += batchSize) {
          const batch = oldKeys.slice(i, i + batchSize);
          await Promise.all(batch.map(async (key) => {
            try {
              await this.storage.delete(key);
            } catch (err) {
              console.error(`删除旧消息失败: ${key}`, err);
            }
          }));
        }
      }

    } catch (err) {
      webSocket.send(JSON.stringify({error: err.stack}));
    }
  }

  async closeOrErrorHandler(webSocket) {
    let session = this.sessions.get(webSocket) || {};
    session.quit = true;
    this.sessions.delete(webSocket);
    
    // ✅ 新增：从在线列表移除用户
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
    this.closeOrErrorHandler(webSocket)
  }

  async webSocketError(webSocket, error) {
    this.closeOrErrorHandler(webSocket)
  }

  broadcast(message) {
	  if (!message || (typeof message === "string" && message.trim() === "")) {
		console.warn("忽略空消息广播");
		return;
	  }
	  
	  // ✅ 修复：先判断message类型，避免重复JSON.parse/stringify
	  let msgObj;
	  if (typeof message === "string") {
		// 字符串类型：尝试解析为JSON
		try {
		  msgObj = JSON.parse(message);
		} catch (e) {
		  console.error("广播消息解析失败:", e, message);
		  return;
		}
	  } else if (typeof message === "object" && message !== null) {
		// 对象类型：直接使用
		msgObj = message;
	  } else {
		console.warn("无效的广播消息类型:", typeof message);
		return;
	  }

	  // 给消息加类型标记
	  if (!msgObj.type) {
		if (msgObj.joined || msgObj.quit || msgObj.onlineUsers) {
		  msgObj.type = "system";
		} else {
		  msgObj.type = "chat";
		}
	  }

	  // 最终序列化为JSON字符串发送
	  const messageStr = JSON.stringify(msgObj);

	  let quitters = [];
	  this.sessions.forEach((session, webSocket) => {
		if (session.name) {
		  try {
			webSocket.send(messageStr);
		  } catch (err) {
			session.quit = true;
			quitters.push(session);
			this.sessions.delete(webSocket);
		  }
		} else {
		  session.blockedMessages.push(messageStr);
		}
	  });

	  quitters.forEach(quitter => {
		if (quitter.name) {
		  this.broadcast({
			type: "system",
			quit: quitter.name,
			onlineUsers: Array.from(this.onlineUsers)
		  });
		}
	  });
	}
}
//----------------------------------

// RateLimiter Durable Object Class
export class RateLimiter {
  constructor(state, env) {
    this.state = state; // ✅ 新增：绑定state
    this.nextAllowedTime = 0;
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      // ✅ 新增：从持久化存储读取（重启后不丢失）
      let stored = await this.state.storage.get("nextAllowedTime");
      this.nextAllowedTime = stored || 0;

      let now = Date.now() / 1000;
      this.nextAllowedTime = Math.max(now, this.nextAllowedTime);
      if (request.method == "POST") {
        this.nextAllowedTime += 5;
      }
      let cooldown = Math.max(0, this.nextAllowedTime - now - 20);
      
      // ✅ 新增：持久化存储
      await this.state.storage.put("nextAllowedTime", this.nextAllowedTime);
      
      return new Response(cooldown);
    })
  }
}

// RateLimiterClient Class
class RateLimiterClient {
  constructor(getLimiterStub, reportError) {
    this.getLimiterStub = getLimiterStub;
    this.reportError = reportError;
    this.limiter = getLimiterStub();
    this.inCooldown = false;
  }

  checkLimit() {
    if (this.inCooldown) {
      return false;
    }
    this.inCooldown = true;
    this.callLimiter();
    return true;
  }

  async callLimiter() {
    try {
      let response;
      try {
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      } catch (err) {
        this.limiter = this.getLimiterStub();
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      }
      let cooldown = +(await response.text());
      await new Promise(resolve => setTimeout(resolve, cooldown * 1000));
      this.inCooldown = false;
    } catch (err) {
      this.reportError(err);
    }
  }
}