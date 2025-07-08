const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Client } = require('pg');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Исправленные CORS настройки
const allowedOrigins = [
  'https://poga83.github.io',
  'https://adventure-sync-client.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: false,
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// PostgreSQL с правильной обработкой ошибок
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

async function initDatabase() {
  try {
    await client.connect();
    console.log('✅ PostgreSQL подключен');
    
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
        description TEXT,
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
    console.log('✅ Таблицы БД готовы');
  } catch (error) {
    console.error('❌ Ошибка инициализации БД:', error);
    throw error;
  }
}

// Health check с диагностикой
app.get('/health', async (req, res) => {
  try {
    // Проверка подключения к БД
    await client.query('SELECT 1');
    res.json({
      status: 'ok',
      time: new Date().toISOString(),
      database: 'connected',
      platform: 'railway'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      time: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    });
  }
});

// Главная страница
app.get('/', (req, res) => {
  res.json({
    name: 'Adventure Sync Server',
    version: '2.0.1',
    status: 'running',
    platform: 'Railway'
  });
});

// API для поездок
app.post('/api/trips', async (req, res) => {
  try {
    const { name, description, startDate, endDate, gatheringPoint } = req.body;
    const { rows } = await client.query(
      'INSERT INTO trips(name,description,start_date,end_date,gathering_point) VALUES($1,$2,$3,$4,POINT($5,$6)) RETURNING *',
      [name, description, startDate, endDate, gatheringPoint.lng, gatheringPoint.lat]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('Ошибка создания поездки:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trips', async (req, res) => {
  try {
    const { rows } = await client.query('SELECT * FROM trips ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) {
    console.error('Ошибка получения поездок:', e);
    res.status(500).json({ error: e.message });
  }
});

// Socket.IO с исправленными CORS настройками
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: false
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

const activeUsers = new Map();

io.on('connection', (socket) => {
  console.log(`👤 Новое подключение: ${socket.id}`);
  
  socket.emit('connectionConfirmed', { socketId: socket.id });

  socket.on('userConnected', async (data) => {
    try {
      await client.query(
        'INSERT INTO users(socket_id,name,status) VALUES($1,$2,$3) ON CONFLICT(socket_id) DO UPDATE SET name=$2,status=$3,last_seen=NOW()',
        [socket.id, data.name, data.status]
      );
      activeUsers.set(socket.id, { ...data, socketId: socket.id });
      const list = Array.from(activeUsers.values());
      io.emit('users', list);
    } catch (error) {
      console.error('Ошибка подключения пользователя:', error);
    }
  });

  socket.on('updatePosition', async (pos) => {
    try {
      const user = activeUsers.get(socket.id);
      if (user) {
        user.position = pos;
        await client.query(
          'UPDATE users SET position=POINT($1,$2),last_seen=NOW() WHERE socket_id=$3',
          [pos.lng, pos.lat, socket.id]
        );
        socket.broadcast.emit('userPositionChanged', { userId: socket.id, position: pos });
      }
    } catch (error) {
      console.error('Ошибка обновления позиции:', error);
    }
  });

  socket.on('groupMessage', async (msg) => {
    try {
      const user = activeUsers.get(socket.id);
      if (user && msg.content) {
        await client.query(
          'INSERT INTO messages(trip_id,sender_name,content) VALUES($1,$2,$3)',
          [msg.tripId, user.name, msg.content]
        );
        io.emit('groupMessage', {
          senderName: user.name,
          content: msg.content,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error('Ошибка отправки сообщения:', error);
    }
  });

  socket.on('joinTrip', (tripId) => {
    socket.join(`trip_${tripId}`);
  });

  socket.on('saveTrack', async (track) => {
    try {
      const user = activeUsers.get(socket.id);
      if (user) {
        await client.query(
          'INSERT INTO tracks(trip_id,user_name,track_name,track_data) VALUES($1,$2,$3,$4)',
          [track.tripId, user.name, track.name, JSON.stringify(track.data)]
        );
        socket.emit('trackSaved', { success: true });
      }
    } catch (error) {
      console.error('Ошибка сохранения трека:', error);
      socket.emit('trackSaved', { success: false, error: error.message });
    }
  });

  socket.on('disconnect', async () => {
    try {
      activeUsers.delete(socket.id);
      await client.query('UPDATE users SET last_seen=NOW() WHERE socket_id=$1', [socket.id]);
      io.emit('userDisconnected', socket.id);
    } catch (error) {
      console.error('Ошибка отключения:', error);
    }
  });
});

// Запуск сервера
async function startServer() {
  try {
    await initDatabase();
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Adventure Sync Server запущен на Railway`);
      console.log(`📍 Порт: ${PORT}`);
      console.log(`🌍 Разрешенные домены: ${allowedOrigins.join(', ')}`);
    });
  } catch (error) {
    console.error('❌ Критическая ошибка запуска:', error);
    process.exit(1);
  }
}

// Обработка системных ошибок
process.on('uncaughtException', (error) => {
  console.error('❌ Необработанная ошибка:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Необработанный отказ:', reason);
});

startServer();
