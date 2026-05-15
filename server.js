const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const {
  parseAllowedOrigins,
  isOriginAllowed,
  applyCorsHeaders,
  handlePreflight,
  getClientIp,
} = require('./lib/cors');

const hostname = process.env.HOST || '0.0.0.0';
const port = Number(process.env.WS_PORT || process.env.PORT || 8081);
const rooms = new Map();
const RECONNECT_GRACE_MS = 30000;

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      host: null,
      guest: null,
    });
  }
  return rooms.get(roomId);
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function connectedSeats(room) {
  return ['host', 'guest']
    .map((role) => room[role])
    .filter((seat) => seat?.ws && seat.ws.readyState === seat.ws.OPEN);
}

function broadcast(room, sender, message) {
  const data = typeof message === 'string' ? message : JSON.stringify(message);

  for (const seat of connectedSeats(room)) {
    if (seat.ws !== sender) {
      seat.ws.send(data);
    }
  }
}

function makeRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

function makePlayerId() {
  return Math.random().toString(36).slice(2, 12);
}

function getReusableRole(room, playerId) {
  if (room.host?.playerId === playerId) return 'host';
  if (room.guest?.playerId === playerId) return 'guest';
  return null;
}

function getOpenRole(room) {
  if (!room.host) return 'host';
  if (!room.guest) return 'guest';
  return null;
}

function hasConnectedOpponent(room, role) {
  const opponent = role === 'host' ? room.guest : room.host;
  return Boolean(opponent?.ws && opponent.ws.readyState === opponent.ws.OPEN);
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (!room.host && !room.guest) {
    rooms.delete(roomId);
  }
}

function roomSummary(room) {
  return ['host', 'guest']
    .map((role) => {
      const seat = room[role];
      if (!seat) return `${role}:empty`;
      if (seat.ws && seat.ws.readyState === seat.ws.OPEN) return `${role}:online`;
      return `${role}:reserved`;
    })
    .join(' ');
}

function pathname(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
}

function respond(req, res, statusCode, body, contentType) {
  applyCorsHeaders(req, res);
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(body);
}

const httpServer = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    handlePreflight(req, res);
    return;
  }

  const path = pathname(req);

  if (path === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    const payload = {
      ok: true,
      rooms: rooms.size,
      uptime: Math.round(process.uptime()),
      cors: parseAllowedOrigins().length,
    };
    respond(req, res, 200, JSON.stringify(payload), 'application/json');
    return;
  }

  if (path === '/' && req.method === 'GET') {
    respond(req, res, 200, 'Ping Pong WebSocket server. Connect at /ws', 'text/plain');
    return;
  }

  respond(req, res, 404, 'Not found. Use /ws for game sockets.', 'text/plain');
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

httpServer.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (!isOriginAllowed(origin)) {
    console.log(`[upgrade rejected] origin=${origin || 'none'} path=${path}`);
    socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nOrigin not allowed\r\n');
    socket.destroy();
    return;
  }

  if (path !== '/ws') {
    console.log(`[upgrade rejected] path=${path}`);
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || makeRoomId();
  const playerId = url.searchParams.get('player') || makePlayerId();
  const room = getRoom(roomId);
  const reusableRole = getReusableRole(room, playerId);
  const role = reusableRole || getOpenRole(room);

  if (!role) {
    console.log(`[room full] room=${roomId} player=${playerId}`);
    send(ws, { type: 'roomFull', roomId });
    ws.close(1008, 'Room is full');
    return;
  }

  const previousSeat = room[role];
  if (previousSeat?.disconnectTimer) {
    clearTimeout(previousSeat.disconnectTimer);
  }

  room[role] = {
    playerId,
    ws,
    disconnectTimer: null,
  };

  if (previousSeat?.ws && previousSeat.ws.readyState === previousSeat.ws.OPEN) {
    setTimeout(() => {
      previousSeat.ws.close(1000, 'Replaced by a newer connection');
    }, 0);
  }

  const ip = getClientIp(req);
  const opponentPresent = hasConnectedOpponent(room, role);
  console.log(`[connect] room=${roomId} role=${role} reused=${Boolean(reusableRole)} ip=${ip} origin=${req.headers.origin || 'none'} ${roomSummary(room)}`);

  send(ws, { type: 'role', role, roomId, playerId, opponentPresent });

  if (opponentPresent) {
    broadcast(room, ws, role === 'guest' ? { type: 'guestJoined' } : { type: 'opponentReconnected' });
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      console.log(`[ignored binary] room=${roomId} role=${role} bytes=${data.length}`);
      return;
    }

    const text = data.toString();
    console.log(`[message] room=${roomId} role=${role} ${text}`);
    broadcast(room, ws, text);
  });

  ws.on('close', (code, reason) => {
    console.log(`[close] room=${roomId} role=${role} code=${code} reason=${reason || 'none'}`);

    const currentSeat = room[role];
    if (!currentSeat || currentSeat.ws !== ws) return;

    currentSeat.ws = null;
    broadcast(room, ws, { type: 'opponentDisconnected', graceMs: RECONNECT_GRACE_MS });

    currentSeat.disconnectTimer = setTimeout(() => {
      const latestRoom = rooms.get(roomId);
      if (!latestRoom || latestRoom[role]?.ws) return;

      latestRoom[role] = null;
      broadcast(latestRoom, null, { type: 'opponentLeft' });
      cleanupRoom(roomId);
      console.log(`[expired] room=${roomId} role=${role}`);
    }, RECONNECT_GRACE_MS);

    cleanupRoom(roomId);
  });

  ws.on('error', (err) => {
    console.error(`[socket error] room=${roomId} role=${role} code=${err.code || 'unknown'} message=${err.message}`);
  });
});

wss.on('error', (err) => {
  console.error(`[server error] ${err.message}`);
});

httpServer.listen(port, hostname, () => {
  const allowed = parseAllowedOrigins();
  console.log('===============================================');
  console.log('  Ping Pong WebSocket Server');
  console.log('===============================================');
  console.log(`  WS:      ws://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${port}/ws`);
  console.log(`  Health:  http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${port}/health`);
  console.log(`  Bound:   ${hostname}:${port}`);
  if (allowed.length > 0) {
    console.log(`  CORS:    ${allowed.join(', ')}`);
  } else if (process.env.NODE_ENV === 'production') {
    console.log('  CORS:    (none — set ALLOWED_ORIGINS on the VPS)');
  } else {
    console.log('  CORS:    localhost / 127.0.0.1 (dev default)');
  }
  console.log('===============================================');
});
