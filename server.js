require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Client } = require('pg');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Разрешаем CORS с вашего фронтенда
const allowedOrigins = [
  'https://poga83.github.io',
  'http://localhost:3000'
];
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Подключение к PostgreSQL через DATABASE_URL
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

async function initDatabase() {
  await client.connect();
  console.log('✅ Connected to Postgres');
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      socket_id TEXT UNIQUE,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'walking',
      position POINT,
      last_seen TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS trips (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      start_date DATE,
      end_date DATE,
      gathering_point POINT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      trip_id INT REFERENCES trips(id),
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tracks (
      id SERIAL PRIMARY KEY,
      trip_id INT REFERENCES trips(id),
      user_name TEXT,
      track_name TEXT,
      track_data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Tables are ready');
}

// Health check
app.get('/health', async (req, res) => {
  try {
    await client.query('SELECT 1');
    res.json({ status:'ok', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status:'error', error: err.message });
  }
});

// Trips API
app.post('/api/trips', async (req, res) => {
  try {
    const { name, startDate, endDate, gatheringPoint } = req.body;
    const { rows } = await client.query(
      'INSERT INTO trips(name,start_date,end_date,gathering_point) VALUES($1,$2,$3,POINT($4,$5)) RETURNING *',
      [name, startDate, endDate, gatheringPoint.lng, gatheringPoint.lat]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/trips', async (req, res) => {
  try {
    const { rows } = await client.query('SELECT * FROM trips ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Socket.IO
const io = new Server(server, {
  cors: { origin: allowedOrigins, methods:['GET','POST'] },
  transports: ['websocket','polling']
});
const activeUsers = new Map();

io.on('connection', socket => {
  socket.emit('connectionConfirmed', { socketId: socket.id });

  socket.on('userConnected', async ({ name, status }) => {
    await client.query(
      'INSERT INTO users(socket_id,name,status) VALUES($1,$2,$3) ' +
      'ON CONFLICT(socket_id) DO UPDATE SET name=$2,status=$3,last_seen=NOW()',
      [socket.id, name, status]
    );
    activeUsers.set(socket.id, { socketId: socket.id, name, status });
    io.emit('users', Array.from(activeUsers.values()));
  });

  socket.on('updatePosition', async ({ lat, lng }) => {
    if (!activeUsers.has(socket.id)) return;
    activeUsers.get(socket.id).position = { lat, lng };
    await client.query(
      'UPDATE users SET position=POINT($1,$2), last_seen=NOW() WHERE socket_id=$3',
      [lng, lat, socket.id]
    );
    socket.broadcast.emit('userPositionChanged', { userId: socket.id, position: { lat, lng } });
  });

  socket.on('groupMessage', async ({ tripId, content }) => {
    const user = activeUsers.get(socket.id);
    if (!user || !content) return;
    await client.query(
      'INSERT INTO messages(trip_id,sender_name,content) VALUES($1,$2,$3)',
      [tripId, user.name, content]
    );
    io.emit('groupMessage', { senderName: user.name, content, timestamp: Date.now() });
  });

  socket.on('saveTrack', async ({ tripId, name, data }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;
    await client.query(
      'INSERT INTO tracks(trip_id,user_name,track_name,track_data) VALUES($1,$2,$3,$4)',
      [tripId, user.name, name, JSON.stringify(data)]
    );
    socket.emit('trackSaved', { success: true });
  });

  socket.on('disconnect', async () => {
    activeUsers.delete(socket.id);
    await client.query('UPDATE users SET last_seen=NOW() WHERE socket_id=$1', [socket.id]);
    io.emit('userDisconnected', socket.id);
  });
});

initDatabase()
  .then(() => server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server listening on port ${PORT}`)))
  .catch(err => { console.error('Fatal error:', err); process.exit(1); });
