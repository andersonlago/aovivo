# SyncStream — Documentação Técnica da Aplicação

> Alternativa self-hosted e dockerizada ao StreamYard: estúdios de vídeo ao vivo
> no navegador, muitas salas em paralelo, acesso simples por convite.
> Cliente requer **apenas um navegador moderno** — zero instalação.

Índice: [1. Visão geral](#1-visão-geral) · [2. Arquitetura](#2-arquitetura) ·
[3. Estrutura do repositório](#3-estrutura-do-repositório) · [4. Requisitos](#4-requisitos) ·
[5. Instalação e execução](#5-instalação-e-execução) · [6. Configuração](#6-configuração) ·
[7. Guia de uso](#7-guia-de-uso) · [8. API REST](#8-api-rest) ·
[9. Protocolo Socket.IO](#9-protocolo-socketio) · [10. Modelo de dados](#10-modelo-de-dados) ·
[11. WebRTC e mídia](#11-webrtc-e-mídia) · [12. Segurança](#12-segurança) ·
[13. Escalabilidade](#13-escalabilidade) · [14. Testes](#14-testes) ·
[15. Troubleshooting](#15-troubleshooting) · [16. Limitações conhecidas](#16-limitações-conhecidas)

---

## 1. Visão geral

SyncStream permite criar "estúdios" (salas) de vídeo ao vivo diretamente no navegador:

| Papel | Descrição |
|---|---|
| **Host / Apresentador** | Cria a sala, controla admissões, palco, layout, gravação e encerramento. Entra direto no palco. |
| **Co-apresentador (bastidores)** | Entra com link de bastidores (`role=host` via convite): tem controles de host e link reutilizável. |
| **Guest / Convidado** | Entra pelo link de convite, aguarda na sala de espera e vai ao palco quando admitido. Convite de guest é de uso único. |
| **Plateia** | Participantes conectados que não estão no palco; veem/ouvem o palco e participam do chat. |

### Funcionalidades

- 🎬 Estúdio multi-pessoa com WebRTC mesh (vídeo + áudio P2P)
- 🔗 Convites por link: convidado (uso único) e bastidores (reutilizável)
- 🔒 Senha opcional da sala
- 🚪 Sala de espera com Admitir / Recusar
- 🎤 Palco ↔ Plateia (subir/descer convidados; guest pode sair do palco sozinho)
- ✋ Levantar a mão (notificação para todos)
- 🖥️ Compartilhar tela (`getDisplayMedia`, substitui a câmera do peer)
- 🎙️/📷 Ligar/desligar microfone e câmera; **Silenciar todos** pelo host
- 💬 Chat em tempo real (histórico dos últimos 500 msgs na sessão)
- 🧩 Layouts sincronizados: Grade (`grid`), Palestrante (`speaker`), Faixa (`strip`)
- ⏺️ Gravação: sinal `REC` para todos; host compõe canvas+WebAudio e baixa `.webm`
- 📡 Chave RTMP salva na sala (para push via OBS Virtual Camera / encoder externo)
- 👥 Lista pública de salas ativas na home
- 🚪 Encerrar sala derruba todos os participantes
- ♻️ Reconexão: link de bastidores fica salvo no navegador do apresentador
- 🏠 Muitas salas simultâneas e independentes em um único servidor

---

## 2. Arquitetura

```
┌──────────────┐   HTTP (SPA + REST)   ┌─────────────────────────────┐
│ Navegadores  │ ────────────────────► │  Node.js (server/index.js)  │
│ (client SPA) │   WebSocket           │  ├─ Express  → /api/*       │
│              │ ◄────────────────────► │  ├─ Socket.IO → estado/sig. │
└──────┬───────┘                        │  └─ JSON store → /data      │
       │                                └─────────────────────────────┘
       │  WebRTC P2P (mesh, STUN público)
       ▼
┌──────────────┐
│ Outros peers │  vídeo/áudio fluem DIRETO entre navegadores;
└──────────────┘  o servidor só faz SINALIZAÇÃO e estado da sala.
```

Decisões de projeto (foco na simplicidade):

1. **Um único container** serve API, sockets e arquivos estáticos do cliente.
2. **Sem banco externo**: persistência em `DATA_DIR/rooms.json` (volume Docker).
3. **Estado vivo em memória** (`liveRooms: Map<code, ...>`): participantes, palco,
   chat, layout e gravação. Sobrevive apenas enquanto há alguém conectado; metadados
   da sala (nome, senha, convites, layout) persistem em disco.
4. **Mídia 100% P2P**: o servidor nunca toca em vídeo/áudio — escala com a banda dos clientes.
5. **SPA vanilla** (HTML/CSS/JS sem build step), carregada de `client/`.

Fluxo de uma conexão típica:

```
Convidado abre link → GET /api/rooms/:CODE (mostra nome da sala, pede senha se houver)
→ POST /api/rooms/:CODE/check (valida senha)
→ socket.emit('join', {code, name, password, inviteToken})
→ servidor valida convite/senha/capacidade → entra no socket-room Socket.IO = código da sala
→ broadcastState() envia 'state' a todos (participantes, palco, layout, chat, REC)
→ novos peers no palco trocam webrtc:offer/answer/ice relayados pelo servidor
→ mídia flui P2P.
```

---

## 3. Estrutura do repositório

```
.
├── docker-compose.yml      # serviço único, porta 3000, volume rooms-data:/data
├── Dockerfile              # node:20-alpine, npm install --omit=dev, CMD node server/index.js
├── README.md               # visão rápida / resumo de recursos
├── docs/
│   └── DOCUMENTACAO.md     # este documento
├── server/
│   ├── index.js            # Express + Socket.IO + persistência JSON (~476 linhas)
│   ├── package.json        # deps: express, socket.io, uuid
│   └── test-flow.mjs       # teste ponta-a-ponta do protocolo (com socket.io-client)
└── client/                 # SPA sem build
    ├── index.html          # telas: home, entrada, bastidores, sala de espera, palco
    ├── css/style.css       # tema escuro, layouts do palco
    └── js/app.js           # UI + Socket.IO client + WebRTC mesh + gravação (~742 linhas)
```

---

## 4. Requisitos

| Ambiente | Requisito |
|---|---|
| Produção/local | Docker Engine + Docker Compose v2 |
| Desenvolvimento sem Docker | Node.js ≥ 20 (recursos ESM nativos) |
| Cliente | Chrome, Edge, Firefox ou Safari recentes com WebRTC |
| Recursos específicos | `getDisplayMedia` (tela), `MediaRecorder` + canvas capture (gravação) |

---

## 5. Instalação e execução

### 5.1 Com Docker (recomendado)

```bash
git clone <repo> && cd syncstream
docker compose up -d --build
# abrir http://localhost:3000
```

Para que os **links de convite saiam com o endereço correto**, defina `PUBLIC_HOST`
no `docker-compose.yml` (IP ou domínio acessível pelos convidados):

```yaml
environment:
  - PUBLIC_HOST=192.168.0.42      # rede local
  # - PUBLIC_HOST=studio.exemplo.com   # atrás de proxy HTTPS
```

Comandos úteis:

```bash
docker compose logs -f syncstream    # acompanhar logs
docker compose down                  # parar (dados preservados no volume)
docker volume ls | grep rooms-data   # volume de dados
docker run --rm -v syncstream_rooms-data:/d alpine cat /d/rooms.json  # inspecionar dados
```

### 5.2 Sem Docker (desenvolvimento)

```bash
cd server
npm install
node index.js                # http://localhost:3000
```

### 5.3 Produção com HTTPS (necessário para acesso externo)

Câmera/microfone só funcionam em contexto seguro (`https://` ou `http://localhost`).
Para acesso por IP/rede externa, coloque um reverse proxy TLS na frente. Exemplo Caddy:

```caddyfile
studio.exemplo.com {
    reverse_proxy localhost:3000
}
```

Caddy resolve TLS automaticamente (Let's Encrypt) e faz upgrade de WebSocket sem config extra.
Depois defina `PUBLIC_HOST=studio.exemplo.com` e ajuste os links para `https://`.

---

## 6. Configuração (variáveis de ambiente)

Todas definíveis no `docker-compose.yml` ou como env vars do processo:

| Variável | Padrão | Função |
|---|---|---|
| `PORT` | `3000` | Porta HTTP/WS do servidor. |
| `DATA_DIR` | `/data` (Docker) · `server/data` (local) | Diretório do `rooms.json`. |
| `MAX_ROOMS` | `200` | Máximo de salas **abertas** simultâneas (`POST /api/rooms` retorna 429 acima disso). |
| `PUBLIC_HOST` | auto (1º IPv4 não-interno) | Host usado para montar URLs de convite nos eventos `host:invite*`. |
| `NODE_ENV` | `production` (Docker) | Padrão Node. |

Por sala (definidos na criação via formulário/UI):

| Campo | Padrão | Limite |
|---|---|---|
| `name` | "Sala sem nome" | 80 chars |
| `hostName` | "Apresentador" | 40 chars |
| `password` | sem senha | — |
| `maxGuests` | 10 | 2–50 participantes conectados |
| `waitingRoom` | ativada | — |
| `chatEnabled` | ativado | — |

---

## 7. Guia de uso

### 7.1 Criar um estúdio (host)

1. Acesse a home → **"Novo estúdio"**.
2. Informe seu nome, nome da sala, senha opcional, nº máximo de participantes,
   sala de espera e chat.
3. A página de **bastidores** abre com dois botões de convite:
   - 🔗 **Convidar participante** → gera link de guest (uso único);
   - 🎭 **Convidar co-apresentador** → gera link de bastidores (reutilizável).
4. Copie os links e distribua. O primeiro host entra automaticamente no palco.

### 7.2 Entrar como convidado

1. Abrir o link de convite → digitar nome (e senha, se houver).
2. Autorizar câmera/microfone.
3. Aguardar na **sala de espera**; ao ser admitido, aparece no palco junto dos demais.
4. Controles próprios: mic, câmera, tela, mão levantada, sair do palco, chat.

### 7.3 Operar a transmissão (host)

| Ação | Onde |
|---|---|
| Admitir / recusar da espera | Painel lateral de participantes |
| Subir/descer do palco | Botões por participante |
| Silenciar todos | Barra de controles |
| Trocar layout (grade/palestrante/faixa) | Seletor de layout — sincroniza para todos |
| Gravar | Botão REC — todos veem o indicador; o arquivo `.webm` baixa no navegador do host ao parar |
| Streaming | Campo de chave RTMP (config. da sala) → use OBS com Virtual Camera do host para dar push |
| Remover participante / Encerrar sala | Ações por participante / botão vermelho |

### 7.4 Recuperar acesso de host

O link de bastidores (`.../#/join/CODE?invite=TOKEN&role=host`) fica salvo no
navegador do apresentador em `localStorage` (chave `ss-backstage-<CODE>`) e o token
de host é reutilizável. Se perdido, o token permanece em `/data/rooms.json`
(convites da sala com `role:"host"`). Alternativa: outra pessoa com convite de host
assume o papel; se não houver host online, quem criou a sala pode entrar marcando
"sou apresentador" (`hostFlag`).

---

## 8. API REST

Base: `/api` · Content-Type: `application/json`.

### `POST /api/rooms` — criar sala
Body: `{ name?, hostName?, password?, maxGuests?, waitingRoom?, chatEnabled? }`
Resposta `201/200`:
```json
{
  "code": "K7M2QP",
  "joinUrl": "http://host/#/join/K7M2QP",
  "backstageUrl": "http://host/#/join/K7M2QP?invite=<hostToken>&role=host"
}
```
Erros: `429` limite de salas atingidas.

### `GET /api/rooms/:code` — info pública (tela de entrada)
Resposta: `{ code, name, hostName, hasPassword, participantCount, recording }`
Erro: `404` sala inexistente ou encerrada.

### `POST /api/rooms/:code/check` — validar senha antes de entrar
Body: `{ password }` → `{ ok: true|false }` (sem hash exposto).

### `GET /api/rooms` — lista de salas ativas (home/demo)
Resposta: array de resumos (`roomSummary`):
`{ code, name, hostName, closed, hasPassword, participantCount, recording, maxGuests, waitingRoomEnabled, chatEnabled, streamKeySet }`.

### `GET /api/health`
Resposta: `{ ok: true, uptime }`.

Rotas restantes (`/*`) servem a SPA (fallback para `client/index.html`).

---

## 9. Protocolo Socket.IO

Namespace raiz; cada sala é um **socket-room** identificado pelo `code`
(ex.: `"K7M2QP"`). Buffer de mensagens: `maxHttpBufferSize: 5 MB`.

### 9.1 Cliente → Servidor

| Evento | Payload | Quem | Efeito |
|---|---|---|---|
| `join` | `{code, name, password?, inviteToken?, role?, hostFlag?}` (+ack) | todos | Valida senha/convite/capacidade; entra na sala. Ack: `{ok, you, room}` ou `{error}` |
| `mediaFlags` | `{camOn, micOn}` | qualquer | Atualiza flags exibidas nos outros clientes |
| `hand` | `true\|false` | qualquer | Levanta/baixa a mão + toast |
| `webrtc:offer` / `webrtc:answer` / `webrtc:ice` | `{to, sdp?, candidate?}` | peers do palco | Relay de sinalização para o destino |
| `chat:send` | `text` (≤500 chars) | qualquer | Broadcast `chat:new`; histórico ≤500 msgs |
| `guest:leaveStage` | — | guest | Sai do palco voluntariamente |
| `host:inviteGuest` | (+ack → URL) | host | Cria convite guest e devolve link |
| `host:inviteBackstage` | (+ack → URL) | host | Cria convite bastidores e devolve link |
| `host:setLayout` | `'grid'\|'speaker'\|'strip'` | host | Muda layout para todos |
| `host:muteAll` | — | host | Emite `forceMute` na sala |
| `host:admit` / `host:reject` | `targetSocketId` | host | Admite (vai ao palco) ou recusa na espera |
| `host:inviteToStage` / `host:removeFromStage` | `targetSocketId` | host | Sobe/desce participante |
| `host:removeGuest` | `targetSocketId` | host | Expulsa (não-host) da sala |
| `host:startRecording` / `host:stopRecording` | — | host | Sinaliza REC para todos |
| `host:setStreamKey` | `key\|null` | host | Salva/remove chave RTMP na sala |
| `host:getRoomInfo` | (+ack) | host | Resumo persistente da sala |

Ações `host:*` são ignoradas silenciosamente se o remetente não for host
(`hostOnly()` no servidor).

### 9.2 Servidor → Cliente

| Evento | Payload | Quando |
|---|---|---|
| `state` | `{participants[], stage[], layout, recording, chat[]}` | Qualquer mudança de sala (broadcast completo — idempotente) |
| `toast` | `string` | Entradas/saídas/mãos/avisos |
| `admitted` / `rejected` | — | Resposta da sala de espera ao alvo |
| `youOnStage` | `bool` | Subiram/desceram o destinatário |
| `kicked` | — | Host removeu o destinatário |
| `roomClosed` | — | Sala encerrada (todos devem sair) |
| `recordingStart` / `recordingStop` | — | Indicador REC |
| `forceMute` | — | Silenciar todos |
| `chat:new` | `{from, role, text, ts}` | Nova mensagem |
| `webrtc:offer/answer/ice` | `{from, sdp?, candidate?}` | Sinalização encaminhada |

Formato de `participants[]` (`publicParticipant`):
```json
{ "id": "<socketId>", "name": "Ana", "role": "guest", "avatarColor": "hsl(210,65%,55%)",
  "onStage": true, "inWaitingRoom": false, "camOn": true, "micOn": true, "handRaised": false }
```

---

## 10. Modelo de dados

### Persistido — `DATA_DIR/rooms.json`

```json
{
  "rooms": {
    "K7M2QP": {
      "code": "K7M2QP",
      "name": "Podcast das 18h",
      "hostName": "Bruno",
      "passwordHash": 123456789,
      "maxGuests": 10,
      "waitingRoomEnabled": true,
      "chatEnabled": true,
      "streamKey": null,
      "layout": "grid",
      "stage": ["<socketId-1>"],
      "invites": [
        { "token": "<uuid>", "name": "Bruno", "role": "host",  "status": "accepted", "createdAt": 0 },
        { "token": "<uuid>", "name": "",      "role": "guest", "status": "pending",  "createdAt": 0 }
      ],
      "createdAt": 1727148000000,
      "closed": false
    }
  }
}
```

Notas:
- `passwordHash` é inteiro (hash djb2 customizado) — `null` sem senha. Ver §12.
- `stage`/`layout` são regravados a cada broadcast (snapshot p/ restart);
  ao carregar o banco, `stage` é zerado (sockets antigos não sobrevivem).
- Escrita debounced (500 ms) para não martelar o disco.
- Convite `guest`: `pending → accepted` (uso único). Convite `host`: sempre reutilizável.

### Em memória — `liveRooms: Map<code, {...}>`

```ts
{
  participants: Map<socketId, {id,name,role,avatarColor,onStage,inWaitingRoom,camOn,micOn,handRaised}>,
  stage: Set<socketId>,
  layout: 'grid'|'speaker'|'strip',
  recording: { active: boolean, startedAt: number },
  chat: Array<{from,role,text,ts}>,   // capped 500
  mutedHosts: Set<socketId>
}
```

Criada sob demanda no primeiro `join`; destruída quando o último participante sai.

---

## 11. WebRTC e mídia

Implementação: `client/js/app.js` (funções de mesh + gravação).

- **Configuração**: `RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }`
  — STUN público gratuito; **sem TURN** (ver limitações).
- **Topologia**: malha (mesh) entre participantes **no palco** — cada par cria um
  `RTCPeerConnection`; quem chega por último inicia a oferta (`perfect negotiation` simplificado).
- **Tela**: `getDisplayMedia` substitui a trilha de vídeo no mesmo `RTCRtpSender`
  (`replaceTrack`) — sem renegociação.
- **Mute**: `track.enabled = false` (não corta captura; sinalização visual via `mediaFlags`).
- **Gravação (host)**: `canvas.captureStream(15)` compondo os `<video>` visíveis +
  `WebAudio` mixando os áudios → `MediaRecorder` VP9/WebM → download ao parar.
  Resolução fixa 1280×720 @15fps.
- **Estimativa de escala do mesh**: banda ~1–1,5 Mbps por upload de peer;
  confortável até ~6 pessoas no palco, possível até ~8 em boas redes.

Para adicionar TURN (redes corporativas/NAT simétrico), edite `RTC_CFG`:

```js
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:sua-borda:3478', username: 'user', credential: 'pass' },
]
```

---

## 12. Segurança

| Aspecto | Implementação atual | Recomendação em produção |
|---|---|---|
| Autenticação de sala | Token UUID por convite + senha opcional | Não vazar links; rotacionar removendo invites do JSON |
| Convites | Guest = uso único (`status`); host = reutilizável | Gerar novo convite se suspeito de vazamento |
| Autorização | `hostOnly()` ignora eventos administrativos de não-hosts | — |
| Senhas | Hash djb2 determinístico (didático, **não criptográfico**) | Trocar por `bcrypt`/`argon2` se expor publicamente |
| Transporte | HTTP/WS puro | **TLS obrigatório** (proxy reverso) fora de localhost |
| Validação de payload | Slices de tamanho (nome 40, msg 500, key 120), checagem de capacidade | Rate limiting no proxy |
| XSS | Renderização via `textContent` no chat/participantes | Manter ao evoluir a UI |
| DoS de salas | `MAX_ROOMS` limita salas abertas | Autenticar criação de sala se público |
| Dados | Volume local; chat/participantes voláteis | Backup de `/data` |

---

## 13. Escalabilidade

- **Vertical (padrão)**: um container atende `MAX_ROOMS` salas independentes;
  o gargalo típico é CPU de signaling (baixa) e banda dos clientes (P2P).
- **Horizontal**: réplicas atrás de load balancer com **sticky sessions** por sala,
  ou plugue o Redis adapter do Socket.IO (instrução comentada no topo de `server/index.js`):
  ```bash
  npm i @socket.io/redis-adapter socket.io-client
  ```
  Como o design já é particionado por `code` de sala, também funciona rotear
  convidados ao shard certo no proxy.
- **SFU (futuro)**: trocar mesh por LiveKit/Mediasoup se passar de ~8 no palco
  ou precisar de gravação server-side.

---

## 14. Testes

### Fluxo completo ponta-a-ponta

```bash
cd server
npm install
npm i --no-save socket.io-client
node index.js &          # sobe o servidor
node test-flow.mjs       # executa o cenário
```

Cobertura de `test-flow.mjs`: criação de sala, senha correta/incorreta, geração de
convites, entrada de guest na espera, admissão ao palco, chat, mão levantada,
início/fim de gravação, troca de layout, bastidores (segundo host), expulsão,
roteamento de sinalização WebRTC e encerramento de sala.

### Smoke manual com Docker

```bash
docker build -t syncstream .
docker run -d -p 3000:3000 -v syncstream-test:/data --name st syncstream
curl -s localhost:3000/api/health          # {"ok":true,...}
curl -s -X POST localhost:3000/api/rooms -H 'content-type: application/json' \
     -d '{"name":"teste","hostName":"QA"}' # code + joinUrl + backstageUrl
docker rm -f st
```

---

## 15. Troubleshooting

| Sintoma | Causa provável | Solução |
|---|---|---|
| Câmera/mic não ligam fora de localhost | Contexto inseguro (sem HTTPS) | Reverse proxy TLS (§5.3) ou flag do navegador p/ IP local |
| Vídeo não conecta entre duas redes | NAT simétrico/firewall corporativo | Adicionar TURN em `RTC_CFG` (§11) |
| Links de convite com IP errado | `PUBLIC_HOST` ausente | Definir env var (§5.1) e reiniciar container |
| "Convite já utilizado" | Link de guest aberto 2× | Gerar novo convite nos bastidores |
| "Já existe um apresentador na sala" | Outro host online sem convite | Usar link de bastidores ou aguardar sair |
| Sala some após restart | Estado vivo era em memória | Normal — metadados/convites persistem; reconecte |
| Porta 3000 ocupada | Outro serviço | Ajustar `PORT` no compose |
| Gravação sem áudio | Navegador sem `MediaRecorder` compatível | Testar Chrome/Edge; verificar permissões |
| Muitos peers travam | Mesh > capacidade | Manter ≤6 no palco; plateia assistindo não pesa na malha |

Logs: `docker compose logs -f syncstream`.

---

## 16. Limitações conhecidas (decisões de simplicidade)

1. **Mesh P2P**: ideal até ~6 pessoas no palco (cada conexão consome banda/CPU do cliente).
2. **Gravação client-side** (composição no navegador do host) — sem SFU/server-side;
   se o host cair, a gravação termina.
3. **Hash de senha djb2** (não bcrypt): adequado para uso interno/demo.
4. **Sem TURN embutido**: conexões diretas podem falhar em redes estritas.
5. **Chat/volátil**: histórico vive em memória; apenas metadados persistem em JSON.
6. **Streaming RTMP** depende de encoder externo (OBS) lendo o mix do host.
7. **Sem rate limiting/auth de criação de salas**: proteja no proxy se expor publicamente.

---

*Documento gerado em 24/09/2026, referente ao código da branch atual
(`server/index.js` v1.0.0, 476 linhas; `client/js/app.js`, 742 linhas).*
