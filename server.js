const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// CORS настройки для Fly.io
app.use(cors({
    origin: [
        'https://poga83.github.io',
        'http://localhost:3000',
        'http://127.0.0.1:3000'
    ],
    credentials: false
}));

app.use(express.json());

// Health check для Fly.io
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// Базовый маршрут
app.get('/', (req, res) => {
    res.json({ 
        name: 'Adventure Sync Server',
        version: '1.0.0',
        status: 'running'
    });
});

// Socket.IO с настройками для Fly.io
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

// Хранение данных в памяти
const users = new Map();
const groupMessages = [];
const privateMessages = new Map();

// Обработчики Socket.IO
io.on('connection', (socket) => {
    console.log(`👤 Пользователь подключился: ${socket.id}`);
    
    // Подтверждение подключения
    socket.emit('connectionConfirmed', {
        socketId: socket.id,
        timestamp: Date.now(),
        server: 'fly.io'
    });

    // Регистрация пользователя
    socket.on('userConnected', (userData) => {
        console.log(`📝 Регистрация пользователя:`, userData);
        
        const user = {
            ...userData,
            socketId: socket.id,
            lastSeen: Date.now(),
            connectedAt: Date.now()
        };
        
        users.set(socket.id, user);
        
        // Отправляем список всех пользователей новому пользователю
        socket.emit('users', Array.from(users.values()));
        
        // Уведомляем других о новом пользователе
        socket.broadcast.emit('userConnected', user);
        
        console.log(`👥 Всего пользователей онлайн: ${users.size}`);
    });

    // Обновление статуса
    socket.on('updateStatus', (status) => {
        const user = users.get(socket.id);
        if (user) {
            user.status = status;
            user.lastSeen = Date.now();
            users.set(socket.id, user);
            
            io.emit('userStatusChanged', {
                userId: socket.id,
                status: status,
                timestamp: Date.now()
            });
            
            console.log(`🔄 Пользователь ${user.name} изменил статус на: ${status}`);
        }
    });

    // Обновление позиции
    socket.on('updatePosition', (position) => {
        const user = users.get(socket.id);
        if (user) {
            user.position = {
                ...position,
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
            const message = {
                id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                senderId: socket.id,
                senderName: user.name,
                content: messageData.content || messageData,
                timestamp: Date.now(),
                type: 'group'
            };
            
            groupMessages.push(message);
            
            // Ограничиваем историю последними 200 сообщениями
            if (groupMessages.length > 200) {
                groupMessages.splice(0, groupMessages.length - 200);
            }
            
            io.emit('groupMessage', message);
            console.log(`💬 Групповое сообщение от ${user.name}: ${message.content}`);
        }
    });

    // Приватные сообщения
    socket.on('privateMessage', (data) => {
        const user = users.get(socket.id);
        if (user && data.to) {
            const message = {
                id: `pmsg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                from: socket.id,
                fromName: user.name,
                to: data.to,
                content: data.content,
                timestamp: Date.now(),
                type: 'private'
            };
            
            // Сохраняем в истории приватных сообщений
            const chatKey = [socket.id, data.to].sort().join('-');
            if (!privateMessages.has(chatKey)) {
                privateMessages.set(chatKey, []);
            }
            
            const chatHistory = privateMessages.get(chatKey);
            chatHistory.push(message);
            
            // Ограничиваем историю приватного чата
            if (chatHistory.length > 100) {
                chatHistory.splice(0, chatHistory.length - 100);
            }
            
            // Отправляем получателю и отправителю
            socket.to(data.to).emit('privateMessage', message);
            socket.emit('privateMessage', message);
            
            console.log(`📧 Приватное сообщение от ${user.name} для ${data.to}`);
        }
    });

    // Запрос истории группового чата
    socket.on('getGroupChatHistory', () => {
        socket.emit('groupChatHistory', groupMessages);
    });

    // Запрос истории приватного чата
    socket.on('getPrivateChatHistory', (userId) => {
        const chatKey = [socket.id, userId].sort().join('-');
        const history = privateMessages.get(chatKey) || [];
        socket.emit('privateChatHistory', {
            userId: userId,
            messages: history
        });
    });

    // Запрос списка пользователей
    socket.on('getUsers', () => {
        socket.emit('users', Array.from(users.values()));
    });

    // Синхронизация поездок
    socket.on('syncTrip', (tripData) => {
        const user = users.get(socket.id);
        if (user) {
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
        console.log(`👤 Пользователь отключился: ${socket.id}, причина: ${reason}`);
        
        const user = users.get(socket.id);
        if (user) {
            console.log(`👋 ${user.name} покинул Adventure Sync`);
            users.delete(socket.id);
            socket.broadcast.emit('userDisconnected', socket.id);
            console.log(`👥 Пользователей онлайн: ${users.size}`);
        }
    });

    // Обработка ошибок
    socket.on('error', (error) => {
        console.error(`❌ Ошибка Socket.IO для ${socket.id}:`, error);
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
    console.log(`📊 Статистика: ${users.size} пользователей онлайн, ${groupMessages.length} сообщений в истории`);
}, 10 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Получен SIGTERM, завершаем работу сервера...');
    
    // Уведомляем всех пользователей об отключении
    io.emit('serverShutdown', { 
        message: 'Сервер перезапускается, переподключение через несколько секунд...' 
    });
    
    // Даем время на отправку уведомления
    setTimeout(() => {
        server.close(() => {
            console.log('✅ Сервер корректно завершен');
            process.exit(0);
        });
    }, 1000);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Adventure Sync Server запущен на порту ${PORT}`);
    console.log(`🌍 Окружение: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📍 Регион: ${process.env.FLY_REGION || 'local'}`);
});

module.exports = app;
