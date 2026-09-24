// SyncStream — cliente SPA (somente navegador)
// WebRTC em malha (mesh) entre participantes no palco; sinalização via Socket.IO.
// Sincronização de estado (palco, layout, gravação, chat, sala de espera) via servidor.

/* global io */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  socket: null,
  room: null,          // { code, name, ... }
  you: null,           // seu participante público
  role: 'guest',
  inviteToken: null,
  participants: [],    // estado vindo do servidor
  stageIds: [],
  localStream: null,   // câmera+microfone
  screenStream: null,
  peers: new Map(),    // socketId -> { pc, streams:{video,audio} }
  micOn: false, camOn: false, sharing: false, handRaised: false,
  recTimer: null, mediaRecorder: null, recChunks: [],
};

// ---------------------------------------------------------------------------
// Navegação por hash: #/ , #/join/CODE?invite=...&role=...
// ---------------------------------------------------------------------------
function show(screenId) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(screenId).classList.add('active');
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const q = Object.fromEntries(new URLSearchParams(query || ''));
  return { path: path.split('/'), q };
}

async function route() {
  const { path, q } = parseHash();
  if (path[0] === 'join' && path[1]) {
    state.inviteToken = q.invite || null;
    openLobby(path[1].toUpperCase(), q.role === 'host');
  } else {
    stopLobbyPreview();
    show('#screen-home');
    loadRooms();
  }
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------------
async function loadRooms() {
  try {
    const list = await fetch('/api/rooms').then(r => r.json());
    const el = $('#room-list');
    if (!list.length) { el.innerHTML = '<em>Nenhuma sala ativa agora.</em>'; return; }
    el.innerHTML = '';
    for (const r of list) {
      const div = document.createElement('div');
      div.className = 'room-item';
      div.innerHTML = `<div><b>${esc(r.name)}</b> <span class="code">${r.code}</span>
        <div class="meta">👤 ${esc(r.hostName)} · ${r.participantCount} online${r.hasPassword ? ' · 🔒' : ''}${r.recording ? ' · <span style="color:#ff3b30">● AO VIVO</span>' : ''}</div></div>
        <button class="btn">Entrar</button>`;
      div.onclick = () => location.hash = `/join/${r.code}`;
      el.appendChild(div);
    }
  } catch { /* servidor fora do ar */ }
}

$('#form-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: $('#cr-name').value.trim(),
    hostName: $('#cr-host').value.trim(),
    password: $('#cr-pass').value,
    maxGuests: $('#cr-max').value,
    waitingRoom: $('#cr-wait').checked,
  };
  const res = await fetch('/api/rooms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json());
  if (res.error) return toast('⚠️ ' + res.error);
  // guarda o link de bastidores (host) para reuso/reconexão
  try { localStorage.setItem('ss-backstage-' + res.code, res.backstageUrl); } catch {}
  location.hash = `/join/${res.code}?host=1&name=${encodeURIComponent(body.hostName)}`;
});

$('#form-join-code').addEventListener('submit', (e) => {
  e.preventDefault();
  let v = $('#jc-code').value.trim();
  const m = v.match(/join\/([A-Za-z0-9]+)/);
  if (m) v = m[1];
  location.hash = `/join/${v.toUpperCase()}`;
});

// ---------------------------------------------------------------------------
// LOBBY (pré-entrada com preview de câmera/mic)
// ---------------------------------------------------------------------------
let lobbyStream = null;
async function openLobby(code, isHost) {
  show('#screen-lobby');
  state.roomCode = code;
  state.pendingHost = isHost;
  $('#lb-error').textContent = '';
  $('#lb-title').textContent = isHost ? `🎬 Criando estúdio ${code}` : `Entrando em ${code}`;
  $('#lb-sub').textContent = 'Teste sua câmera e microfone antes de entrar.';

  try {
    const info = await fetch(`/api/rooms/${code}`).then(r => r.json());
    if (info.error) { $('#lb-join-btn').disabled = true; $('#lb-error').textContent = info.error; return; }
    $('#lb-pass-wrap').style.display = info.hasPassword ? '' : 'none';
    $('#lb-title').textContent = `${isHost ? '🎬' : '📺'} ${info.name}`;
    $('#lb-sub').textContent = `Sala de ${info.hostName} · ${info.participantCount} pessoa(s) online`;
  } catch { $('#lb-error').textContent = 'Sala não encontrada.'; }

  const { q } = parseHash();
  if (q.name) $('#lb-name').value = q.name;
  if (state.inviteToken) $('#lb-join-btn').textContent = 'Aceitar convite e entrar';
}

async function startLobbyPreview(kind) {
  try {
    const constraints = kind === 'cam' ? { video: true } : { audio: true };
    const s = await navigator.mediaDevices.getUserMedia(constraints);
    if (kind === 'cam') {
      lobbyStream = mergeStreams([lobbyStream, s]);
      $('#lb-video').srcObject = lobbyStream;
      $('#lb-nocam').style.display = 'none';
      $('#lb-toggle-cam').textContent = '🎥 Câmera ligada ✓';
    } else {
      lobbyStream = mergeStreams([lobbyStream, s]);
      $('#lb-toggle-mic').textContent = '🎙️ Microfone ligado ✓';
    }
  } catch (err) {
    toast('⚠️ Permissão negada para ' + (kind === 'cam' ? 'câmera' : 'microfone'));
  }
}

function mergeStreams(streams) {
  const tracks = streams.filter(Boolean).flatMap(s => s.getTracks());
  return tracks.length ? new MediaStream(tracks) : null;
}

function stopLobbyPreview() {
  lobbyStream?.getTracks().forEach(t => t.stop());
  lobbyStream = null;
}

$('#lb-toggle-cam').onclick = () => startLobbyPreview('cam');
$('#lb-toggle-mic').onclick = () => startLobbyPreview('mic');

$('#form-lobby').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#lb-name').value.trim();
  if (!name) return;
  connectAndJoin({
    code: state.roomCode,
    name,
    password: $('#lb-pass').value,
    inviteToken: state.inviteToken,
    role: state.pendingHost ? 'host' : 'guest',
    hostFlag: state.pendingHost,
  });
});

$('#wt-leave').onclick = () => leaveAll();

// ---------------------------------------------------------------------------
// SOCKET + CONEXÃO
// ---------------------------------------------------------------------------
function connectAndJoin(payload) {
  state.socket = io();
  const sock = state.socket;

  sock.emit('join', payload, async (res) => {
    if (res.error) {
      $('#lb-error').textContent = res.error;
      sock.disconnect();
      return;
    }
    state.you = res.you;
    state.room = res.room;
    state.role = res.you.role;
    stopLobbyPreview();

    if (res.you.inWaitingRoom) {
      show('#screen-waiting');
      $('#wt-role').textContent = res.you.name;
    } else {
      await enterStudio();
    }
    wireSocket(sock);
  });
}

function wireSocket(sock) {
  sock.on('admitted', async () => { toast('✅ Você foi chamado para o estúdio!'); await enterStudio(); });
  sock.on('rejected', () => { toast('😕 O apresentador recusou sua entrada.'); leaveAll(); });
  sock.on('kicked', () => { toast('Você foi removido da sala.'); leaveAll(); });
  sock.on('roomClosed', () => { toast('A transmissão foi encerrada.'); leaveAll(); });
  sock.on('toast', (msg) => toast(msg));
  sock.on('forceMute', () => { if (state.you?.id !== sock.id) setMic(false); });
  sock.on('youOnStage', (on) => toast(on ? '🎤 Você foi chamado ao palco!' : 'Você saiu do palco.'));

  sock.on('state', (s) => {
    state.participants = s.participants;
    const prevStageKey = (state.stageIds || []).slice().sort().join(',');
    state.stageIds = s.stage;
    renderStage(s);
    updateCounts(s);
    // só re-negocia WebRTC quando a composição do palco mudou de fato —
    // evita reconexões supérfluas a cada flag de cam/mic/hand broadcastada
    if (prevStageKey !== s.stage.slice().sort().join(',')) renegotiateAll();
    syncRecordingUI(s.recording);
  });

  sock.on('chat:new', (m) => appendChat(m));

  // ---- sinalização WebRTC ----
  sock.on('webrtc:offer', ({ from, sdp }) => handleOffer(from, sdp));
  sock.on('webrtc:answer', ({ from, sdp }) => handleAnswer(from, sdp));
  sock.on('webrtc:ice', ({ from, candidate }) => handleIce(from, candidate));
  sock.on('disconnect', () => toast('⚠️ Conexão perdida com o servidor.'));
}

async function enterStudio() {
  show('#screen-studio');
  $('#room-badge').textContent = `${state.room.name} · ${state.room.code}`;
  $('#host-controls').classList.toggle('hidden', state.role !== 'host');
  $('#btn-chat-guest').classList.toggle('hidden', !state.room.chatEnabled || state.role === 'host');
  // inicia mídia local (falha silenciosa se usuário recusar)
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    state.camOn = true; state.micOn = true;
  } catch {
    try { state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); state.micOn = true; }
    catch { state.localStream = null; }
  }
  updateMediaButtons();
  emitFlags();
  renegotiateAll();
}

// ---------------------------------------------------------------------------
// PALCO / TILES
// ---------------------------------------------------------------------------
function tileFor(id) {
  return document.getElementById('tile-' + CSS.escape(id));
}

function renderStage(s) {
  const area = $('#stage-area');
  area.className = 'stage ' + (s.layout || 'grid');
  const onStage = s.participants.filter(p => p.onStage && !p.inWaitingRoom);

  // remove tiles que sumiram
  $$('#stage-area .tile').forEach(t => {
    const id = t.dataset.id;
    if (!onStage.some(p => p.id === id)) t.remove();
  });

  if (!onStage.length) {
    if (!$('#stage-area .empty-stage')) {
      area.innerHTML = '<div class="empty-stage">Ninguém no palco ainda…</div>';
    }
    return;
  }
  area.querySelector('.empty-stage')?.remove();

  for (const p of onStage) {
    let tile = tileFor(p.id);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      tile.id = 'tile-' + p.id;
      tile.dataset.id = p.id;
      tile.innerHTML = `
        <video autoplay playsinline></video>
        <div class="avatar" style="display:none"></div>
        <div class="name-tag"><span class="nm"></span><span class="mic"></span></div>
        <div class="hand" style="display:none">✋</div>
        <div class="tile-actions" style="display:none"></div>`;
      area.appendChild(tile);
    }
    // ordem visual
    area.appendChild(tile);

    const isMe = p.id === (state.you?.id);
    tile.classList.toggle('onstage', true);
    tile.querySelector('.nm').textContent = isMe ? p.name + ' (você)' : p.name;
    tile.querySelector('.mic').innerHTML = p.micOn ? '' : '<span class="mic-off">🔇</span>';
    tile.querySelector('.hand').style.display = p.handRaised ? '' : 'none';

    const avatar = tile.querySelector('.avatar');
    const video = tile.querySelector('video');
    const showAvatar = isMe ? !state.camOn && !state.sharing : !p.camOn;
    avatar.style.display = showAvatar ? 'flex' : 'none';
    if (showAvatar) {
      avatar.textContent = initials(p.name);
      avatar.style.background = p.avatarColor;
    }
    video.style.display = showAvatar ? 'none' : 'block';
    video.classList.toggle('mirror', isMe && !state.sharing);

    // anexa stream
    attachStreamToTile(p.id, isMe);

    // ações do host sobre convidados
    const actions = tile.querySelector('.tile-actions');
    if (state.role === 'host' && p.role !== 'host') {
      actions.style.display = 'flex';
      actions.innerHTML = `
        <button data-a="stage">${p.onStage ? '↓ Palco' : '↑ Palco'}</button>
        <button data-a="kick">✕</button>`;
      actions.querySelector('[data-a="stage"]').onclick = () =>
        state.socket.emit(p.onStage ? 'host:removeFromStage' : 'host:inviteToStage', p.id);
      actions.querySelector('[data-a="kick"]').onclick = () =>
        state.socket.emit('host:removeGuest', p.id);
    } else if (state.role === 'host' && p.role === 'host' && p.id !== state.you.id) {
      actions.style.display = 'flex';
      actions.innerHTML = `<button data-a="stage">↓ Palco</button>`;
      actions.querySelector('[data-a="stage"]').onclick = () =>
        state.socket.emit('host:removeFromStage', p.id);
    } else {
      actions.style.display = 'none';
    }
  }

  // painel de espera para o host (dentro do chat/modal simples)
  if (state.role === 'host') renderWaitingPanel(s);
}

function renderWaitingPanel(s) {
  const waiting = s.participants.filter(p => p.inWaitingRoom);
  let panel = $('#waiting-panel');
  if (!waiting.length) { panel?.remove(); return; }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'waiting-panel';
    panel.className = 'chat';
    panel.style.bottom = '84px'; panel.style.right = '352px';
    panel.innerHTML = `<div class="chat-head">🚪 Sala de espera</div><div id="wait-list" style="overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px"></div>`;
    $('#screen-studio').appendChild(panel);
  }
  const list = panel.querySelector('#wait-list');
  list.innerHTML = '';
  for (const w of waiting) {
    const row = document.createElement('div');
    row.className = 'room-item';
    row.innerHTML = `<span>${esc(w.name)}</span>`;
    const ok = document.createElement('button'); ok.className = 'btn'; ok.textContent = 'Admitir ✓';
    ok.onclick = () => state.socket.emit('host:admit', w.id);
    const no = document.createElement('button'); no.className = 'btn danger'; no.textContent = '✕';
    no.onclick = () => state.socket.emit('host:reject', w.id);
    row.append(ok, no);
    list.appendChild(row);
  }
}

function updateCounts(s) {
  const active = s.participants.filter(p => !p.inWaitingRoom);
  $('#online-count').textContent = `👥 ${active.length} online`;
}

function initials(name) {
  return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

// ---------------------------------------------------------------------------
// WEBRTC MESH (só entre participantes no palco)
// ---------------------------------------------------------------------------
const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function peerEntries() { return [...state.peers.keys()]; }

function createPeer(remoteId, initiator) {
  const pc = new RTCPeerConnection(RTC_CFG);
  const entry = { pc, remoteVideo: null, remoteAudioEl: null };
  state.peers.set(remoteId, entry);

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);
  }
  if (state.screenStream) {
    for (const track of state.screenStream.getTracks()) pc.addTrack(track, state.screenStream);
  }

  pc.ontrack = (ev) => {
    const stream = ev.streams[0];
    if (ev.track.kind === 'video') {
      entry.remoteVideo = stream;
      attachStreamToTile(remoteId, false);
    } else {
      // áudio em elemento separado (garante reprodução mesmo sem tile)
      if (!entry.remoteAudioEl) {
        entry.remoteAudioEl = document.createElement('audio');
        entry.remoteAudioEl.autoplay = true;
        document.body.appendChild(entry.remoteAudioEl);
      }
      entry.remoteAudioEl.srcObject = stream;
      entry.remoteAudioEl.play().catch(() => {});
    }
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) state.socket.emit('webrtc:ice', { to: remoteId, candidate: ev.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) destroyPeer(remoteId);
  };

  if (initiator) {
    pc.onnegotiationneeded = async () => {
      try {
        await pc.setLocalDescription(await pc.createOffer());
        state.socket.emit('webrtc:offer', { to: remoteId, sdp: pc.localDescription });
      } catch (e) { console.error(e); }
    };
  }
  return entry;
}

function destroyPeer(id) {
  const e = state.peers.get(id);
  if (!e) return;
  try { e.pc.close(); } catch {}
  e.remoteAudioEl?.remove();
  state.peers.delete(id);
}

function handlePeerSync() {
  const want = new Set((state.stageIds || []).filter(id => id !== state.socket?.id));
  // desconecta quem saiu
  for (const id of peerEntries()) {
    if (!want.has(id)) destroyPeer(id);
  }
  // conecta novos (quem tem localStream oferece)
  if (state.localStream) {
    for (const id of want) {
      if (!state.peers.has(id)) createPeer(id, true);
    }
  }
}

function renegotiateAll() {
  for (const id of [...state.peers.keys()]) destroyPeer(id);
  const live = state.stageIds.filter(x => x !== state.socket?.id);
  for (const id of live) if (state.localStream) createPeer(id, true);
}

async function handleOffer(from, sdp) {
  if (!state.stageIds.includes(from) || !state.stageIds.includes(state.socket.id)) return;
  let entry = state.peers.get(from);
  if (!entry) entry = createPeer(from, false);
  const pc = entry.pc;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await pc.setLocalDescription(await pc.createAnswer());
    state.socket.emit('webrtc:answer', { to: from, sdp: pc.localDescription });
  } catch (e) { console.error(e); }
}

async function handleAnswer(from, sdp) {
  const entry = state.peers.get(from);
  if (!entry) return;
  try { await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp)); } catch (e) { console.error(e); }
}

async function handleIce(from, candidate) {
  const entry = state.peers.get(from);
  if (!entry) return;
  try { await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
}

function attachStreamToTile(peerId, isMe) {
  const tile = tileFor(peerId);
  if (!tile) return;
  const video = tile.querySelector('video');
  let stream = null;
  if (isMe) {
    stream = state.sharing ? state.screenStream : state.localStream;
    // mixa vídeo de tela + câmera? mantemos simples: tela substitui câmera
  } else {
    stream = state.peers.get(peerId)?.remoteVideo || null;
  }
  if (stream && video.srcObject !== stream) {
    video.srcObject = stream;
    video.play().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// BARRA DE FERRAMENTAS
// ---------------------------------------------------------------------------
function emitFlags() {
  state.socket?.emit('mediaFlags', { camOn: state.camOn, micOn: state.micOn });
}

function updateMediaButtons() {
  $('#btn-mic').classList.toggle('off', !state.micOn);
  $('#btn-cam').classList.toggle('off', !state.camOn);
  $('#btn-share').classList.toggle('off', !state.sharing);
  $('#btn-hand').classList.toggle('active-hand', state.handRaised);
}

function setMic(on) {
  state.micOn = on;
  state.localStream?.getAudioTracks().forEach(t => t.enabled = on);
  updateMediaButtons(); emitFlags();
}
function setCam(on) {
  state.camOn = on;
  state.localStream?.getVideoTracks().forEach(t => t.enabled = on);
  updateMediaButtons(); emitFlags();
}

$('#btn-mic').onclick = () => setMic(!state.micOn);
$('#btn-cam').onclick = () => setCam(!state.camOn);

$('#btn-hand').onclick = () => {
  state.handRaised = !state.handRaised;
  state.socket.emit('hand', state.handRaised);
  updateMediaButtons();
};

$('#btn-share').onclick = async () => {
  if (state.sharing) {
    stopScreenShare();
    return;
  }
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    state.sharing = true;
    state.screenStream.getVideoTracks()[0].onended = () => $('#btn-share').click();
    // adiciona a track de tela às conexões já existentes via replaceTrack —
    // evita re-negociar tudo (sem "flash"/black frame nos outros participantes)
    for (const [, e] of state.peers) {
      const sender = e.pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(state.screenStream.getVideoTracks()[0]).catch(() => {});
    }
    updateMediaButtons();
    toast('🖥️ Compartilhando sua tela');
  } catch { /* cancelou */ }
};

function stopScreenShare() {
  state.screenStream?.getTracks().forEach(t => t.stop());
  state.screenStream = null; state.sharing = false;
  for (const [, e] of state.peers) {
    const sender = e.pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender) sender.replaceTrack(state.localStream?.getVideoTracks()[0] || null).catch(() => {});
  }
  updateMediaButtons();
}

$('#btn-leave').onclick = () => leaveAll();

// ---- controles do host ----
$('#sel-layout').onchange = (e) => state.socket.emit('host:setLayout', e.target.value);
$('#btn-muteall').onclick = () => state.socket.emit('host:muteAll');
$('#btn-end').onclick = () => {
  if (confirm('Encerrar a sala para todos?')) state.socket.emit('host:closeRoom'), setTimeout(leaveAll, 300);
};

$('#btn-invite').onclick = () => {
  state.socket.emit('host:inviteGuest', (url) => showModal('🔗 Link de convite', url, true));
};
$('#btn-invite-host').onclick = () => {
  state.socket.emit('host:inviteBackstage', (url) =>
    showModal('🎭 Convite de co-apresentador (entra nos bastidores/palco)', url, true));
};

$('#btn-record').onclick = () => {
  const recording = !!state._recActive;
  if (recording) state.socket.emit('host:stopRecording');
  else state.socket.emit('host:startRecording');
};

function syncRecordingUI(rec) {
  state._recActive = rec?.active;
  const btn = $('#btn-record');
  const ind = $('#rec-indicator');
  if (rec?.active) {
    btn.classList.add('on'); btn.textContent = '⏹️ Parar';
    ind.classList.remove('hidden');
    clearInterval(state.recTimer);
    state.recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - rec.startedAt) / 1000);
      $('#rec-time').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
    if (state.role === 'host' && !state.mediaRecorder) startLocalRecording();
  } else {
    btn.classList.remove('on'); btn.textContent = '⏺️ Gravar';
    ind.classList.add('hidden');
    clearInterval(state.recTimer);
    stopLocalRecording();
  }
}

// gravação client-side do host (composiciona as faixas visíveis num canvas)
async function startLocalRecording() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d');
    const anim = setInterval(() => {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const tiles = $$('#stage-area .tile video');
      const n = Math.max(tiles.length, 1);
      const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
      tiles.forEach((v, i) => {
        if (v.videoWidth) {
          const c = i % cols, r = Math.floor(i / cols);
          ctx.drawImage(v, c * (canvas.width / cols), r * (canvas.height / rows), canvas.width / cols, canvas.height / rows);
        }
      });
    }, 66);
    const cs = canvas.captureStream(15);
    // adiciona todas as faixas de áudio (local + remotas)
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = audioCtx.createMediaStreamDestination();
    const addAudio = (stream) => {
      stream?.getAudioTracks().forEach(() => {
        try { audioCtx.createMediaStreamSource(stream).connect(dest); } catch {}
      });
    };
    addAudio(state.localStream);
    for (const e of state.peers.values()) {
      if (e.remoteAudioEl?.srcObject) addAudio(e.remoteAudioEl.srcObject);
    }
    const mixed = new MediaStream([...cs.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mr = new MediaRecorder(mixed, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' });
    state._recAnim = anim; state._recAudioCtx = audioCtx;
    state.recChunks = [];
    mr.ondataavailable = (e) => e.data.size && state.recChunks.push(e.data);
    mr.onstop = () => {
      const blob = new Blob(state.recChunks, { type: 'video/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `syncstream-${state.room.code}-${Date.now()}.webm`;
      a.click();
      toast('💾 Gravação salva no seu computador');
    };
    mr.start(2000);
    state.mediaRecorder = mr;
  } catch (e) { console.error('gravação indisponível:', e); }
}

function stopLocalRecording() {
  clearInterval(state._recAnim);
  try { state.mediaRecorder?.stop(); } catch {}
  state.mediaRecorder = null;
  try { state._recAudioCtx?.close(); } catch {}
}

$('#btn-stream').onclick = () => {
  showModal('📡 Transmitir para YouTube/Twitch',
    `Cole aqui sua <b>chave RTMP</b> (do OBS você aponta para o servidor; nesta versão simplificada a chave fica salva na sala como referência para uso com OBS Virtual Camera):` +
    `<input id="stream-key-input" placeholder="live/xxxx-xxxx-xxxx">`,
    false, () => {
      state.socket.emit('host:setStreamKey', $('#stream-key-input')?.value || '');
      closeModal();
    });
};

// ---------------------------------------------------------------------------
// CHAT
// ---------------------------------------------------------------------------
function toggleChat(force) {
  const p = $('#chat-panel');
  p.classList.toggle('hidden', force === undefined ? !p.classList.contains('hidden') : !force);
}
$('#btn-chat-guest').onclick = () => toggleChat(true);
$('#btn-chat-toggle').onclick = () => toggleChat();
$('#chat-close').onclick = () => toggleChat(false);
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#chat-input').value.trim();
  if (!text) return;
  state.socket.emit('chat:send', text);
  $('#chat-input').value = '';
});

function appendChat(m) {
  const box = $('#chat-msgs');
  const div = document.createElement('div');
  div.className = 'msg' + (m.role === 'host' ? ' host' : '');
  div.innerHTML = `<b>${esc(m.from)}</b>: ${esc(m.text)}<span class="t">${new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------------------
// UTILIDADES
// ---------------------------------------------------------------------------
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

let modalCopyUrl = null;
function showModal(title, contentOrUrl, isLink, onOk) {
  $('#modal-title').innerHTML = title;
  const body = $('#modal-body');
  if (isLink) {
    modalCopyUrl = contentOrUrl;
    body.innerHTML = `<input readonly value="${esc(contentOrUrl)}" onclick="this.select()">
      <p class="muted" style="margin-top:8px;font-size:13px">Envie este link ao convidado. Ele entra automaticamente pelo convite.</p>`;
    $('#modal-copy').classList.remove('hidden');
  } else {
    modalCopyUrl = null;
    body.innerHTML = contentOrUrl;
    $('#modal-copy').classList.add('hidden');
  }
  $('#modal-bg').classList.remove('hidden');
  $('#modal-ok').onclick = () => { if (onOk) onOk(); else closeModal(); };
}
function closeModal() { $('#modal-bg').classList.add('hidden'); }
$('#modal-ok').onclick = closeModal;
$('#modal-copy').onclick = () => {
  navigator.clipboard.writeText(modalCopyUrl).then(() => toast('📋 Link copiado!'));
};
$('#modal-bg').onclick = (e) => { if (e.target.id === 'modal-bg') closeModal(); };

function leaveAll() {
  try {
    state.socket?.disconnect();
    state.localStream?.getTracks().forEach(t => t.stop());
    state.screenStream?.getTracks().forEach(t => t.stop());
    for (const id of [...state.peers.keys()]) destroyPeer(id);
    stopLocalRecording();
  } catch {}
  Object.assign(state, { socket: null, room: null, you: null, participants: [], stageIds: [], peers: new Map(), localStream: null, screenStream: null, sharing: false, micOn: false, camOn: false, handRaised: false });
  $('#waiting-panel')?.remove();
  $('#chat-msgs').innerHTML = '';
  $('#stage-area').innerHTML = '';
  location.hash = '/';
  show('#screen-home');
  loadRooms();
}

// reaplica streams locais quando um tile novo aparece (ex.: você mesmo)
const _origRender = renderStage;
renderStage = function (s) {
  _origRender(s);
  if (state.you && s.stage.includes(state.socket.id)) attachStreamToTile(state.socket.id, true);
};

// boot
route();
