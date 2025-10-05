// server.js
const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Static
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'endereco.html')));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

// Sockets
io.on('connection', (socket) => {
  console.log('✅ socket conectado:', socket.id);

  // Cliente confirmou endereço
  socket.on('obterCoordenadas', async (payload) => {
    try {
      const coords = payload?.coordenadas;
      if (!coords || typeof coords.lat !== 'number' || typeof coords.lon !== 'number') {
        return socket.emit('dadosEntrega', { erro: 'Coordenadas inválidas' });
      }
      // Se quiser calcular tempo aqui, insira seu cálculo real.
      const tempoEstimado = null; // cálculo opcional no servidor
      socket.emit('dadosEntrega', { tempoEstimado, coordenadas: coords });
      console.log('📤 dadosEntrega enviado ao cliente');
    } catch (e) {
      console.error('Erro obterCoordenadas:', e);
      socket.emit('dadosEntrega', { erro: 'Falha ao processar endereço' });
    }
  });

  // Motorista enviou posição -> broadcast para todos os clientes
  socket.on('localizacaoMotorista', (data) => {
    if (!data || typeof data.lat !== 'number' || typeof data.lon !== 'number') return;
    console.log('🚚 posição motorista recebida:', data);
    io.emit('atualizacaoLocalizacao', data);
  });

  socket.on('disconnect', () => {
    console.log('🔌 socket desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}`));
