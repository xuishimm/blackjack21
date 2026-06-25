import {
  Env, handleRegister, handleLogin, handleMe,
  resolveSession, genRoomCode, json,
} from './auth';

export { GameRoom } from './game/GameRoom';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    const method = req.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // Auth
    if (pathname === '/api/auth/register' && method === 'POST') return handleRegister(req, env);
    if (pathname === '/api/auth/login'    && method === 'POST') return handleLogin(req, env);
    if (pathname === '/api/auth/me'       && method === 'GET')  return handleMe(req, env);

    // Rooms
    if (pathname === '/api/rooms' && method === 'POST') return handleCreateRoom(req, env);

    // WebSocket upgrade
    const wsMatch = pathname.match(/^\/ws\/([A-Z0-9]{6})$/i);
    if (wsMatch) return routeWS(req, env, wsMatch[1].toUpperCase());

    // Static assets (index.html etc.)
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

// ── Room creation ─────────────────────────────────────────────────────────────

async function handleCreateRoom(req: Request, env: Env): Promise<Response> {
  const sess = await resolveSession(req, env);
  if (!sess) return json({ error: 'Not authenticated' }, 401);

  let body: { mode?: string };
  try { body = await req.json(); } catch { body = {}; }
  const mode = body.mode ?? 'vsDealer';

  // Generate unique room code (retry on collision)
  let code = '';
  for (let i = 0; i < 5; i++) {
    code = genRoomCode();
    const exists = await env.DB.prepare('SELECT code FROM rooms WHERE code = ?').bind(code).first();
    if (!exists) break;
  }

  await env.DB.prepare('INSERT INTO rooms (code, host_id, mode, phase) VALUES (?, ?, ?, ?)')
    .bind(code, sess.userId, mode, 'lobby').run();

  // Initialise the Durable Object for this room
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  await stub.fetch(new Request('http://do/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, mode, hostUserId: sess.userId }),
  }));

  return json({ code, mode });
}

// ── WebSocket routing ─────────────────────────────────────────────────────────

async function routeWS(req: Request, env: Env, code: string): Promise<Response> {
  const sess = await resolveSession(req, env);
  if (!sess) return new Response('Unauthorized', { status: 401 });

  const room = await env.DB.prepare('SELECT code FROM rooms WHERE code = ?').bind(code).first();
  if (!room) {
    // Room may have been created before DB record — create a default entry so joining works
    const hostId = sess.userId;
    try {
      await env.DB.prepare('INSERT OR IGNORE INTO rooms (code, host_id, mode, phase) VALUES (?, ?, ?, ?)')
        .bind(code, hostId, 'vsDealer', 'lobby').run();
    } catch { /* ignore */ }
  }

  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));

  // Forward the WS upgrade to the DO, passing auth info as headers
  const headers = new Headers(req.headers);
  headers.set('X-User-Id',  String(sess.userId));
  headers.set('X-Username', sess.username);

  return stub.fetch(new Request(req.url, { method: req.method, headers }));
}
