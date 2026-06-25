// src/auth.ts
async function hashPassword(pw) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" },
    key,
    256
  );
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex(salt)}:${hex(new Uint8Array(bits))}`;
}
async function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const fromHex = (h) => new Uint8Array(h.match(/.{2}/g).map((b) => parseInt(b, 16)));
  const salt = fromHex(saltHex);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" },
    key,
    256
  );
  const computed = Array.from(new Uint8Array(bits), (x) => x.toString(16).padStart(2, "0")).join("");
  return computed === hashHex;
}
function genToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => chars[b % chars.length]).join("");
}
async function resolveSession(req, env) {
  const token = getBearer(req);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT s.user_id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?"
  ).bind(token, Math.floor(Date.now() / 1e3)).first();
  return row ? { userId: row.user_id, username: row.username } : null;
}
function getBearer(req) {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return new URL(req.url).searchParams.get("token");
}
var json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
async function handleRegister(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { username, password } = body;
  if (!username || !password) return json({ error: "Username and password required" }, 400);
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(username))
    return json({ error: "Username: 2\u201320 letters, numbers, or underscores" }, 400);
  if (password.length < 4) return json({ error: "Password must be at least 4 characters" }, 400);
  const exists = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  if (exists) return json({ error: "Username already taken" }, 409);
  const hash = await hashPassword(password);
  const user = await env.DB.prepare(
    "INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?) RETURNING id"
  ).bind(username, hash, Math.floor(Date.now() / 1e3)).first();
  if (!user) return json({ error: "Registration failed" }, 500);
  const token = genToken();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(token, user.id, Math.floor(Date.now() / 1e3), Math.floor(Date.now() / 1e3) + 7 * 86400).run();
  return json({ token, username, userId: user.id });
}
async function handleLogin(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { username, password } = body;
  if (!username || !password) return json({ error: "Username and password required" }, 400);
  const user = await env.DB.prepare("SELECT id, pass_hash FROM users WHERE username = ?").bind(username).first();
  if (!user || !await verifyPassword(password, user.pass_hash))
    return json({ error: "Invalid username or password" }, 401);
  const token = genToken();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(token, user.id, Math.floor(Date.now() / 1e3), Math.floor(Date.now() / 1e3) + 7 * 86400).run();
  return json({ token, username, userId: user.id });
}
async function handleMe(req, env) {
  const sess = await resolveSession(req, env);
  if (!sess) return json({ error: "Not authenticated" }, 401);
  return json({ username: sess.username, userId: sess.userId });
}

// src/index.ts
var index_default = {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    const method = req.method;
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }
    if (pathname === "/api/auth/register" && method === "POST") return handleRegister(req, env);
    if (pathname === "/api/auth/login" && method === "POST") return handleLogin(req, env);
    if (pathname === "/api/auth/me" && method === "GET") return handleMe(req, env);
    if (pathname === "/api/rooms" && method === "POST") return handleCreateRoom(req, env);
    const wsMatch = pathname.match(/^\/ws\/([A-Z0-9]{6})$/i);
    if (wsMatch) return routeWS(req, env, wsMatch[1].toUpperCase());
    return env.ASSETS.fetch(req);
  }
};
async function handleCreateRoom(req, env) {
  const sess = await resolveSession(req, env);
  if (!sess) return json({ error: "Not authenticated" }, 401);
  let body;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const mode = body.mode ?? "vsDealer";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code = genRoomCode();
    const exists = await env.DB.prepare("SELECT code FROM rooms WHERE code = ?").bind(code).first();
    if (!exists) break;
  }
  await env.DB.prepare("INSERT INTO rooms (code, host_id, mode, phase) VALUES (?, ?, ?, ?)").bind(code, sess.userId, mode, "lobby").run();
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  await stub.fetch(new Request("http://do/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, mode, hostUserId: sess.userId })
  }));
  return json({ code, mode });
}
async function routeWS(req, env, code) {
  const sess = await resolveSession(req, env);
  if (!sess) return new Response("Unauthorized", { status: 401 });
  const room = await env.DB.prepare("SELECT code FROM rooms WHERE code = ?").bind(code).first();
  if (!room) {
    const hostId = sess.userId;
    try {
      await env.DB.prepare("INSERT OR IGNORE INTO rooms (code, host_id, mode, phase) VALUES (?, ?, ?, ?)").bind(code, hostId, "vsDealer", "lobby").run();
    } catch {
    }
  }
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const headers = new Headers(req.headers);
  headers.set("X-User-Id", String(sess.userId));
  headers.set("X-Username", sess.username);
  return stub.fetch(new Request(req.url, { method: req.method, headers }));
}
export {
  index_default as default
};
