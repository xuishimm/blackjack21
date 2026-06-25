export interface Env {
  DB: D1Database;
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

// ── Crypto ────────────────────────────────────────────────────────────────────

export async function hashPassword(pw: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, key, 256
  );
  const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${hex(salt)}:${hex(new Uint8Array(bits))}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const fromHex = (h: string) => new Uint8Array(h.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const salt = fromHex(saltHex);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, key, 256
  );
  const computed = Array.from(new Uint8Array(bits), x => x.toString(16).padStart(2, '0')).join('');
  return computed === hashHex;
}

export function genToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

export function genRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), b => chars[b % chars.length]).join('');
}

// ── Session ───────────────────────────────────────────────────────────────────

export async function resolveSession(
  req: Request, env: Env
): Promise<{ userId: number; username: string } | null> {
  const token = getBearer(req);
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT s.user_id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
  ).bind(token, Math.floor(Date.now() / 1000)).first<{ user_id: number; username: string }>();
  return row ? { userId: row.user_id, username: row.username } : null;
}

export function getBearer(req: Request): string | null {
  const auth = req.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return new URL(req.url).searchParams.get('token');
}

export const json = (d: unknown, s = 200): Response =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleRegister(req: Request, env: Env): Promise<Response> {
  let body: { username?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { username, password } = body;
  if (!username || !password) return json({ error: 'Username and password required' }, 400);
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(username))
    return json({ error: 'Username: 2–20 letters, numbers, or underscores' }, 400);
  if (password.length < 4) return json({ error: 'Password must be at least 4 characters' }, 400);

  const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (exists) return json({ error: 'Username already taken' }, 409);

  const hash = await hashPassword(password);
  const user = await env.DB.prepare(
    'INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?) RETURNING id'
  ).bind(username, hash, Math.floor(Date.now() / 1000)).first<{ id: number }>();
  if (!user) return json({ error: 'Registration failed' }, 500);

  const token = genToken();
  await env.DB.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, user.id, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 7 * 86400).run();

  return json({ token, username, userId: user.id });
}

export async function handleLogin(req: Request, env: Env): Promise<Response> {
  let body: { username?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { username, password } = body;
  if (!username || !password) return json({ error: 'Username and password required' }, 400);

  const user = await env.DB.prepare('SELECT id, pass_hash FROM users WHERE username = ?')
    .bind(username).first<{ id: number; pass_hash: string }>();
  if (!user || !(await verifyPassword(password, user.pass_hash)))
    return json({ error: 'Invalid username or password' }, 401);

  const token = genToken();
  await env.DB.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, user.id, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 7 * 86400).run();

  return json({ token, username, userId: user.id });
}

export async function handleMe(req: Request, env: Env): Promise<Response> {
  const sess = await resolveSession(req, env);
  if (!sess) return json({ error: 'Not authenticated' }, 401);
  return json({ username: sess.username, userId: sess.userId });
}
