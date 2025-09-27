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

// Forçar IPv4
const httpsAgent = new https.Agent({ family: 4 });

// Configuração global axios
const axiosConfig = {
  httpsAgent,
  timeout: 10000,
  headers: {
    'User-Agent': 'MinhaApp/1.0 (contato@seudominio.com)' // Troque para o seu email real/domínio
  }
};

//
// Função Nominatim
//
async function geocodeNominatim(endereco) {
  const enderecoFull = `${endereco}, RS, Brasil`; // aumenta precisão
  const maxAttempts = 3;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`🔍 [Nominatim] Tentando buscar: "${enderecoFull}" (tentativa ${attempt})`);
      const response = await axios.get(NOMINATIM_URL, {
        ...axiosConfig,
        params: {
          q: enderecoFull,
          format: 'json',
          limit: 1
        }
      });

      console.log(`📡 [Nominatim] Resposta:`, response.data);

      if (!response.data || response.data.length === 0) {
        throw new Error('Nenhum resultado retornado');
      }

      return {
        lat: parseFloat(response.data[0].lat),
        lon: parseFloat(response.data[0].lon)
      };

    } catch (error) {
      console.error(`❌ [Nominatim] Erro na tentativa ${attempt}:`, error.message);
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 500 * attempt));
      } else {
        throw error;
      }
    }
  }
}

//
// Função ORS Geocoding (fallback)
//
async function geocodeOpenRouteService(endereco) {
  const enderecoFull = `${endereco}, RS, Brasil`; 

  try {
    console.log(`🔍 [ORS] Tentando buscar: "${enderecoFull}"`);

    const response = await axios.get(OPENROUTESERVICE_GEOCODE_URL, {
      ...axiosConfig,
      params: {
        text: enderecoFull,
        size: 1,
        api_key: OPENROUTESERVICE_API_KEY // além do header, garante nos params
      },
      headers: {
        'Authorization': OPENROUTESERVICE_API_KEY,
        'Accept': 'application/json'
      }
    });

    console.log(`📡 [ORS] Resposta:`, JSON.stringify(response.data, null, 2));

    if (!response.data.features || response.data.features.length === 0) {
      throw new Error('Nenhum resultado retornado');
    }

    const [lon, lat] = response.data.features[0].geometry.coordinates;
    return { lat, lon };

  } catch (error) {
    console.error('❌ [ORS] Erro ao geocodificar:', error.response?.data || error.message);
    throw error;
  }
}

//
// Servir frontend
//
app.use(express.static('public'));

//
// Socket.io
//
io.on('connection', (socket) => {
  console.log('➡️ Novo cliente conectado');

  socket.on('localizacaoMotorista', (dadosMotorista) => {
    console.log('📍 Localização motorista recebida:', dadosMotorista);
    coordenadasMotorista = dadosMotorista;

    socket.broadcast.emit('atualizacaoLocalizacao', coordenadasMotorista);
  });

  socket.on('obterCoordenadas', async (endereco) => {
    console.log(`📨 Pedido de coordenadas para "${endereco}"`);

    try {
      if (!coordenadasMotorista) {
        console.warn("⚠️ Sem motorista disponível no momento");
        socket.emit('dadosEntrega', { erro: 'Localização do motorista não disponível' });
        return;
      }

      // Passo 1: geocode
      let coordenadasDestino;
      try {
        coordenadasDestino = await geocodeNominatim(endereco);
      } catch (nominatimError) {
        console.warn('⚠️ Falha Nominatim, tentando ORS...');
        try {
          coordenadasDestino = await geocodeOpenRouteService(endereco);
        } catch (orsError) {
          socket.emit('dadosEntrega', { erro: 'Erro ao obter coordenadas. Confira o endereço.' });
          return;
        }
      }

      console.log("✅ Coordenadas destino:", coordenadasDestino);

      // Passo 2: rota (ORS)
      const body = {
        coordinates: [
          [coordenadasMotorista.lon, coordenadasMotorista.lat],
          [coordenadasDestino.lon, coordenadasDestino.lat]
        ]
      };

      console.log("📦 Enviando rota ORS:", JSON.stringify(body));

      const rotaResponse = await axios.post(OPENROUTESERVICE_URL, body, {
        headers: {
          'Authorization': OPENROUTESERVICE_API_KEY,
          'Content-Type': 'application/json'
        },
        httpsAgent,
        timeout: 10000
      });

      console.log("📡 Resposta rota ORS:", JSON.stringify(rotaResponse.data, null, 2));

      const duracaoMinutos = Math.ceil(rotaResponse.data.routes[0].summary.duration / 60);

      socket.emit('dadosEntrega', {
        tempoEstimado: duracaoMinutos,
        coordenadas: coordenadasDestino
      });

    } catch (error) {
      console.error('❌ Erro geral processamento rota:', error);
      socket.emit('dadosEntrega', { erro: 'Erro ao calcular rota.' });
    }
  });
});

//
// Start
//
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
