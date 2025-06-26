const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// CORS настройки для Koyeb
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

// Health check для Koyeb
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        environment: process.env.NODE_ENV || 'production',
        platform: 'koyeb',
        version: '1.0.0'
    });
});

// Базовый маршрут
app.get('/', (req, res) => {
    res.json({ 
        name: 'Adventure Sync Server',
        version: '1.0.0',
        status: 'running',
        platform: 'Koyeb Serverless',
        endpoints: {
            health: '/health',
            websocket: 'Socket.IO enabled'
        }
    });
});

// Socket.IO с оптимизацией для Koyeb
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
    connectTimeout: 45000,
    allowEIO3: true,
    maxHttpBufferSize: 1e6,
    allowRequest: (req, callback) => {
        callback(null, true);
    }
});

// Хранилище данных в памяти
const users = new Map();
const groupMessages = [];
const privateMessages = new Map();
const userSessions = new Map();

// Статистика для мониторинга
let stats = {
    totalConnections: 0,
    currentConnections: 0,
    messagesCount: 0,
    startTime: Date.now()
};

// Обработчики Socket.IO событий
io.on('connection', (socket) => {
    stats.totalConnections++;
    stats.currentConnections++;
    
    console.log(`👤 Новое подключение: ${socket.id} (всего: ${stats.currentConnections})`);
    
    // Подтверждение подключения
    socket.emit('connectionConfirmed', {
        socketId: socket.id,
        timestamp: Date.now(),
        server: 'koyeb',
        version: '1.0.0'
    });

    // Регистрация пользователя
    socket.on('userConnected', (userData) => {
        try {
            console.log(`📝 Регистрация пользователя:`, userData.name);
            
            const user = {
                ...userData,
                socketId: socket.id,
                lastSeen: Date.now(),
                connectedAt: Date.now(),
                sessionId: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
            };
            
            users.set(socket.id, user);
            userSessions.set(user.sessionId, socket.id);
            
            // Отправляем обновленный список пользователей
            const usersList = Array.from(users.values());
            socket.emit('users', usersList);
            socket.broadcast.emit('userConnected', user);
            
            console.log(`👥 Пользователей онлайн: ${users.size}`);
            
        } catch (error) {
            console.error('❌ Ошибка регистрации пользователя:', error);
            socket.emit('error', { message: 'Ошибка регистрации пользователя' });
        }
    });

    // Обновление статуса
    socket.on('updateStatus', (status) => {
        const user = users.get(socket.id);
        if (user && ['auto', 'moto', 'walking', 'busy'].includes(status)) {
            user.status = status;
            user.lastSeen = Date.now();
            users.set(socket.id, user);
            
            io.emit('userStatusChanged', {
                userId: socket.id,
                status: status,
                timestamp: Date.now()
            });
            
            console.log(`🔄 ${user.name} изменил статус на: ${status}`);
        }
    });

    // Обновление позиции
    socket.on('updatePosition', (position) => {
        const user = users.get(socket.id);
        if (user && position && typeof position.lat === 'number' && typeof position.lng === 'number') {
            user.position = {
                lat: position.lat,
                lng: position.lng,
                accuracy: position.accuracy || null,
                timestamp: Date.now()
            };
            user.lastSeen = Date.now();
            users.set(socket.id, user);
            
            socket.broadcast.emit('userPositionChanged', {
                userId: socket.id,
                position: user.position
            });
        }
    });

    // Групповые сообщения
    socket.on('groupMessage', (messageData) => {
        const user = users.get(socket.id);
        if (user) {
            const content = typeof messageData === 'string' ? messageData : messageData.content;
            
            if (content && content.trim().length > 0 && content.length <= 500) {
                const message = {
                    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    senderId: socket.id,
                    senderName: user.name,
                    content: content.trim(),
                    timestamp: Date.now(),
                    type: 'group'
                };
                
                groupMessages.push(message);
                stats.messagesCount++;
                
                // Ограничиваем историю сообщений
                if (groupMessages.length > 200) {
                    groupMessages.splice(0, groupMessages.length - 200);
                }
                
                io.emit('groupMessage', message);
                console.log(`💬 Сообщение от ${user.name}: ${content.substring(0, 50)}...`);
            }
        }
    });

    // Приватные сообщения
    socket.on('privateMessage', (data) => {
        const user = users.get(socket.id);
        if (user && data.to && data.content && data.content.trim().length > 0) {
            const message = {
                id: `pmsg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                from: socket.id,
                fromName: user.name,
                to: data.to,
                content: data.content.trim(),
                timestamp: Date.now(),
                type: 'private'
            };
            
            const chatKey = [socket.id, data.to].sort().join('-');
            if (!privateMessages.has(chatKey)) {
                privateMessages.set(chatKey, []);
            }
            
            const chatHistory = privateMessages.get(chatKey);
            chatHistory.push(message);
            
            if (chatHistory.length > 100) {
                chatHistory.splice(0, chatHistory.length - 100);
            }
            
            socket.to(data.to).emit('privateMessage', message);
            socket.emit('privateMessage', message);
        }
    });

    // Запрос истории чата
    socket.on('getGroupChatHistory', () => {
        socket.emit('groupChatHistory', groupMessages.slice(-50));
    });

    // Запрос списка пользователей
    socket.on('getUsers', () => {
        socket.emit('users', Array.from(users.values()));
    });

    // Синхронизация поездок
    socket.on('syncTrip', (tripData) => {
        const user = users.get(socket.id);
        if (user && tripData) {
            socket.broadcast.emit('tripSync', {
                userId: socket.id,
                userName: user.name,
                trip: tripData,
                timestamp: Date.now()
            });
        }
    });

    // Отключение пользователя
    socket.on('disconnect', (reason) => {
        stats.currentConnections = Math.max(0, stats.currentConnections - 1);
        
        const user = users.get(socket.id);
        if (user) {
            console.log(`👋 ${user.name} отключился (${reason}). Онлайн: ${stats.currentConnections}`);
            
            if (user.sessionId) {
                userSessions.delete(user.sessionId);
            }
            
            users.delete(socket.id);
            socket.broadcast.emit('userDisconnected', socket.id);
        }
    });

    // Обработка ошибок
    socket.on('error', (error) => {
        console.error(`❌ Socket.IO ошибка ${socket.id}:`, error);
    });
});

// Статистика для мониторинга
app.get('/stats', (req, res) => {
    res.json({
        ...stats,
        uptime: Math.floor(process.uptime()),
        usersOnline: users.size,
        messagesInHistory: groupMessages.length,
        memoryUsage: process.memoryUsage(),
        platform: 'koyeb'
    });
});

// Очистка неактивных пользователей каждые 5 минут
setInterval(() => {
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;
    let cleanedCount = 0;
    
    for (const [socketId, user] of users.entries()) {
        if (now - user.lastSeen > fiveMinutes) {
            users.delete(socketId);
            if (user.sessionId) {
                userSessions.delete(user.sessionId);
            }
            io.emit('userDisconnected', socketId);
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        console.log(`🧹 Очищено ${cleanedCount} неактивных пользователей`);
    }
}, 5 * 60 * 1000);

// Логирование статистики каждые 10 минут
setInterval(() => {
    console.log(`📊 Статистика Koyeb: ${users.size} онлайн, ${groupMessages.length} сообщений, uptime: ${Math.floor(process.uptime())}с`);
}, 10 * 60 * 1000);

// Graceful shutdown для Koyeb
process.on('SIGTERM', () => {
    console.log('🛑 Получен SIGTERM, завершение работы сервера Koyeb...');
    
    io.emit('serverShutdown', { 
        message: 'Сервер Koyeb перезапускается, переподключение через несколько секунд...' 
    });
    
    setTimeout(() => {
        server.close(() => {
            console.log('✅ Сервер Koyeb корректно завершен');
            process.exit(0);
        });
    }, 1000);
});

// Koyeb использует переменную PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Adventure Sync Server запущен на Koyeb`);
    console.log(`📍 Порт: ${PORT}`);
    console.log(`🌍 Окружение: ${process.env.NODE_ENV || 'production'}`);
    console.log(`⏰ Время запуска: ${new Date().toISOString()}`);
});

module.exports = app;
