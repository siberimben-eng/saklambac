/**
 * Saklambaç 3D - Online sunucu
 * Node.js + Socket.io
 *
 * Çalıştırma:  npm install && node server.js
 * Render için: package.json + bu dosya yeterli
 */

const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Saklambaç 3D sunucu çalışıyor ✓');
});

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Oda durumu: code -> room
const rooms = new Map();

function makeRoom(code) {
  return {
    code,
    seed: Math.floor(Math.random() * 1e9),
    map: 0,
    phase: 'lobby', // lobby | hide | seek | end
    t: 0,
    host: null,
    players: new Map(), // id -> player
    hideTime: 20,
    seekTime: 150,
    timer: null
  };
}

function playerPublic(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    role: p.role,
    x: p.x,
    z: p.z,
    ry: p.ry,
    c: p.c,
    m: p.m,
    d: p.d,
    look: p.look
  };
}

function broadcastState(room) {
  const payload = {
    phase: room.phase,
    t: room.t,
    seed: room.seed,
    map: room.map,
    host: room.host,
    players: [...room.players.values()].map(playerPublic)
  };
  io.to(room.code).emit('s', payload);
}

function clearTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function startTimer(room) {
  clearTimer(room);
  room.timer = setInterval(() => {
    if (room.phase === 'lobby') return;
    room.t -= 1;
    if (room.t > 0) {
      broadcastState(room);
      return;
    }
    if (room.phase === 'hide') {
      room.phase = 'seek';
      room.t = room.seekTime;
      io.to(room.code).emit('msg', 'Arama başladı!');
    } else if (room.phase === 'seek') {
      endGame(room, 'hiders');
      return;
    } else if (room.phase === 'end') {
      room.phase = 'lobby';
      room.t = 0;
      for (const p of room.players.values()) {
        p.role = null;
        p.d = 0;
        p.c = 0;
      }
    }
    broadcastState(room);
  }, 1000);
}

function spawnPlayer(p, role) {
  if (role === 'seeker') {
    p.x = (Math.random() - 0.5) * 4;
    p.z = (Math.random() - 0.5) * 4;
  } else {
    const a = Math.random() * Math.PI * 2;
    const d = 14 + Math.random() * 55;
    p.x = Math.cos(a) * d;
    p.z = Math.sin(a) * d;
  }
  p.ry = 0;
  p.c = 0;
  p.m = 0;
  p.d = 0;
}

function startGame(room, mapId) {
  if (room.phase !== 'lobby') return;
  const ids = [...room.players.keys()];
  if (ids.length < 1) return;

  room.seed = Math.floor(Math.random() * 1e9);
  room.map = (mapId | 0) % 4;
  // Karıştır, yaklaşık 1/4 seeker
  ids.sort(() => Math.random() - 0.5);
  const nSeekers = Math.max(1, Math.floor(ids.length / 4));

  ids.forEach((id, i) => {
    const p = room.players.get(id);
    p.role = i < nSeekers ? 'seeker' : 'hider';
    spawnPlayer(p, p.role);
  });

  room.phase = 'hide';
  room.t = room.hideTime;
  startTimer(room);

  // Her oyuncuya kendi spawn noktasını gönder
  for (const p of room.players.values()) {
    io.to(p.id).emit('spawn', {
      x: p.x,
      z: p.z,
      seed: room.seed,
      map: room.map
    });
  }
  broadcastState(room);
}

function endGame(room, winner) {
  room.phase = 'end';
  room.t = 8;
  io.to(room.code).emit('end', { winner });
  broadcastState(room);
  // 8 sn sonra lobby'ye düşer (timer zaten çalışıyor)
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

io.on('connection', (socket) => {
  let myRoom = null;
  let myId = socket.id;

  socket.on('join', (data, cb) => {
    const name = (data && data.name ? String(data.name) : 'Oyuncu').slice(0, 12) || 'Oyuncu';
    const code = (data && data.code ? String(data.code) : 'ana').toLowerCase().slice(0, 12) || 'ana';
    const look = data && data.look ? data.look : { c: 0, h: 0, f: 0, o: 0 };

    if (!rooms.has(code)) rooms.set(code, makeRoom(code));
    const room = rooms.get(code);

    // Süreleri sadece oda boşken / lobby'de host belirleyebilir (ilk giren)
    if (room.players.size === 0) {
      if (data.hideTime) room.hideTime = Math.max(5, Math.min(120, +data.hideTime || 20));
      if (data.seekTime) room.seekTime = Math.max(30, Math.min(600, +data.seekTime || 150));
      room.host = myId;
    }

    const player = {
      id: myId,
      name,
      look,
      color: Math.floor(Math.random() * 0xffffff),
      role: null,
      x: 0,
      z: 0,
      ry: 0,
      c: 0,
      m: 0,
      d: 0
    };
    room.players.set(myId, player);
    myRoom = room;
    socket.join(code);

    if (typeof cb === 'function') {
      cb({ id: myId, seed: room.seed, map: room.map });
    }

    // Oyun ortasında girerse spawn + state
    if (room.phase !== 'lobby') {
      spawnPlayer(player, 'hider'); // geç gelen hider olur (basit)
      player.role = 'hider';
      socket.emit('spawn', { x: player.x, z: player.z, seed: room.seed, map: room.map });
    }
    broadcastState(room);
  });

  socket.on('m', (d) => {
    if (!myRoom) return;
    const p = myRoom.players.get(myId);
    if (!p) return;
    // Saklanma fazında seeker hareket edemesin
    if (myRoom.phase === 'hide' && p.role === 'seeker') return;
    if (d && typeof d.x === 'number') {
      p.x = d.x;
      p.z = d.z;
      p.ry = d.ry || 0;
      p.c = d.c ? 1 : 0;
      p.m = d.m || 0;
      p.d = d.d | 0;
    }
  });

  socket.on('start', (d) => {
    if (!myRoom || myRoom.host !== myId) return;
    if (myRoom.phase !== 'lobby') return;
    startGame(myRoom, d && d.map);
  });

  socket.on('catch', (targetId) => {
    if (!myRoom || myRoom.phase !== 'seek') return;
    const me = myRoom.players.get(myId);
    const target = myRoom.players.get(targetId);
    if (!me || !target) return;
    if (me.role !== 'seeker' || target.role !== 'hider') return;
    if (dist(me, target) > 3.6) return;

    target.role = 'seeker';
    target.d = 0;
    target.c = 0;
    io.to(myRoom.code).emit('msg',
      targetId === myId
        ? 'Yakalandın! Artık sen de arıyorsun 🔍'
        : target.name + ' bulundu! Artık o da arıyor 🔍'
    );
    const remaining = [...myRoom.players.values()].filter((p) => p.role === 'hider');
    if (remaining.length === 0) endGame(myRoom, 'seekers');
    else broadcastState(myRoom);
  });

  socket.on('ping', () => {
    if (!myRoom || myRoom.phase !== 'seek') return;
    const me = myRoom.players.get(myId);
    if (!me || me.role !== 'seeker') return;
    const hiders = [...myRoom.players.values()].filter((p) => p.role === 'hider');
    if (!hiders.length) {
      socket.emit('ping', null);
      return;
    }
    // En yakına yakın rastgele nokta
    hiders.sort((a, b) => dist(me, a) - dist(me, b));
    const h = hiders[0];
    socket.emit('ping', {
      x: h.x + (Math.random() - 0.5) * 10,
      z: h.z + (Math.random() - 0.5) * 10
    });
  });

  socket.on('decoy', (d) => {
    if (!myRoom || myRoom.phase !== 'seek') return;
    const me = myRoom.players.get(myId);
    if (!me || me.role !== 'hider') return;
    if (!d) return;
    io.to(myRoom.code).emit('decoy', {
      x: Math.max(-80, Math.min(80, +d.x || 0)),
      z: Math.max(-80, Math.min(80, +d.z || 0))
    });
  });

  socket.on('disconnect', () => {
    if (!myRoom) return;
    myRoom.players.delete(myId);
    if (myRoom.host === myId) {
      const next = myRoom.players.keys().next().value;
      myRoom.host = next || null;
    }
    if (myRoom.players.size === 0) {
      clearTimer(myRoom);
      rooms.delete(myRoom.code);
    } else {
      // Son hider de çıktıysa vs.
      if (myRoom.phase === 'seek') {
        const hiders = [...myRoom.players.values()].filter((p) => p.role === 'hider');
        if (hiders.length === 0) endGame(myRoom, 'seekers');
      }
      broadcastState(myRoom);
    }
    myRoom = null;
  });
});

// State'i düzenli yayınla (hareket güncellemesi)
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase === 'lobby' || room.phase === 'end') continue;
    broadcastState(room);
  }
}, 66);

server.listen(PORT, () => {
  console.log('Saklambaç 3D sunucu http://localhost:' + PORT);
});
