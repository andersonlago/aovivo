import { io } from 'socket.io-client';

const BASE = 'http://localhost:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function createRoom() {
  return fetch(BASE + '/api/rooms', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name: 'Sala Teste', hostName: 'Ana', password: 'segredo', maxGuests: 10 }) }).then(r => r.json());
}

function connect() { return new Promise(res => { const s = io(BASE); s.on('connect', () => res(s)); }); }
function join(s, payload) { return new Promise(res => s.emit('join', payload, res)); }
function once(s, evt) { return new Promise(res => s.once(evt, res)); }
function watchState(s) { s.on('state', x => s.__lastState = x); }

// 1. criar sala
const room = await createRoom();
console.log('1. sala criada:', room.code, '| backstage?', !!room.backstageUrl);

// 2. host entra (senha errada deve falhar)
const host = await connect(); watchState(host);
let r = await join(host, { code: room.code, name: 'Ana', password: 'errada', role: 'host' });
console.log('2a. senha errada bloqueada:', r.error === 'Senha incorreta.');
r = await join(host, { code: room.code, name: 'Ana', password: 'segredo', role: 'host' });
console.log('2b. host entrou:', r.ok, '| no palco:', r.you.onStage, '| espera:', r.you.inWaitingRoom);

// 3. convidado via link de convite
const inviteUrl = await new Promise(res => host.emit('host:inviteGuest', res));
const token = inviteUrl.match(/invite=([^&]+)/)[1];
const guest = await connect(); watchState(guest);
const gr = await join(guest, { code: room.code, name: 'Beto', password: 'segredo', inviteToken: token, role: 'guest' });
console.log('3. convidado entrou na sala de espera:', gr.ok, gr.you.inWaitingRoom === true);

// 4. host admite -> guest recebe 'admitted'
const admittedP = once(guest, 'admitted');
host.emit('host:admit', gr.you.id);
await admittedP;
console.log('4. admitido ✓');

// 5. admitido já foi ao palco; aguarda broadcast com stage completo (2 pessoas)
let st = null;
for (let i = 0; i < 30; i++) {
  const snap = guest.__lastState;
  if (snap && snap.stage.length === 2) { st = snap; break; }
  await sleep(100);
}
console.log('5. palco tem 2 pessoas:', !!st);

// 6. chat sincronizado
const chatP = once(host, 'chat:new');
guest.emit('chat:send', 'olá!');
const msg = await chatP;
console.log('6. chat chegou ao host:', msg.text === 'olá!' && msg.from === 'Beto');

// 7. hand raise + media flags
guest.emit('hand', true);
guest.emit('mediaFlags', { camOn: true, micOn: true });
await sleep(400);
const gb = host.__lastState.participants.find(p => p.name === 'Beto');
console.log('7. mão levantada/cam:', gb.handRaised === true && gb.camOn === true);

// 8. gravação sincronizada
host.emit('host:startRecording');
await sleep(400);
console.log('8. REC ativo para todos:', guest.__lastState?.recording.active === true);

// 9. layout compartilhado
host.emit('host:setLayout', 'speaker');
await sleep(400);
console.log('9. layout speaker:', guest.__lastState?.layout === 'speaker');

// 10. segundo host via convite backstage (reutilizável)
const back = await new Promise(res => host.emit('host:inviteBackstage', res));
const btok = back.match(/invite=([^&]+)/)[1];
const co = await connect();
const cr = await join(co, { code: room.code, name: 'Carol', password: 'segredo', inviteToken: btok, role: 'host' });
const cr2 = await join(await connect(), { code: room.code, name: 'Dan', password: 'segredo', inviteToken: btok, role: 'host' });
console.log('10. bastidores reutilizável:', cr.ok && cr.you.role === 'host' && cr2.ok);

// 11. kick (apenas convidados podem ser expulsos — hosts não)
let kickedGot = false;
co.once('kicked', () => kickedGot = true);
host.emit('host:removeGuest', cr.you.id);
await sleep(500);
console.log('11. host protegido de kick:', kickedGot === false);
// agora convida um guest e o expulsa
const g2url = await new Promise(res => host.emit('host:inviteGuest', res));
const g2tok = g2url.match(/invite=([^&]+)/)[1];
const g2 = await connect(); watchState(g2);
const g2r = await join(g2, { code: room.code, name: 'Zoe', password: 'segredo', inviteToken: g2tok });
kickedGot = false;
g2.once('kicked', () => kickedGot = true);
host.emit('host:removeGuest', g2r.you.id);
await sleep(500);
console.log('11b. guest expulso:', kickedGot === true);

// 12. relay WebRTC entre dois peers no palco
const gotOffer = once(host, 'webrtc:offer');
guest.emit('webrtc:offer', { to: host.id, sdp: { type: 'offer', sdp: 'x' } });
const o = await gotOffer;
console.log('12. sinalização roteada:', o.from === guest.id && o.sdp.type === 'offer');

// 13. encerrar sala
const closedP = once(guest, 'roomClosed');
host.emit('host:closeRoom');
await closedP;
console.log('13. sala encerrada para todos ✓');

const after = await join(await connect(), { code: room.code, name: 'Eve', password: 'segredo' });
console.log('14. sala fechada recusa novos:', !!after.error);

host.disconnect(); guest.disconnect(); co.disconnect();
process.exit(0);
