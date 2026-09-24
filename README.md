# ▶ SyncStream

Alternativa **self-hosted e dockerizada** ao StreamYard: estúdios de vídeo ao vivo
no navegador, com muitas salas simultâneas em paralelo. **Zero instalação no cliente —
basta um navegador moderno (Chrome/Edge/Firefox/Safari).**

## Recursos (paridade com o essencial do StreamYard)

| Recurso | Como funciona |
|---|---|
| 🎬 Estúdio multi-pessoa | WebRTC mesh entre participantes "no palco" (vídeo+áudio P2P) |
| 🔗 Convites por link | Host gera link único de convidado (`🔗`) ou de co-apresentador/bastidores (`🎭`, reutilizável) |
| 🔒 Senha opcional da sala | Verificada antes da entrada |
| 🚪 Sala de espera | Convidados aguardam admissão do host; ao admitir, vão direto ao palco |
| 🎤 Palco / plateia | Host sobe/desce convidados do palco; guest pode sair sozinho |
| ✋ Levantar a mão | Notificação para todos |
| 🖥️ Compartilhar tela | `getDisplayMedia` transmitido aos demais |
| 🎙️/📷 Mic & câmera | Ligar/desligar + "silenciar todos" pelo host |
| 💬 Chat | Em tempo real, persistente durante a sessão |
| 🧩 Layouts | Grade / Palestrante / Faixa, sincronizado para todos |
| ⏺️ Gravação | Sinaliza REC para todos; host grava composição (canvas+WebAudio) e baixa `.webm` |
| 📡 Streaming | Chave RTMP salva na sala (para uso com OBS Virtual Camera / encoder externo) |
| 👥 Lista de salas ativas | Descoberta pública na home |
| 🚪 Encerrar sala | Derruba todos os participantes |
| ♻️ Reconexão | Link de bastidores fica salvo no navegador do apresentador |

## Arquitetura (simples de propósito)

```
[ Navegadores ] --HTTP/SPA--> [ Node.js + Express ]        API REST + arquivos estáticos
                --WebSocket--> [ Socket.IO ]               estado da sala, chat, sinalização WebRTC
                --WebRTC P2P-> [ malha entre participantes ] vídeo/áudio (STUN público)
Persistência: JSON em volume Docker (/data/rooms.json)
Escala: cada container atende N salas; para múltiplas réplicas use um
load balancer com sticky sessions ou @socket.io/redis-adapter (ver comentário em server/index.js).
```

## Rodando com Docker

```bash
docker compose up -d --build
# abra http://localhost:3000
```

Para que os **links de convite** saiam com o endereço certo, defina `PUBLIC_HOST`
no `docker-compose.yml` (IP ou domínio acessível pelos convidados):

```yaml
environment:
  - PUBLIC_HOST=192.168.0.42   # ou stream.seudominio.com (atrás de um proxy HTTPS)
```

> ⚠️ Câmera/microfone exigem contexto seguro: use `http://localhost` (ok),
> IP local só com flag do navegador, ou coloque um reverse proxy HTTPS
> (Caddy/Nginx/Traefik) na frente para acesso externo.

## Rodando sem Docker (desenvolvimento)

```bash
cd server && npm install && node index.js   # http://localhost:3000
```

## Teste automatizado de fluxo completo

```bash
cd server
npm i --no-save socket.io-client
node test-flow.mjs
```

Cobre: criação de sala, senha, convites, sala de espera, palco, chat,
mão levantada, gravação, layout, bastidores, expulsão, roteamento WebRTC
e encerramento de sala.

## Estrutura

```
├── docker-compose.yml
├── Dockerfile
├── server/
│   ├── index.js         # Express + Socket.IO + persistência JSON (~450 linhas)
│   └── test-flow.mjs    # teste ponta-a-ponta do protocolo
└── client/              # SPA vanilla (HTML/CSS/JS, sem build)
    ├── index.html
    ├── css/style.css
    └── js/app.js        # telas, WebRTC mesh, UI do estúdio
```

## Limitações conhecidas (decisões de simplicidade)

- Mesh P2P: ideal até ~6 pessoas no palco (cada conexão consome banda/c CPU).
- Gravação é feita no navegador do host (composição canvas) — não há SFU/server-side.
- Hash de senha simples (não bcrypt): adequado para uso interno/demo.
- Sem TURN: redes corporativas estritas podem falhar na conexão direta (adicione um servidor TURN em `RTC_CFG`).
