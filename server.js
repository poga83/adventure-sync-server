const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Client } = require('pg');

const app = express();
const server = http.createServer(app);

// CORS настройки для Railway
app.use(cors({
  origin: [
    'https://poga83.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ],
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Подключение к PostgreSQL на Railway
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Инициализация БД
async function initDatabase() {
  try {
    await client.connect();
    
    // Создание таблиц
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        socket_id VARCHAR(255) UNIQUE,
        name VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'walking',
        position POINT,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS trips (
        id SERIAL PRIMARY KEY,
        creator_id INTEGER REFERENCES users(id),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        start_date DATE,
        end_date DATE,
        gathering_point POINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS trip_participants (
        id SERIAL PRIMARY KEY,
        trip_id INTEGER REFERENCES trips(id),
        user_id INTEGER REFERENCES users(id),
        role VARCHAR(50) DEFAULT 'participant',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        trip_id INTEGER REFERENCES trips(id),
        user_id INTEGER REFERENCES users(id),
        content TEXT NOT NULL,
        message_type VARCHAR(50) DEFAULT 'text',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS tracks (
        id SERIAL PRIMARY KEY,
        trip_id INTEGER REFERENCES trips(id),
        user_id INTEGER REFERENCES users(id),
        name VARCHAR(255),
        track_data JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    console.log('✅ База данных инициализирована');
  } catch (error) {
    console.error('❌ Ошибка инициализации БД:', error);
  }
}

// Health check для Railway
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || 'production',
    platform: 'railway',
    version: '2.0.0'
  });
});

// Базовый маршрут
app.get('/', (req, res) => {
  res.json({ 
    name: 'Adventure Sync Server',
    version: '2.0.0',
    status: 'running',
    platform: 'Railway',
    endpoints: {
      health: '/health',
      websocket: 'Socket.IO enabled'
    }
  });
});

// API для управления поездками
app.post('/api/trips', async (req, res) => {
  try {
    const { name, description, startDate, endDate, gatheringPoint } = req.body;
    const result = await client.query(
      'INSERT INTO trips (name, description, start_date, end_date, gathering_point) VALUES ($1, $2, $3, $4, POINT($5, $6)) RETURNING *',
      [name, description, startDate, endDate, gatheringPoint.lng, gatheringPoint.lat]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/trips', async (req, res) => {
  try {
    const result = await client.query('SELECT * FROM trips ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.IO с оптимизацией для Railway
const io = new Server(server, {
  cors: {
    origin: [
      'https://poga83.github.io',
      'http://localhost:3000',
      'http://127.0.0.1:3000'
    ],
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

// Обработчики Socket.IO событий
io.on('connection', (socket) => {
  console.log(`👤 Новое подключение: ${socket.id}`);
  
  // Подтверждение подключения
  socket.emit('connectionConfirmed', {
    socketId: socket.id,
    timestamp: Date.now(),
    server: 'railway',
    version: '2.0.0'
  });

  // Регистрация пользователя
  socket.on('userConnected', async (userData) => {
    try {
      const user = {
        ...userData,
        socketId: socket.id,
        lastSeen: Date.now(),
        connectedAt: Date.now()
      };
      
      // Сохранение в БД
      await client.query(
        'INSERT INTO users (socket_id, name, status) VALUES ($1, $2, $3) ON CONFLICT (socket_id) DO UPDATE SET name = $2, status = $3, last_seen = CURRENT_TIMESTAMP',
        [socket.id, userData.name, userData.status]
      );
      
      activeUsers.set(socket.id, user);
      
      // Отправляем обновленный список пользователей
      const usersList = Array.from(activeUsers.values());
      socket.emit('users', usersList);
      socket.broadcast.emit('userConnected', user);
      
      console.log(`👥 Пользователей онлайн: ${activeUsers.size}`);
      
    } catch (error) {
      console.error('❌ Ошибка регистрации пользователя:', error);
      socket.emit('error', { message: 'Ошибка регистрации пользователя' });
    }
  });

  // Обновление позиции с сохранением в БД
  socket.on('updatePosition', async (position) => {
    const user = activeUsers.get(socket.id);
    if (user && position && typeof position.lat === 'number' && typeof position.lng === 'number') {
      user.position = {
        lat: position.lat,
        lng: position.lng,
        accuracy: position.accuracy || null,
        timestamp: Date.now()
      };
      user.lastSeen = Date.now();
      activeUsers.set(socket.id, user);
      
      // Сохранение в БД
      try {
        await client.query(
          'UPDATE users SET position = POINT($1, $2), last_seen = CURRENT_TIMESTAMP WHERE socket_id = $3',
          [position.lng, position.lat, socket.id]
        );
      } catch (error) {
        console.error('❌ Ошибка сохранения позиции:', error);
      }
      
      socket.broadcast.emit('userPositionChanged', {
        userId: socket.id,
        position: user.position
      });
    }
  });

  // Групповые сообщения с сохранением в БД
  socket.on('groupMessage', async (messageData) => {
    const user = activeUsers.get(socket.id);
    if (user) {
      const content = typeof messageData === 'string' ? messageData : messageData.content;
      const tripId = messageData.tripId || null;
      
      if (content && content.trim().length > 0 && content.length <= 500) {
        const message = {
          id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          senderId: socket.id,
          senderName: user.name,
          content: content.trim(),
          tripId: tripId,
          timestamp: Date.now(),
          type: 'group'
        };
        
        // Сохранение в БД
        try {
          await client.query(
            'INSERT INTO messages (trip_id, user_id, content, message_type) VALUES ($1, (SELECT id FROM users WHERE socket_id = $2), $3, $4)',
            [tripId, socket.id, content.trim(), 'group']
          );
        } catch (error) {
          console.error('❌ Ошибка сохранения сообщения:', error);
        }
        
        if (tripId) {
          socket.to(`trip_${tripId}`).emit('groupMessage', message);
        } else {
          io.emit('groupMessage', message);
        }
        
        console.log(`💬 Сообщение от ${user.name}: ${content.substring(0, 50)}...`);
      }
    }
  });

  // Присоединение к поездке
  socket.on('joinTrip', async (tripId) => {
    try {
      const user = activeUsers.get(socket.id);
      if (user) {
        socket.join(`trip_${tripId}`);
        
        // Добавление участника в БД
        await client.query(
          'INSERT INTO trip_participants (trip_id, user_id) VALUES ($1, (SELECT id FROM users WHERE socket_id = $2)) ON CONFLICT DO NOTHING',
          [tripId, socket.id]
        );
        
        socket.to(`trip_${tripId}`).emit('userJoinedTrip', {
          tripId,
          user: user
        });
        
        console.log(`🎯 ${user.name} присоединился к поездке ${tripId}`);
      }
    } catch (error) {
      console.error('❌ Ошибка присоединения к поездке:', error);
    }
  });

  // Сохранение трека
  socket.on('saveTrack', async (trackData) => {
    try {
      const user = activeUsers.get(socket.id);
      if (user && trackData) {
        await client.query(
          'INSERT INTO tracks (trip_id, user_id, name, track_data) VALUES ($1, (SELECT id FROM users WHERE socket_id = $2), $3, $4)',
          [trackData.tripId, socket.id, trackData.name, JSON.stringify(trackData.data)]
        );
        
        socket.emit('trackSaved', { success: true });
        console.log(`📍 Трек сохранен для ${user.name}`);
      }
    } catch (error) {
      console.error('❌ Ошибка сохранения трека:', error);
      socket.emit('trackSaved', { success: false, error: error.message });
    }
  });

  // Отключение пользователя
  socket.on('disconnect', async (reason) => {
    const user = activeUsers.get(socket.id);
    if (user) {
      console.log(`👋 ${user.name} отключился (${reason})`);
      
      // Обновление в БД
      try {
        await client.query(
          'UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE socket_id = $1',
          [socket.id]
        );
      } catch (error) {
        console.error('❌ Ошибка обновления времени отключения:', error);
      }
      
      activeUsers.delete(socket.id);
      socket.broadcast.emit('userDisconnected', socket.id);
    }
  });
});

// Статистика
app.get('/stats', async (req, res) => {
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
      platform: 'railway'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Инициализация при запуске
initDatabase();

// Railway использует переменную PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Adventure Sync Server запущен на Railway`);
  console.log(`📍 Порт: ${PORT}`);
  console.log(`🌍 Окружение: ${process.env.NODE_ENV || 'production'}`);
  console.log(`⏰ Время запуска: ${new Date().toISOString()}`);
});

module.exports = app;
