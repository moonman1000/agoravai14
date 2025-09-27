const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// URLs e chaves
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OPENROUTESERVICE_URL = 'https://api.openrouteservice.org/v2/directions/driving-car';
const OPENROUTESERVICE_GEOCODE_URL = 'https://api.openrouteservice.org/geocode/search';
const OPENROUTESERVICE_API_KEY = '5b3ce3597851110001cf6248461ce4f521b24420bbc67527fa68a8ab';

let coordenadasMotorista = null;

// Forçar uso de IPv4 para evitar ENETUNREACH
const httpsAgent = new https.Agent({ family: 4 });

// Configuração do axios com timeout e agent
const axiosConfig = {
  httpsAgent,
  timeout: 10000, // 10 segundos
  headers: {
    'User-Agent': 'MinhaApp/1.0 (contato@seudominio.com)'
  }
};

// Função para geocodificar com Nominatim (com retry)
async function geocodeNominatim(endereco) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.get(NOMINATIM_URL, {
        ...axiosConfig,
        params: {
          q: endereco,
          format: 'json',
          limit: 1
        }
      });

      if (response.data.length === 0) {
        throw new Error('Endereço não encontrado');
      }

      return {
        lat: parseFloat(response.data[0].lat),
        lon: parseFloat(response.data[0].lon)
      };
    } catch (error) {
      console.error(`Tentativa ${attempt} - Erro ao geocodificar com Nominatim:`, error.message);
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 500 * attempt)); // Espera antes de tentar novamente
      } else {
        throw error; // Rejeita o erro após todas as tentativas
      }
    }
  }
}

// Função para geocodificar com OpenRouteService (fallback)
async function geocodeOpenRouteService(endereco) {
  try {
    const response = await axios.get(OPENROUTESERVICE_GEOCODE_URL, {
      ...axiosConfig,
      params: {
        text: endereco,
        size: 1
      },
      headers: {
        'Authorization': OPENROUTESERVICE_API_KEY
      }
    });

    if (response.data.features.length === 0) {
      throw new Error('Endereço não encontrado');
    }

    const [lon, lat] = response.data.features[0].geometry.coordinates;
    return { lat, lon };
  } catch (error) {
    console.error('Erro ao geocodificar com OpenRouteService:', error.message);
    throw error;
  }
}

// Rota para servir arquivos estáticos
app.use(express.static('public'));

// Conectar ao Socket.io
io.on('connection', (socket) => {
  console.log('Novo cliente conectado');

  // Receber a localização do motorista
  socket.on('localizacaoMotorista', (dadosMotorista) => {
    console.log('Localização do motorista recebida:', dadosMotorista);
    coordenadasMotorista = dadosMotorista;

    // Emitir a localização atual do motorista para todos os clientes conectados
    socket.broadcast.emit('atualizacaoLocalizacao', coordenadasMotorista);
  });

  // Ouvir o evento de obterCoordenadas do cliente
  socket.on('obterCoordenadas', async (endereco) => {
    try {
      if (!coordenadasMotorista) {
        socket.emit('dadosEntrega', { erro: 'Localização do motorista não disponível no momento' });
        return;
      }

      // Passo 1: Obter as coordenadas do endereço com fallback
      let coordenadasDestino;
      try {
        coordenadasDestino = await geocodeNominatim(endereco);
      } catch (nominatimError) {
        console.warn('Falha ao geocodificar com Nominatim, tentando OpenRouteService...');
        try {
          coordenadasDestino = await geocodeOpenRouteService(endereco);
        } catch (orsError) {
          socket.emit('dadosEntrega', { erro: 'Erro ao obter coordenadas do endereço. Tente novamente mais tarde.' });
          return;
        }
      }

      // Passo 2: Calcular a rota entre o motorista e o destino usando OpenRouteService
      const rotaResponse = await axios.post(OPENROUTESERVICE_URL, {
        coordinates: [
          [coordenadasMotorista.lon, coordenadasMotorista.lat],
          [coordenadasDestino.lon, coordenadasDestino.lat]
        ]
      }, {
        headers: {
          'Authorization': OPENROUTESERVICE_API_KEY,
          'Content-Type': 'application/json'
        },
        httpsAgent,
        timeout: 10000
      });

      const duracaoMinutos = Math.ceil(rotaResponse.data.routes[0].summary.duration / 60);

      // Passo 3: Enviar as coordenadas e o tempo estimado para o cliente
      socket.emit('dadosEntrega', {
        tempoEstimado: duracaoMinutos,
        coordenadas: coordenadasDestino
      });
    } catch (error) {
      console.error('Erro ao calcular rota:', error);
      socket.emit('dadosEntrega', { erro: 'Erro ao calcular rota. Tente novamente mais tarde.' });
    }
  });
});

// Iniciar o servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
