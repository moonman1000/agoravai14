/* eslint-disable no-console */
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const { LRUCache } = require('lru-cache'); // Atualizado para lru-cache v10+
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || '*';
const ORS_API_KEY = process.env.ORS_API_KEY || '';
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || 'contact@example.com';

// Segurança e performance
app.use(
  helmet({
    contentSecurityPolicy: false // Facilita dev com WebSocket; ajuste CSP depois se necessário
  })
);
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// CORS
if (ALLOWED_ORIGIN && ALLOWED_ORIGIN !== '*') {
  app.use(
    cors({
      origin: ALLOWED_ORIGIN,
      methods: ['GET', 'POST'],
      credentials: false
    })
  );
} else {
  app.use(cors());
}

// Socket.IO
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGIN === '*' ? '*' : ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: false
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000
});

// Pastas estáticas
const staticDir = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : __dirname;

app.use(
  express.static(staticDir, {
    maxAge: '1h',
    index: false
  })
);

// Mapas em memória
const latestLocationByOrderId = new Map(); // orderId -> { lat, lng, speed, heading, ts }
const routeCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 15 }); // 15 min
const geocodeCache = new LRUCache({ max: 1000, ttl: 1000 * 60 * 60 * 24 }); // 24 h

// Utils
function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}
function validLat(lat) {
  return isFiniteNumber(lat) && lat >= -90 && lat <= 90;
}
function validLng(lng) {
  return isFiniteNumber(lng) && lng >= -180 && lng <= 180;
}
function parseLatLngParam(val) {
  // Aceita "lat,lng" ou "lng,lat" detectando limites
  // Preferência: "lat,lng"
  if (!val || typeof val !== 'string') return null;
  const [a, b] = val.split(',').map((s) => parseFloat(s.trim()));
  if (!isFiniteNumber(a) || !isFiniteNumber(b)) return null;

  if (validLat(a) && validLng(b)) return { lat: a, lng: b };
  if (validLng(a) && validLat(b)) return { lat: b, lng: a };
  return null;
}
function normalizeOrderId(id) {
  if (id === undefined || id === null) return '';
  return String(id).trim();
}

// Rotas (ORS com fallback OSRM)
async function getRouteORS(start, end, profile = 'driving-car') {
  if (!ORS_API_KEY) throw new Error('ORS_API_KEY ausente');
  const url = `https://api.openrouteservice.org/v2/directions/${encodeURIComponent(
    profile
  )}/geojson?api_key=${encodeURIComponent(ORS_API_KEY)}`;
  const body = {
    coordinates: [
      [start.lng, start.lat],
      [end.lng, end.lat]
    ]
  };
  const { data } = await axios.post(url, body, { timeout: 12000 });
  const feat = data && data.features && data.features[0];
  if (!feat) throw new Error('Resposta ORS inválida');
  const coords = (feat.geometry && feat.geometry.coordinates) || [];
  const summary = feat.properties && feat.properties.summary;
  const distance = summary?.distance || 0;
  const duration = summary?.duration || 0;
  // GeoJSON coords vêm como [lng, lat]; converter para [lat, lng]
  const latlngs = coords.map(([lng, lat]) => [lat, lng]);
  return { coordinates: latlngs, distance, duration, source: 'ors' };
}

async function getRouteOSRM(start, end, profile = 'driving') {
  const url = `https://router.project-osrm.org/route/v1/${encodeURIComponent(
    profile
  )}/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson&steps=false`;
  const { data } = await axios.get(url, { timeout: 12000 });
  if (!data || !data.routes || !data.routes[0]) throw new Error('Resposta OSRM inválida');
  const route = data.routes[0];
  const coords = route.geometry?.coordinates || [];
  const distance = route.distance || 0;
  const duration = route.duration || 0;
  const latlngs = coords.map(([lng, lat]) => [lat, lng]);
  return { coordinates: latlngs, distance, duration, source: 'osrm' };
}

async function computeRoute(start, end, profile = 'driving-car') {
  const key = `${profile}|${start.lat.toFixed(6)},${start.lng.toFixed(
    6
  )}|${end.lat.toFixed(6)},${end.lng.toFixed(6)}`;
  const cached = routeCache.get(key);
  if (cached) return cached;

  try {
    const res = await getRouteORS(start, end, profile);
    routeCache.set(key, res);
    return res;
  } catch (e) {
    console.warn('ORS falhou, tentando OSRM:', e?.message || e);
    const res = await getRouteOSRM(start, end, 'driving');
    routeCache.set(key, res);
    return res;
  }
}

// Geocoding (proxy leve para Nominatim, com cache)
async function geocodeQuery(query, limit = 5) {
  const q = String(query || '').trim();
  if (!q) return [];
  const key = `${q}|${limit}`;
  const cached = geocodeCache.get(key);
  if (cached) return cached;

  const url = 'https://nominatim.openstreetmap.org/search';
  const { data } = await axios.get(url, {
    params: { format: 'json', addressdetails: 1, limit, q },
    headers: {
      'User-Agent': `RealtimeTracking/1.0 (${NOMINATIM_EMAIL})`
    },
    timeout: 12000
  });
  const results = (data || []).map((it) => ({
    display_name: it.display_name,
    lat: parseFloat(it.lat),
    lng: parseFloat(it.lon)
  }));
  geocodeCache.set(key, results);
  return results;
}

// Socket handlers
io.on('connection', (socket) => {
  let joinedOrderId = '';

  socket.on('join_room', (payload = {}) => {
    const orderId = normalizeOrderId(payload.orderId);
    if (!orderId) return socket.emit('error_event', { message: 'orderId inválido' });
    if (joinedOrderId) socket.leave(joinedOrderId);
    joinedOrderId = orderId;
    socket.join(orderId);
    socket.emit('joined_room', { orderId });
  });

  socket.on('driver_location', (payload = {}) => {
    const orderId = normalizeOrderId(payload.orderId);
    const lat = Number(payload.lat);
    const lng = Number(payload.lng);
    const speed = isFiniteNumber(payload.speed) ? Number(payload.speed) : null;
    const heading = isFiniteNumber(payload.heading) ? Number(payload.heading) : null;
    const ts = isFiniteNumber(payload.ts) ? Number(payload.ts) : Date.now();

    if (!orderId || !validLat(lat) || !validLng(lng)) {
      return socket.emit('error_event', { message: 'driver_location inválido' });
    }

    const loc = { orderId, lat, lng, speed, heading, ts };
    latestLocationByOrderId.set(orderId, loc);
    io.to(orderId).emit('driver_location', loc);
  });

  socket.on('request_latest_driver', (payload = {}) => {
    const orderId = normalizeOrderId(payload.orderId);
    if (!orderId) return socket.emit('error_event', { message: 'orderId inválido' });
    const loc = latestLocationByOrderId.get(orderId);
    socket.emit('latest_driver', { orderId, location: loc || null });
  });

  socket.on('disconnect', () => {
    // noop
  });
});

// REST endpoints
app.get('/api/driver/latest/:orderId', (req, res) => {
  const orderId = normalizeOrderId(req.params.orderId);
  if (!orderId) return res.status(400).json({ error: 'orderId inválido' });
  const loc = latestLocationByOrderId.get(orderId) || null;
  res.json({ orderId, location: loc });
});

app.get('/api/route', async (req, res) => {
  try {
    const profile = String(req.query.profile || 'driving-car');
    const startParam = String(req.query.start || '');
    const endParam = String(req.query.end || '');

    const start = parseLatLngParam(startParam);
    const end = parseLatLngParam(endParam);

    if (
      !start ||
      !end ||
      !validLat(start.lat) ||
      !validLng(start.lng) ||
      !validLat(end.lat) ||
      !validLng(end.lng)
    ) {
      return res
        .status(400)
        .json({ error: 'Parâmetros start/end inválidos. Use "lat,lng" ou "lng,lat".' });
    }

    const route = await computeRoute(start, end, profile);
    res.json(route);
  } catch (err) {
    console.error('Erro /api/route:', err?.response?.data || err?.message || err);
    res.status(502).json({ error: 'Falha ao calcular rota' });
  }
});

app.get('/api/geocode', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '5', 10), 1), 10);
    if (!q) return res.json([]);
    const results = await geocodeQuery(q, limit);
    res.json(results);
  } catch (err) {
    console.error('Erro /api/geocode:', err?.message || err);
    res.status(502).json({ error: 'Falha ao geocodificar' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// Entradas HTML (opcional: sirva index/endereco por padrão)
app.get('/', (req, res) => {
  const file = fs.existsSync(path.join(staticDir, 'endereco.html'))
    ? path.join(staticDir, 'endereco.html')
    : path.join(staticDir, 'index.html');
  res.sendFile(file);
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Origem CORS: ${ALLOWED_ORIGIN}`);
});
