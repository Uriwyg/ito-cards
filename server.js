// ITO phone cards — tiny dependency-free game server.
// Run:  node server.js        (optional: PORT=3000 node server.js)
// Players on the same Wi-Fi open the printed address on their phones.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');

// Distinct colors that are easy to tell apart on a table.
const PALETTE = [
  { name: 'Red', hex: '#e53935' },
  { name: 'Blue', hex: '#1e63d6' },
  { name: 'Yellow', hex: '#fdd835' },
  { name: 'Green', hex: '#2e9d3a' },
  { name: 'Orange', hex: '#fb8c00' },
  { name: 'Purple', hex: '#7b3fbf' },
  { name: 'Pink', hex: '#f06292' },
  { name: 'Cyan', hex: '#26c6da' },
  { name: 'Brown', hex: '#7a4a2a' },
  { name: 'Lime', hex: '#b2e534' },
  { name: 'Black', hex: '#1a1a1a' },
  { name: 'White', hex: '#f7f7f7' },
  { name: 'Teal', hex: '#00897b' },
  { name: 'Magenta', hex: '#d81b9b' },
  { name: 'Navy', hex: '#14246b' },
  { name: 'Gray', hex: '#8a8a8a' },
];

const state = {
  phase: 'lobby', // 'lobby' | 'playing'
  round: 0,
  adminId: null,
  players: new Map(), // id -> { id, name, color, number, joinedAt }
};
const streams = new Map(); // id -> Set<res>

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

function pickColor() {
  const used = new Set([...state.players.values()].map((p) => p.color.hex));
  const free = PALETTE.find((c) => !used.has(c.hex));
  if (free) return free;
  // More players than palette colors: generate a distinct-ish hue.
  const hue = Math.floor(Math.random() * 360);
  return { name: `Color ${state.players.size + 1}`, hex: `hsl(${hue} 75% 50%)` };
}

function deal() {
  const pool = Array.from({ length: 100 }, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  let k = 0;
  for (const p of state.players.values()) p.number = pool[k++];
  state.phase = 'playing';
  state.round += 1;
}

function ensureAdmin() {
  if (state.adminId && state.players.has(state.adminId)) return;
  const first = [...state.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
  state.adminId = first ? first.id : null;
}

function viewFor(id) {
  const me = state.players.get(id) || null;
  return {
    phase: state.phase,
    round: state.round,
    addresses: lanAddresses().map((ip) => `http://${ip}:${PORT}`),
    palette: PALETTE,
    you: me && {
      id: me.id,
      name: me.name,
      color: me.color,
      number: state.phase === 'playing' ? me.number : null, // only your own number is ever sent
      isAdmin: state.adminId === me.id,
    },
    players: [...state.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        online: (streams.get(p.id)?.size || 0) > 0,
        isAdmin: state.adminId === p.id,
        inRound: state.phase === 'playing' && p.number != null,
      })),
  };
}

function send(res, id) {
  res.write(`data: ${JSON.stringify(viewFor(id))}\n\n`);
}

function broadcast() {
  for (const [id, set] of streams) for (const res of set) send(res, id);
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 20);
const cleanId = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(INDEX).pipe(res);
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const id = cleanId(url.searchParams.get('pid'));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // stop hosting proxies from holding back live updates
    });
    res.write('retry: 1500\n\n');
    if (!streams.has(id)) streams.set(id, new Set());
    streams.get(id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      streams.get(id)?.delete(res);
      if (streams.get(id)?.size === 0) streams.delete(id);
      broadcast();
    });
    return broadcast(); // also tells everyone this player is online
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const body = await readBody(req);
    const id = cleanId(body.pid);
    const action = url.pathname.slice(5);
    const isAdmin = id && id === state.adminId;

    switch (action) {
      case 'join': {
        const name = cleanName(body.name);
        if (!id || !name) return json(res, 400, { error: 'Name required' });
        const existing = state.players.get(id);
        if (existing) existing.name = name;
        else state.players.set(id, { id, name, color: pickColor(), number: null, joinedAt: Date.now() });
        ensureAdmin();
        break;
      }
      case 'color': {
        const me = state.players.get(id);
        const color = PALETTE.find((c) => c.hex === body.hex);
        if (!me || !color) return json(res, 400, { error: 'Unknown color' });
        if (state.phase !== 'lobby') return json(res, 409, { error: 'Colors can only be changed in the lobby' });
        const taken = [...state.players.values()].some((p) => p.id !== id && p.color.hex === color.hex);
        if (taken) return json(res, 409, { error: 'That color was just taken' });
        me.color = color;
        break;
      }
      case 'leave':
        state.players.delete(id);
        ensureAdmin();
        break;
      case 'start':
      case 'next':
        if (!isAdmin) return json(res, 403, { error: 'Host only' });
        deal();
        break;
      case 'lobby':
        if (!isAdmin) return json(res, 403, { error: 'Host only' });
        state.phase = 'lobby';
        for (const p of state.players.values()) p.number = null;
        break;
      case 'kick':
        if (!isAdmin) return json(res, 403, { error: 'Host only' });
        if (body.target !== state.adminId) state.players.delete(cleanId(body.target));
        break;
      case 'makeHost':
        if (!isAdmin) return json(res, 403, { error: 'Host only' });
        if (state.players.has(cleanId(body.target))) state.adminId = cleanId(body.target);
        break;
      default:
        return json(res, 404, { error: 'Unknown action' });
    }
    broadcast();
    return json(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nITO cards is running. Open one of these on the phones (same Wi-Fi):\n');
  for (const ip of lanAddresses()) console.log(`   http://${ip}:${PORT}`);
  console.log(`\n   (on this computer: http://localhost:${PORT})\n`);
});
