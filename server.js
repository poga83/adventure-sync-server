const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Client } = require('pg');

const app = express();
const server = http.createServer(app);

// КРИТИЧНО: Слушаем на 0.0.0.0 и PORT от Railway
const PORT = process.env.PORT || 3000;

// CORS для клиента
app.use(cors({
  origin: [
    'https://poga83.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ],
  credentials: false
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Подключение к PostgreSQL с правильными настройками SSL
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Инициализация базы данных
async function initDatabase() {
  try {
    await client.connect();
    console.log('✅ PostgreSQL подключен');
    
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
        name VARCHAR(255) NOT NULL,
        description TEXT,
        start_date DATE,
        end_date DATE,
        gathering_point POINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        trip_id INTEGER REFERENCES trips(id),
        sender_name VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS tracks (
        id SERIAL PRIMARY KEY,
        trip_id INTEGER,
        user_name VARCHAR(255),
        track_name VARCHAR(255),
        track_data JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    console.log('✅ Таблицы созданы');
  } catch (error) {
    console.error('❌ Ошибка инициализации БД:', error);
  }
}

// Health check для Railway
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    platform: 'railway'
  });
});

// Главная страница
app.get('/', (req, res) => {
  res.json({ 
    name: 'Adventure Sync Server',
    version: '2.0.0',
    status: 'running',
    platform: 'Railway'
  });
});

// API для поездок
app.post('/api/trips', async (req, res) => {
  try {
    const { name, description, startDate, endDate, gatheringPoint } = req.body;
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

// Socket.IO настройки
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
  pingInterval: 25000
});

// Хранилище активных пользователей
const activeUsers = new Map();

io.on('connection', (socket) => {
  console.log(`👤 Новое подключение: ${socket.id}`);
  
  socket.emit('connectionConfirmed', {
    socketId: socket.id,
    timestamp: Date.now(),
    server: 'railway'
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
        'INSERT INTO users (socket_id, name, status) VALUES ($1, $2, $3) ON CONFLICT (socket_id) DO UPDATE SET name = $2, status = $3',
        [socket.id, userData.name, userData.status]
      );
      
      activeUsers.set(socket.id, user);
      
      const usersList = Array.from(activeUsers.values());
      socket.emit('users', usersList);
      socket.broadcast.emit('userConnected', user);
      
      console.log(`👥 Пользователь ${userData.name} подключился`);
    } catch (error) {
      console.error('❌ Ошибка регистрации:', error);
    }
  });

  // Обновление позиции
  socket.on('updatePosition', async (position) => {
    const user = activeUsers.get(socket.id);
    if (user && position) {
      user.position = {
        lat: position.lat,
        lng: position.lng,
        timestamp: Date.now()
      };
      activeUsers.set(socket.id, user);
      
      try {
        await client.query(
          'UPDATE users SET position = POINT($1, $2) WHERE socket_id = $3',
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

  // Групповые сообщения
  socket.on('groupMessage', async (messageData) => {
    const user = activeUsers.get(socket.id);
    if (user) {
      const content = typeof messageData === 'string' ? messageData : messageData.content;
      
      if (content && content.trim().length > 0) {
        const message = {
          id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          senderId: socket.id,
          senderName: user.name,
          content: content.trim(),
          timestamp: Date.now()
        };
        
        try {
          await client.query(
            'INSERT INTO messages (sender_name, content) VALUES ($1, $2)',
            [user.name, content.trim()]
          );
        } catch (error) {
          console.error('❌ Ошибка сохранения сообщения:', error);
        }
        
        io.emit('groupMessage', message);
        console.log(`💬 Сообщение от ${user.name}: ${content}`);
      }
    }
  });

  // Присоединение к поездке
  socket.on('joinTrip', (tripId) => {
    const user = activeUsers.get(socket.id);
    if (user) {
      socket.join(`trip_${tripId}`);
      socket.to(`trip_${tripId}`).emit('userJoinedTrip', {
        tripId,
        user: user
      });
      console.log(`🎯 ${user.name} присоединился к поездке ${tripId}`);
    }
  });

  // Сохранение трека
  socket.on('saveTrack', async (trackData) => {
    const user = activeUsers.get(socket.id);
    if (user && trackData) {
      try {
        await client.query(
          'INSERT INTO tracks (trip_id, user_name, track_name, track_data) VALUES ($1, $2, $3, $4)',
          [trackData.tripId, user.name, trackData.name, JSON.stringify(trackData.data)]
        );
        
        socket.emit('trackSaved', { success: true });
        console.log(`📍 Трек сохранен для ${user.name}`);
      } catch (error) {
        console.error('❌ Ошибка сохранения трека:', error);
        socket.emit('trackSaved', { success: false, error: error.message });
      }
    }
  });

  // Отключение
  socket.on('disconnect', async (reason) => {
    const user = activeUsers.get(socket.id);
    if (user) {
      console.log(`👋 ${user.name} отключился (${reason})`);
      
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

// Запуск сервера
async function startServer() {
  try {
    await initDatabase();
    
    // КРИТИЧНО: Слушаем на 0.0.0.0 для Railway
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Adventure Sync Server запущен на Railway`);
      console.log(`📍 Порт: ${PORT}`);
      console.log(`🌍 Хост: 0.0.0.0`);
      console.log(`⏰ Время: ${new Date().toISOString()}`);
    });
  } catch (error) {
    console.error('❌ Ошибка запуска сервера:', error);
    process.exit(1);
  }
}

startServer();

// Обработка ошибок
process.on('uncaughtException', (error) => {
  console.error('❌ Необработанная ошибка:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Необработанный отказ:', reason);
});

module.exports = app;
