// src/chat.mjs —— 2025年12月8日终极稳定版（已亲测秒发秒显 + 自动清理）
import HTML from "./chat.html";

async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") === "websocket") {
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack || String(err)}));
      pair[1].close(1011, "Error");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response(err.stack || "Error", {status: 500});
  }
}

export default {
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
      const path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      }

      if (path[0] === "api" && path[1] === "room") {
        if (!path[2] && request.method === "POST") {
          const id = env.rooms.newUniqueId();
          return new Response(id.toString());
        }
        const name = path[2];
        if (!name) return new Response("Bad Request", {status: 400});

        const id = /^[0-9a-f]{64}$/.test(name)
          ? env.rooms.idFromString(name)
          : env.rooms.idFromName(name);

        const room = env.rooms.get(id);
        const newUrl = new URL(request.url);
        newUrl.pathname = "/" + path.slice(3).join("/");
        return room.fetch(newUrl, request);
      }
      return new Response("Not found", {status: 404});
    });
  }
};

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.sessions = new Map();
    this.lastTimestamp = 0;
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      const url = new URL(request.url);

      // 每日清理接口
      if (url.pathname === "/clear-all-2025") {
        await this.storage.deleteAll();
        this.lastTimestamp = 0;
        this.broadcast({ready: true});
        return new Response("Room cleared");
      }

      if (url.pathname === "/websocket") {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("expected websocket", {status: 400});
        }

        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const pair = new WebSocketPair();
        await this.handleSession(pair[1], ip);
        return new Response(null, {status: 101, webSocket: pair[0]});
      }

      return new Response("Not found", {status: 404});
    });
  }

  async handleSession(ws, ip) {
    this.state.acceptWebSocket(ws);

    // 防刷
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

    // 发送历史消息（最多300条）
    const entries = await this.storage.list({reverse: true, limit: 300});
    const messages = [...entries.values()].reverse();
    messages.forEach(m => ws.send(m));
  }

async webSocketMessage(ws, message) {
  const session = this.sessions.get(ws);
  if (!session) return;

  try {
    const data = JSON. parse(message);

    // 第一次发名字
    if (data.name) {
      const raw = "" + data.name;
      const [displayName, uniqueId] = raw.split("##");
      const safeName = (displayName || "匿名").slice(0, 32);
      const sessionId = uniqueId || crypto.randomUUID();

      session.displayName = safeName;
      session.sessionId = sessionId;
      ws.serializeAttachment({ sessionId });

      session.blockedMessages.forEach(m => ws.send(m));
      session.blockedMessages = null;

      ws.send(JSON.stringify({ ready: true }));
      this.broadcast({ joined: safeName });
      return;
    }

    // ★ 关键：服务器端验证消息长度
    if (data.message && data.message.length > 256) {
      // ★ 发送错误给客户端（不是系统消息，是错误对象）
      ws.send(JSON.stringify({ error: "消息过长，请分段发送" }));
      return; // ★ 重要：return，不继续处理
    }

    // 发送消息
    if (data.message && session.displayName && session.limiter.checkLimit()) {
      const msgObj = {
        name: `${session.displayName}##${session.sessionId}`,
        message: ("" + data.message),
        timestamp: Math.max(Date.now(), this.lastTimestamp + 1)
      };

      this.lastTimestamp = msgObj.timestamp;
      const msgStr = JSON.stringify(msgObj);

      this.broadcast(msgStr);

      const keys = await this.storage.list({limit: 1000});
      const toDelete = [... keys. keys()].sort().slice(0, -300);
      if (toDelete.length) {
        await Promise.all(toDelete.map(k => this.storage.delete(k)));
      }
      await this.storage.put(msgObj. timestamp. toString(), msgStr);
    }

  } catch (e) {
    console.error(e);
  }
}

  webSocketClose(ws) { this.cleanup(ws); }
  webSocketError(ws) { this.cleanup(ws); }

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
      } catch (e) {}
    });
  }
}

// 必须保留的 RateLimiter（和官方原版完全兼容）
export class RateLimiter {
  constructor() {
    this.nextAllowedTime = 0;
  }
  async fetch(request) {
    const now = Date.now() / 1000;
    this.nextAllowedTime = Math.max(now, this.nextAllowedTime);
    if (request.method === "POST") this.nextAllowedTime += 5;
    const cooldown = Math.max(0, this.nextAllowedTime - now - 20);
    return new Response(cooldown);
  }
}

class RateLimiterClient {
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
      const resp = await this.stub.fetch("https://fake.host", {method: "POST"});
      const wait = Number(await resp.text());
      await new Promise(r => setTimeout(r, wait * 1000));
      this.cooldown = false;
    } catch (e) {
      this.stub = this.getStub();
      this.apply();
    }
  }
}