// SyncStream - servidor de salas sincronizadas (alternativa self-hosted ao StreamYard)
// HTTP: Express (API REST + arquivos estáticos do cliente)
// Tempo real: Socket.IO (sincronização de mídia, chat, participantes, layout, gravação)
// Persistência: JSON simples em disco (/data/rooms.json) — foco na simplicidade.

import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { v4 as uuid } from 'uuid';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CLIENT_DIR = process.env.CLIENT_DIR || path.join(__dirname, '..', 'client');
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS || '200', 10);
// Para escalar horizontalmente com N réplicas, use um Redis adapter:
//   npm i @socket.io/redis-adapter socket.io-client
//   import { createAdapter } from '@socket.io/redis-adapter'; ...
// O design já é por-sala (room code), então basta rotear convidados ao mesmo shard.

// ---------------------------------------------------------------------------
// Persistência simples (arquivo JSON). Estrutura:
// rooms: { [code]: { code, name, passwordHash, hostName, createdAt, closed,
//                    invites: [ {token,name,role,status} ], participants: [...] } }
// ---------------------------------------------------------------------------
let db = { rooms: {} };

function loadDb() {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'rooms.json'), 'utf8');
    db = JSON.parse(raw);
    if (!db.rooms) db.rooms = {};
    // estado vivo (sockets/stage) não sobrevive a restart: limpa referências antigas
    for (const r of Object.values(db.rooms)) { r.stage = []; }
  } catch {
    db = { rooms: {} };
  }
}

let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'rooms.json'), JSON.stringify(db, null, 2));
    } catch (e) {
      console.error('erro ao salvar banco:', e.message);
    }
  }, 500);
}

function hash(s) {
  // hash simples e determinístico para senhas de sala (suficiente p/ escopo didático)
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(36);
}

function roomSummary(code) {
  const r = db.rooms[code];
  if (!r) return null;
  const live = liveRooms.get(code);
  return {
    code: r.code,
    name: r.name,
    hostName: r.hostName,
    closed: !!r.closed,
    hasPassword: !!r.passwordHash,
    participantCount: live ? live.participants.size : 0,
    recording: live ? live.recording.active : false,
    maxGuests: r.maxGuests,
    waitingRoomEnabled: r.waitingRoomEnabled,
    chatEnabled: r.chatEnabled,
    streamKeySet: !!r.streamKey,
    layout: live ? live.layout : r.layout || 'grid',
    stage: live ? [...live.stage] : (r.stage || []),
    mutedHosts: live ? [...live.mutedHosts] : [],
  };
}

// ---------------------------------------------------------------------------
// API REST
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// criar sala
app.post('/api/rooms', (req, res) => {
  const { name, hostName, password, maxGuests, waitingRoom, chatEnabled } = req.body || {};
  const activeCount = Object.values(db.rooms).filter(r => !r.closed).length;
  if (activeCount >= MAX_ROOMS) return res.status(429).json({ error: 'Limite de salas atingido' });

  let code;
  do { code = genCode(); } while (db.rooms[code]);
  db.rooms[code] = {
    code,
    name: (name || 'Sala sem nome').slice(0, 80),
    hostName: (hostName || 'Apresentador').slice(0, 40),
    passwordHash: password ? hash(String(password)) : null,
    maxGuests: Math.min(Math.max(parseInt(maxGuests, 10) || 10, 2), 50),
    waitingRoomEnabled: waitingRoom !== false,
    chatEnabled: chatEnabled !== false,
    streamKey: null,
    layout: 'grid',
    stage: [],
    invites: [],
    createdAt: Date.now(),
    closed: false,
  };
  const hostToken = uuid();
  db.rooms[code].invites.push({ token: hostToken, name: db.rooms[code].hostName, role: 'host', status: 'pending', createdAt: Date.now() });
  saveDb();
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    code,
    joinUrl: `${base}/#/join/${code}`,
    backstageUrl: `${base}/#/join/${code}?invite=${hostToken}&role=host`,
  });
});

// info pública da sala (para tela de entrada)
app.get('/api/rooms/:code', (req, res) => {
  const r = db.rooms[req.params.code.toUpperCase()];
  if (!r || r.closed) return res.status(404).json({ error: 'Sala não encontrada' });
  res.json({
    code: r.code,
    name: r.name,
    hostName: r.hostName,
    hasPassword: !!r.passwordHash,
    participantCount: roomSummary(r.code)?.participantCount || 0,
    recording: roomSummary(r.code)?.recording || false,
  });
});

// verificar senha (pré-entrada)
app.post('/api/rooms/:code/check', (req, res) => {
  const r = db.rooms[req.params.code.toUpperCase()];
  if (!r || r.closed) return res.status(404).json({ error: 'Sala não encontrada' });
  if (!r.passwordHash) return res.json({ ok: true });
  const ok = hash(String(req.body?.password || '')) === r.passwordHash;
  res.json({ ok });
});

// lista de salas ativas (modo demo/público)
app.get('/api/rooms', (req, res) => {
  const list = Object.keys(db.rooms)
    .map(roomSummary)
    .filter(Boolean)
    .filter(s => !s.closed);
  res.json(list);
});

app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ---------------------------------------------------------------------------
// Socket.IO — estado vivo das salas
// liveRooms: code -> { participants:Map<socketId,p>, stage:Set<socketId>,
//                      layout, recording:{active,startedAt,chunks}, chat:[],
//                      mutedHosts:Set<socketId>, sockets:io.of().in(code) }
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });
const liveRooms = new Map();

function ensureLive(code) {
  if (!liveRooms.has(code)) {
    liveRooms.set(code, {
      participants: new Map(),
      stage: new Set(),
      layout: db.rooms[code]?.layout || 'grid',
      recording: { active: false, startedAt: 0 },
      chat: [],
      mutedHosts: new Set(),
    });
  }
  return liveRooms.get(code);
}

function publicParticipant(p) {
  return {
    id: p.id, name: p.name, role: p.role, avatarColor: p.avatarColor,
    onStage: p.onStage, inWaitingRoom: p.inWaitingRoom,
    camOn: p.camOn, micOn: p.micOn, handRaised: p.handRaised,
  };
}

function broadcastState(code) {
  const live = liveRooms.get(code);
  if (!live) return;
  const parts = [...live.participants.values()].map(publicParticipant);
  io.to(code).emit('state', {
    participants: parts,
    stage: [...live.stage],
    layout: live.layout,
    recording: live.recording,
    chat: live.chat.slice(-200),
  });
  const r = db.rooms[code];
  if (r) { r.stage = [...live.stage]; r.layout = live.layout; saveDb(); }
}

function findInvite(room, token) {
  return room?.invites?.find(i => i.token === token);
}

io.on('connection', (socket) => {
  let joined = null; // código da sala

  socket.on('join', (payload, ack) => {
    try {
      const { code, name, password, inviteToken, role, hostFlag } = payload || {};
      const room = db.rooms[(code || '').toUpperCase()];
      if (!room || room.closed) return ack?.({ error: 'Sala não encontrada ou encerrada.' });
      if (room.passwordHash && hash(String(password || '')) !== room.passwordHash)
        return ack?.({ error: 'Senha incorreta.' });

      let finalRole = (role === 'host' || hostFlag) ? 'host' : 'guest';
      const invite = inviteToken ? findInvite(room, inviteToken) : null;
      if (inviteToken && !invite) return ack?.({ error: 'Convite inválido.' });
      if (invite) {
        finalRole = invite.role || 'guest';
        if (finalRole === 'guest') {
          if (invite.status !== 'pending') return ack?.({ error: 'Convite já utilizado ou expirado.' });
          invite.status = 'accepted';
        } else {
          invite.status = 'accepted'; // link de bastidores é reutilizável
        }
        saveDb();
      } else if (finalRole === 'host') {
        // só o criador pode entrar como host sem convite (primeiro host da sala viva)
        const live = liveRooms.get(room.code);
        const hostOnline = live && [...live.participants.values()].some(p => p.role === 'host');
        if (hostOnline) return ack?.({ error: 'Já existe um apresentador na sala. Use um convite.' });
      }

      const live = ensureLive(room.code);
      if (live.participants.size >= room.maxGuests)
        return ack?.({ error: 'Sala cheia.' });

      joined = room.code;
      socket.join(room.code);
      const p = {
        id: socket.id,
        name: String(name || 'Convidado').slice(0, 40),
        role: finalRole,
        avatarColor: `hsl(${Math.floor(Math.random() * 360)},65%,55%)`,
        onStage: false,
        inWaitingRoom: room.waitingRoomEnabled && finalRole === 'guest',
        camOn: false, micOn: false, handRaised: false,
      };
      // primeiro host entra direto no palco
      if (finalRole === 'host') { p.onStage = true; p.inWaitingRoom = false; live.stage.add(socket.id); }
      live.participants.set(socket.id, p);
      saveDb();

      ack?.({
        ok: true,
        you: publicParticipant(p),
        room: { code: room.code, name: room.name, chatEnabled: room.chatEnabled,
                waitingRoomEnabled: room.waitingRoomEnabled, hasPassword: !!room.passwordHash },
      });
      socket.to(room.code).emit('toast', `${p.name} entrou na sala`);
      broadcastState(room.code);
    } catch (e) {
      console.error(e);
      ack?.({ error: 'Falha ao entrar na sala.' });
    }
  });

  function requireRoom() {
    const live = joined && liveRooms.get(joined);
    const room = joined && db.rooms[joined];
    if (!live || !room) return null;
    const me = live.participants.get(socket.id);
    return me ? { live, room, me } : null;
  }

  // atualiza flags locais (cam/mic) para renderizar nos outros clientes
  socket.on('mediaFlags', ({ camOn, micOn }) => {
    const ctx = requireRoom(); if (!ctx) return;
    ctx.me.camOn = !!camOn; ctx.me.micOn = !!micOn;
    broadcastState(joined);
  });

  socket.on('hand', (raised) => {
    const ctx = requireRoom(); if (!ctx) return;
    ctx.me.handRaised = !!raised;
    broadcastState(joined);
    if (raised) io.to(joined).emit('toast', `✋ ${ctx.me.name} levantou a mão`);
  });

  // ---- ações exclusivas do host ----
  function hostOnly(fn) {
    return (...args) => {
      const ctx = requireRoom();
      if (!ctx || ctx.me.role !== 'host') return;
      fn(ctx, ...args);
    };
  }

  socket.on('host:inviteGuest', hostOnly((ctx, cb) => {
    const token = uuid();
    ctx.room.invites.push({ token, name: '', role: 'guest', status: 'pending', createdAt: Date.now() });
    saveDb();
    const base = `http://${getPublicHost()}:${PORT}`;
    cb?.(`${base}/#/join/${ctx.room.code}?invite=${token}&role=guest`);
  }));

  socket.on('host:inviteBackstage', hostOnly((ctx, cb) => {
    const token = uuid();
    ctx.room.invites.push({ token, name: '', role: 'host', status: 'pending', createdAt: Date.now() });
    saveDb();
    const base = `http://${getPublicHost()}:${PORT}`;
    cb?.(`${base}/#/join/${ctx.room.code}?invite=${token}&role=host`);
  }));

  socket.on('host:setLayout', hostOnly((ctx, layout) => {
    if (['grid', 'speaker', 'strip'].includes(layout)) { ctx.live.layout = layout; broadcastState(joined); }
  }));

  socket.on('host:muteAll', hostOnly((ctx) => {
    io.to(joined).emit('forceMute');
    ctx.me.micOn = false;
    broadcastState(joined);
  }));

  socket.on('host:removeGuest', hostOnly((ctx, targetId) => {
    const t = ctx.live.participants.get(targetId);
    if (!t || t.role === 'host') return;
    io.to(targetId).emit('kicked');
    io.sockets.sockets.get(targetId)?.leave(joined);
    ctx.live.participants.delete(targetId);
    ctx.live.stage.delete(targetId);
    broadcastState(joined);
    io.to(joined).emit('toast', `${t.name} foi removido da sala`);
  }));

  socket.on('host:closeRoom', hostOnly((ctx) => {
    ctx.room.closed = true;
    saveDb();
    io.to(joined).emit('roomClosed');
  }));

  socket.on('host:startRecording', hostOnly(() => {
    const live = liveRooms.get(joined);
    live.recording = { active: true, startedAt: Date.now() };
    io.to(joined).emit('recordingStart');
    broadcastState(joined);
  }));

  socket.on('host:stopRecording', hostOnly(() => {
    const live = liveRooms.get(joined);
    live.recording = { active: false, startedAt: 0 };
    io.to(joined).emit('recordingStop');
    broadcastState(joined);
  }));

  socket.on('host:setStreamKey', hostOnly((ctx, key) => {
    ctx.room.streamKey = key ? String(key).slice(0, 120) : null;
    saveDb();
    io.to(joined).emit('toast', ctx.room.streamKey ? 'Chave de transmissão configurada' : 'Transmissão desativada');
  }));

  socket.on('host:getRoomInfo', hostOnly((ctx, cb) => {
    cb?.(roomSummary(ctx.room.code));
  }));

  // ---- admitir / recusar na sala de espera ----
  socket.on('host:admit', hostOnly((ctx, targetId) => {
    const t = ctx.live.participants.get(targetId);
    if (!t) return;
    t.inWaitingRoom = false;
    if (t.role === 'guest') { t.onStage = true; ctx.live.stage.add(targetId); }
    io.to(targetId).emit('admitted');
    broadcastState(joined);
  }));

  socket.on('host:reject', hostOnly((ctx, targetId) => {
    const t = ctx.live.participants.get(targetId);
    if (!t) return;
    io.to(targetId).emit('rejected');
    io.sockets.sockets.get(targetId)?.leave(joined);
    ctx.live.participants.delete(targetId);
    broadcastState(joined);
  }));

  // ---- convidar/remover do palco ----
  socket.on('host:inviteToStage', hostOnly((ctx, targetId) => {
    const t = ctx.live.participants.get(targetId);
    if (!t) return;
    t.onStage = true; ctx.live.stage.add(targetId);
    io.to(targetId).emit('youOnStage', true);
    broadcastState(joined);
  }));

  socket.on('host:removeFromStage', hostOnly((ctx, targetId) => {
    const t = ctx.live.participants.get(targetId);
    if (!t) return;
    t.onStage = false; ctx.live.stage.delete(targetId);
    io.to(targetId).emit('youOnStage', false);
    broadcastState(joined);
  }));

  socket.on('guest:leaveStage', () => {
    const ctx = requireRoom(); if (!ctx) return;
    ctx.me.onStage = false; ctx.live.stage.delete(socket.id);
    broadcastState(joined);
  });

  // ---- roteamento de sinalização WebRTC (mesh) ----
  const relay = (evt) => socket.on(evt, (msg) => {
    if (!joined || !msg?.to) return;
    io.to(msg.to).emit(evt, { from: socket.id, sdp: msg.sdp, candidate: msg.candidate });
  });
  relay('webrtc:offer');
  relay('webrtc:answer');
  relay('webrtc:ice');

  // ---- chat ----
  socket.on('chat:send', (text) => {
    const ctx = requireRoom(); if (!ctx) return;
    const room = ctx.room;
    if (!room.chatEnabled) return;
    const msg = { from: ctx.me.name, role: ctx.me.role, text: String(text).slice(0, 500), ts: Date.now() };
    ctx.live.chat.push(msg);
    if (ctx.live.chat.length > 500) ctx.live.chat.shift();
    io.to(joined).emit('chat:new', msg);
  });

  socket.on('disconnect', () => {
    if (!joined) return;
    const live = liveRooms.get(joined);
    if (live) {
      const p = live.participants.get(socket.id);
      if (p) io.to(joined).emit('toast', `${p.name} saiu`);
      live.participants.delete(socket.id);
      live.stage.delete(socket.id);
      if (live.participants.size === 0) {
        liveRooms.delete(joined); // sala vazia sai da memória (persiste no json)
      } else {
        broadcastState(joined);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Cliente estático + SPA fallback
// ---------------------------------------------------------------------------
app.use(express.static(CLIENT_DIR));
app.get('*', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));

let cachedHost = null;
function getPublicHost() {
  if (cachedHost) return cachedHost;
  cachedHost = process.env.PUBLIC_HOST || Object.values(os.networkInterfaces())
    .flat().filter(i => i && i.family === 'IPv4' && !i.internal)[0]?.address || 'localhost';
  return cachedHost;
}

loadDb();
server.listen(PORT, () => {
  console.log(`SyncStream rodando em http://localhost:${PORT} (host público: ${getPublicHost()})`);
});
