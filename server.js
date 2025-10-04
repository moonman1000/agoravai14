const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

// ==================== CONFIGURAÇÕES ====================

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OPENROUTESERVICE_URL = 'https://api.openrouteservice.org/v2/directions/driving-car';
const OPENROUTESERVICE_GEOCODE_URL = 'https://api.openrouteservice.org/geocode/search';
const OPENROUTESERVICE_API_KEY = '5b3ce3597851110001cf6248461ce4f521b24420bbc67527fa68a8ab';

// Localização padrão do restaurante/origem (ajuste conforme necessário)
const LOCALIZACAO_ORIGEM = {
    lat: -30.0346, // Porto Alegre, RS
    lon: -51.2177,
    nome: 'Restaurante'
};

// ==================== ESTADO GLOBAL ====================

let coordenadasMotorista = null;
let ultimaAtualizacaoMotorista = null;
const motoristasConectados = new Map(); // Suporte para múltiplos motoristas
const cacheGeocode = new Map(); // Cache de geocoding
const CACHE_EXPIRACAO = 24 * 60 * 60 * 1000; // 24 horas

// ==================== CONFIGURAÇÃO AXIOS ====================

const httpsAgent = new https.Agent({ 
    family: 4,
    keepAlive: true,
    maxSockets: 50
});

const axiosConfig = {
    httpsAgent,
    timeout: 10000,
    headers: {
        'User-Agent': 'DeliveryTrackingApp/2.0 (contato@seudominio.com)'
    }
};

// ==================== FUNÇÕES AUXILIARES ====================

// Validar coordenadas
function validarCoordenadas(coords) {
    if (!coords || typeof coords.lat !== 'number' || typeof coords.lon !== 'number') {
        return false;
    }
    
    // Validar range válido
    if (coords.lat < -90 || coords.lat > 90 || coords.lon < -180 || coords.lon > 180) {
        return false;
    }
    
    return true;
}

// Calcular distância entre dois pontos (Haversine)
function calcularDistancia(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Raio da Terra em metros
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Retorna em metros
}

// Formatar tempo
function formatarTempo(minutos) {
    const horas = Math.floor(minutos / 60);
    const mins = Math.round(minutos % 60);
    if (horas > 0) {
        return `${horas}h ${mins}min`;
    }
    return `${mins} min`;
}

// ==================== GEOCODING ====================

// Geocoding com Nominatim
async function geocodeNominatim(endereco) {
    const enderecoNormalizado = endereco.trim().toLowerCase();
    
    // Verificar cache
    const cacheKey = `nominatim_${enderecoNormalizado}`;
    const cached = cacheGeocode.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_EXPIRACAO)) {
        console.log(`✅ [Cache] Usando coordenadas em cache para: "${endereco}"`);
        return cached.data;
    }

    const enderecoFull = endereco.includes('Brasil') ? endereco : `${endereco}, Brasil`;
    const maxAttempts = 3;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            console.log(`🔍 [Nominatim] Buscando: "${enderecoFull}" (tentativa ${attempt}/${maxAttempts})`);
            
            const response = await axios.get(NOMINATIM_URL, {
                ...axiosConfig,
                params: {
                    q: enderecoFull,
                    format: 'json',
                    limit: 1,
                    countrycodes: 'br',
                    addressdetails: 1
                }
            });

            if (!response.data || response.data.length === 0) {
                throw new Error('Nenhum resultado encontrado');
            }

            const resultado = {
                lat: parseFloat(response.data[0].lat),
                lon: parseFloat(response.data[0].lon),
                display_name: response.data[0].display_name
            };

            // Salvar no cache
            cacheGeocode.set(cacheKey, {
                data: resultado,
                timestamp: Date.now()
            });

            console.log(`✅ [Nominatim] Encontrado: ${resultado.display_name}`);
            return resultado;

        } catch (error) {
            console.error(`❌ [Nominatim] Erro tentativa ${attempt}:`, error.message);
            
            if (attempt < maxAttempts) {
                const delay = 1000 * attempt; // Backoff exponencial
                console.log(`⏳ Aguardando ${delay}ms antes de tentar novamente...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw new Error(`Falha após ${maxAttempts} tentativas: ${error.message}`);
            }
        }
    }
}

// Geocoding com OpenRouteService (fallback)
async function geocodeOpenRouteService(endereco) {
    const enderecoNormalizado = endereco.trim().toLowerCase();
    
    // Verificar cache
    const cacheKey = `ors_${enderecoNormalizado}`;
    const cached = cacheGeocode.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_EXPIRACAO)) {
        console.log(`✅ [Cache] Usando coordenadas ORS em cache para: "${endereco}"`);
        return cached.data;
    }

    const enderecoFull = endereco.includes('Brasil') ? endereco : `${endereco}, Brasil`;

    try {
        console.log(`🔍 [ORS Geocode] Buscando: "${enderecoFull}"`);

        const response = await axios.get(OPENROUTESERVICE_GEOCODE_URL, {
            ...axiosConfig,
            params: {
                text: enderecoFull,
                size: 1,
                'boundary.country': 'BR'
            },
            headers: {
                'Authorization': OPENROUTESERVICE_API_KEY,
                'Accept': 'application/json',
                'User-Agent': 'DeliveryTrackingApp/2.0'
            }
        });

        if (!response.data.features || response.data.features.length === 0) {
            throw new Error('Nenhum resultado encontrado');
        }

        const [lon, lat] = response.data.features[0].geometry.coordinates;
        const resultado = {
            lat,
            lon,
            display_name: response.data.features[0].properties.label
        };

        // Salvar no cache
        cacheGeocode.set(cacheKey, {
            data: resultado,
            timestamp: Date.now()
        });

        console.log(`✅ [ORS Geocode] Encontrado: ${resultado.display_name}`);
        return resultado;

    } catch (error) {
        console.error('❌ [ORS Geocode] Erro:', error.response?.data || error.message);
        throw new Error(`Falha ORS Geocode: ${error.message}`);
    }
}

// Geocoding unificado com fallback
async function geocodificarEndereco(endereco) {
    try {
        return await geocodeNominatim(endereco);
    } catch (nominatimError) {
        console.warn('⚠️ Nominatim falhou, tentando OpenRouteService...');
        try {
            return await geocodeOpenRouteService(endereco);
        } catch (orsError) {
            throw new Error('Não foi possível encontrar o endereço. Verifique e tente novamente.');
        }
    }
}

// ==================== CÁLCULO DE ROTA ====================

async function calcularRota(origem, destino) {
    if (!validarCoordenadas(origem) || !validarCoordenadas(destino)) {
        throw new Error('Coordenadas inválidas');
    }

    try {
        console.log(`🗺️ [Rota] Calculando de [${origem.lat}, ${origem.lon}] para [${destino.lat}, ${destino.lon}]`);

        const body = {
            coordinates: [
                [origem.lon, origem.lat],
                [destino.lon, destino.lat]
            ],
            preference: 'fastest',
            units: 'km'
        };

        const response = await axios.post(OPENROUTESERVICE_URL, body, {
            headers: {
                'Authorization': OPENROUTESERVICE_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            httpsAgent,
            timeout: 15000
        });

        if (!response.data.routes || response.data.routes.length === 0) {
            throw new Error('Nenhuma rota encontrada');
        }

        const rota = response.data.routes[0];
        const duracaoSegundos = rota.summary.duration;
        const distanciaMetros = rota.summary.distance;

        const resultado = {
            duracaoMinutos: Math.ceil(duracaoSegundos / 60),
            duracaoFormatada: formatarTempo(duracaoSegundos / 60),
            distanciaKm: (distanciaMetros / 1000).toFixed(2),
            geometria: rota.geometry.coordinates.map(coord => [coord[1], coord[0]]) // [lat, lon]
        };

        console.log(`✅ [Rota] Calculada: ${resultado.distanciaKm}km, ${resultado.duracaoFormatada}`);
        return resultado;

    } catch (error) {
        console.error('❌ [Rota] Erro ao calcular:', error.response?.data || error.message);
        throw new Error('Erro ao calcular rota. Tente novamente.');
    }
}

// ==================== MIDDLEWARE ====================

app.use(express.static('public'));
app.use(express.json());

// Logging de requisições
app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.path}`);
    next();
});

// ==================== ROTAS HTTP ====================

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        motoristas: motoristasConectados.size,
        cacheSize: cacheGeocode.size,
        uptime: process.uptime()
    });
});

// Limpar cache (útil para desenvolvimento)
app.post('/api/limpar-cache', (req, res) => {
    cacheGeocode.clear();
    console.log('🗑️ Cache limpo');
    res.json({ success: true, message: 'Cache limpo com sucesso' });
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
    console.log(`➡️ Cliente conectado: ${socket.id}`);

    // ===== MOTORISTA: Enviar localização =====
    socket.on('localizacaoMotorista', (dados) => {
        try {
            // Validar dados
            if (!validarCoordenadas(dados)) {
                console.error('❌ Coordenadas inválidas recebidas do motorista');
                return;
            }

            const dadosCompletos = {
                ...dados,
                socketId: socket.id,
                timestamp: dados.timestamp || Date.now()
            };

            // Atualizar estado global
            coordenadasMotorista = dadosCompletos;
            ultimaAtualizacaoMotorista = Date.now();
            motoristasConectados.set(socket.id, dadosCompletos);

            console.log(`📍 [Motorista ${socket.id}] Posição: [${dados.lat.toFixed(6)}, ${dados.lon.toFixed(6)}] | Precisão: ${dados.accuracy}m`);

            // Broadcast para todos os clientes (exceto o motorista)
            socket.broadcast.emit('atualizacaoLocalizacao', {
                lat: dados.lat,
                lon: dados.lon,
                timestamp: dadosCompletos.timestamp
            });

        } catch (error) {
            console.error('❌ Erro ao processar localização do motorista:', error);
        }
    });

    // ===== CLIENTE: Obter coordenadas e calcular rota =====
    socket.on('obterCoordenadas', async (dados) => {
        try {
            console.log(`📨 [Cliente ${socket.id}] Solicitação de rota`);

            // Verificar se é objeto ou string
            const endereco = typeof dados === 'string' ? dados : dados.endereco;
            let coordenadasDestino = typeof dados === 'object' ? dados.coordenadas : null;

            if (!endereco || endereco.trim().length < 5) {
                socket.emit('dadosEntrega', { 
                    erro: 'Endereço inválido. Digite um endereço completo.' 
                });
                return;
            }

            // Usar localização do motorista ou origem padrão
            const origem = coordenadasMotorista || LOCALIZACAO_ORIGEM;

            if (!coordenadasMotorista) {
                console.warn('⚠️ Usando localização padrão (motorista não disponível)');
            }

            // Geocodificar se não veio coordenadas
            if (!coordenadasDestino || !validarCoordenadas(coordenadasDestino)) {
                console.log(`🔍 Geocodificando: "${endereco}"`);
                coordenadasDestino = await geocodificarEndereco(endereco);
            } else {
                console.log(`✅ Usando coordenadas fornecidas pelo cliente`);
            }

            // Validar distância (opcional: evitar rotas muito longas)
            const distanciaReta = calcularDistancia(
                origem.lat, origem.lon,
                coordenadasDestino.lat, coordenadasDestino.lon
            );

            if (distanciaReta > 100000) { // 100km
                socket.emit('dadosEntrega', { 
                    erro: 'Endereço muito distante. Área de entrega limitada a 100km.' 
                });
                return;
            }

            // Calcular rota
            const rota = await calcularRota(origem, coordenadasDestino);

            // Enviar resposta
            socket.emit('dadosEntrega', {
                tempoEstimado: rota.duracaoMinutos,
                tempoFormatado: rota.duracaoFormatada,
                distancia: rota.distanciaKm,
                coordenadas: {
                    lat: coordenadasDestino.lat,
                    lon: coordenadasDestino.lon
                },
                geometria: rota.geometria,
                enderecoCompleto: coordenadasDestino.display_name
            });

            console.log(`✅ [Cliente ${socket.id}] Rota enviada: ${rota.distanciaKm}km, ${rota.duracaoFormatada}`);

        } catch (error) {
            console.error(`❌ [Cliente ${socket.id}] Erro:`, error.message);
            socket.emit('dadosEntrega', { 
                erro: error.message || 'Erro ao processar solicitação. Tente novamente.' 
            });
        }
    });

    // ===== DESCONEXÃO =====
    socket.on('disconnect', () => {
        console.log(`⬅️ Cliente desconectado: ${socket.id}`);
        
        // Remover motorista se desconectou
        if (motoristasConectados.has(socket.id)) {
            motoristasConectados.delete(socket.id);
            console.log(`🚗 Motorista ${socket.id} removido`);
            
            // Se era o motorista ativo, limpar
            if (coordenadasMotorista?.socketId === socket.id) {
                coordenadasMotorista = null;
                console.log('⚠️ Motorista ativo desconectado');
            }
        }
    });
});

// ==================== LIMPEZA PERIÓDICA ====================

// Limpar cache antigo a cada 6 horas
setInterval(() => {
    const agora = Date.now();
    let removidos = 0;
    
    for (const [key, value] of cacheGeocode.entries()) {
        if (agora - value.timestamp > CACHE_EXPIRACAO) {
            cacheGeocode.delete(key);
            removidos++;
        }
    }
    
    if (removidos > 0) {
        console.log(`🗑️ Cache limpo: ${removidos} entradas removidas`);
    }
}, 6 * 60 * 60 * 1000);

// Verificar motoristas inativos (sem atualização há mais de 5 minutos)
setInterval(() => {
    if (coordenadasMotorista && ultimaAtualizacaoMotorista) {
        const tempoInativo = Date.now() - ultimaAtualizacaoMotorista;
        if (tempoInativo > 5 * 60 * 1000) {
            console.warn('⚠️ Motorista inativo há mais de 5 minutos');
            coordenadasMotorista = null;
        }
    }
}, 60 * 1000);

// ==================== INICIALIZAÇÃO ====================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║   🚀 SERVIDOR DE RASTREAMENTO ATIVO   ║
╠════════════════════════════════════════╣
║  Porta: ${PORT}                        
║  Ambiente: ${process.env.NODE_ENV || 'development'}
║  Cache: Ativo (24h)                    
║  Geocoding: Nominatim + ORS            
║  Rotas: OpenRouteService               
╚════════════════════════════════════════╝
    `);
});

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});
