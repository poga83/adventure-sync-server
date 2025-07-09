const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Client } = require('pg');

const app = express();
const server = http.createServer(app);

// Render использует PORT из переменной окружения
const PORT = process.env.PORT || 3000;

// CORS настройки для Render
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

// Подключение к PostgreSQL на Render
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Инициализация базы данных
async function initDatabase() {
  try {
    await client.connect();
    console.log('✅ PostgreSQL подключен к Render');
    
    // Создание таблиц
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS postgis;
      
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        socket_id TEXT UNIQUE,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'walking',
        position POINT,
        last_seen TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
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
        trip_id INTEGER REFERENCES trips(id),
        sender_name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS tracks (
        id SERIAL PRIMARY KEY,
        trip_id INTEGER REFERENCES trips(id),
        user_name TEXT,
        track_name TEXT,
        track_data JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    console.log('✅ Таблицы созданы успешно');
  } catch (error) {
    console.error('❌ Ошибка инициализации БД:', error);
    throw error;
  }
}

// Health check для Render
app.get('/health', async (req, res) => {
  try {
    await client.query('SELECT 1');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      platform: 'render',
      database: 'connected'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      platform: 'render',
      database: 'disconnected',
      error: error.message
    });
  }
});

// Главная страница
app.get('/', (req, res) => {
  res.json({
    name: 'Adventure Sync Server',
    version: '2.0.0',
    status: 'running',
    platform: 'Render'
  });
});

// API для поездок
app.post('/api/trips', async (req, res) => {
  try {
    const { name, description, startDate, endDate, gatheringPoint } = req.body;
    
    if (!name || !gatheringPoint) {
      return res.status(400).json({ error: 'Name and gathering point are required' });
    }
    
    const result = await client.query(
      'INSERT INTO trips (name, description, start_date, end_date, gathering_point) VALUES ($1, $2, $3, $4, POINT($5, $6)) RETURNING *',
      [name, description, startDate, endDate, gatheringPoint.lng, gatheringPoint.lat]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка создания поездки:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/trips', async (req, res) => {
  try {
    const result = await client.query('SELECT * FROM trips ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка получения поездок:', error);
    res.status(500).json({ error: error.message });
  }
});

// Socket.IO конфигурация для Render
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: false
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000
});

// Хранилище активных пользователей
const activeUsers = new Map();

io.on('connection', (socket) => {
  console.log(`👤 Новое подключение: ${socket.id}`);
  
  socket.emit('connectionConfirmed', {
    socketId: socket.id,
    timestamp: Date.now(),
    server: 'render'
  });

  // Регистрация пользователя
  socket.on('userConnected', async (userData) => {
    try {
      const user = {
        ...userData,
        socketId: socket.id,
        lastSeen: Date.now()
      };
      
      await client.query(
        'INSERT INTO users (socket_id, name, status) VALUES ($1, $2, $3) ON CONFLICT (socket_id) DO UPDATE SET name = $2, status = $3, last_seen = NOW()',
        [socket.id, userData.name, userData.status]
      );
      
      activeUsers.set(socket.id, user);
      
      const usersList = Array.from(activeUsers.values());
      socket.emit('users', usersList);
      socket.broadcast.emit('userConnected', user);
      
      console.log(`👥 Пользователь ${userData.name} подключился`);
    } catch (error) {
      console.error('Ошибка регистрации пользователя:', error);
    }
  });

  // Обновление позиции
  socket.on('updatePosition', async (position) => {
    try {
      const user = activeUsers.get(socket.id);
      if (user && position && typeof position.lat === 'number' && typeof position.lng === 'number') {
        user.position = {
          lat: position.lat,
          lng: position.lng,
          timestamp: Date.now()
        };
        user.lastSeen = Date.now();
        activeUsers.set(socket.id, user);
        
        await client.query(
          'UPDATE users SET position = POINT($1, $2), last_seen = NOW() WHERE socket_id = $3',
          [position.lng, position.lat, socket.id]
        );
        
        socket.broadcast.emit('userPositionChanged', {
          userId: socket.id,
          position: user.position
        });
      }
    } catch (error) {
      console.error('Ошибка обновления позиции:', error);
    }
  });

  // Групповые сообщения
  socket.on('groupMessage', async (messageData) => {
    try {
      const user = activeUsers.get(socket.id);
      if (user) {
        const content = typeof messageData === 'string' ? messageData : messageData.content;
        const tripId = messageData.tripId || null;
        
        if (content && content.trim().length > 0) {
          const message = {
            id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            senderId: socket.id,
            senderName: user.name,
            content: content.trim(),
            tripId: tripId,
            timestamp: Date.now()
          };
          
          await client.query(
            'INSERT INTO messages (trip_id, sender_name, content) VALUES ($1, $2, $3)',
            [tripId, user.name, content.trim()]
          );
          
          if (tripId) {
            socket.to(`trip_${tripId}`).emit('groupMessage', message);
          } else {
            io.emit('groupMessage', message);
          }
          
          console.log(`💬 Сообщение от ${user.name}: ${content.substring(0, 50)}...`);
        }
      }
    } catch (error) {
      console.error('Ошибка отправки сообщения:', error);
    }
  });

  // Присоединение к поездке
  socket.on('joinTrip', async (tripId) => {
    try {
      const user = activeUsers.get(socket.id);
      if (user) {
        socket.join(`trip_${tripId}`);
        
        socket.to(`trip_${tripId}`).emit('userJoinedTrip', {
          tripId,
          user: user
        });
        
        console.log(`🎯 ${user.name} присоединился к поездке ${tripId}`);
      }
    } catch (error) {
      console.error('Ошибка присоединения к поездке:', error);
    }
  });

  // Сохранение трека
  socket.on('saveTrack', async (trackData) => {
    try {
      const user = activeUsers.get(socket.id);
      if (user && trackData) {
        await client.query(
          'INSERT INTO tracks (trip_id, user_name, track_name, track_data) VALUES ($1, $2, $3, $4)',
          [trackData.tripId, user.name, trackData.name, JSON.stringify(trackData.data)]
        );
        
        socket.emit('trackSaved', { success: true });
        console.log(`📍 Трек сохранен для ${user.name}`);
      }
    } catch (error) {
      console.error('Ошибка сохранения трека:', error);
      socket.emit('trackSaved', { success: false, error: error.message });
    }
  });

  // Отключение пользователя
  socket.on('disconnect', async (reason) => {
    try {
      const user = activeUsers.get(socket.id);
      if (user) {
        console.log(`👋 ${user.name} отключился (${reason})`);
        
        await client.query(
          'UPDATE users SET last_seen = NOW() WHERE socket_id = $1',
          [socket.id]
        );
        
        activeUsers.delete(socket.id);
        socket.broadcast.emit('userDisconnected', socket.id);
      }
    } catch (error) {
      console.error('Ошибка отключения:', error);
    }
  });
});

// Статистика
app.get('/api/stats', async (req, res) => {
  try {
    const userCount = await client.query('SELECT COUNT(*) FROM users');
    const tripCount = await client.query('SELECT COUNT(*) FROM trips');
    const messageCount = await client.query('SELECT COUNT(*) FROM messages');
    
    res.json({
      uptime: Math.floor(process.uptime()),
      usersOnline: activeUsers.size,
      totalUsers: parseInt(userCount.rows[0].count),
      totalTrips: parseInt(tripCount.rows[0].count),
      totalMessages: parseInt(messageCount.rows[0].count),
      platform: 'render'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Запуск сервера
async function startServer() {
  try {
    await initDatabase();
    
    server.listen(PORT, () => {
      console.log(`🚀 Adventure Sync Server запущен на Render`);
      console.log(`📍 Порт: ${PORT}`);
      console.log(`🌍 Разрешенные домены: ${allowedOrigins.join(', ')}`);
      console.log(`⏰ Время запуска: ${new Date().toISOString()}`);
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

module.exports = app;
