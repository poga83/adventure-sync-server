const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// ИСПРАВЛЕНО: CORS для GitHub Pages
app.use(cors({
    origin: [
        'https://poga83.github.io',
        'http://localhost:3000',
        'http://127.0.0.1:3000'
    ],
    credentials: false // GitHub Pages не поддерживает credentials
}));

app.use(express.json());

// Health check для Render
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ИСПРАВЛЕНО: Socket.IO с правильными CORS для GitHub Pages
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

// Хранение пользователей и сообщений
const users = new Map();
const groupMessages = [];
const privateMessages = new Map();

io.on('connection', (socket) => {
    console.log(`👤 Пользователь подключился: ${socket.id}`);
    
    // Подтверждение подключения
    socket.emit('connectionConfirmed', {
        socketId: socket.id,
        timestamp: Date.now()
    });

    // Регистрация пользователя
    socket.on('userConnected', (userData) => {
        console.log(`📝 Регистрация пользователя:`, userData);
        
        users.set(socket.id, {
            ...userData,
            socketId: socket.id,
            lastSeen: Date.now()
        });
        
        // Отправляем список всех пользователей
        socket.emit('users', Array.from(users.values()));
        
        // Уведомляем других о новом пользователе
        socket.broadcast.emit('userConnected', users.get(socket.id));
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
                status: status
            });
        }
    });

    // Обновление позиции
    socket.on('updatePosition', (position) => {
        const user = users.get(socket.id);
        if (user) {
            user.position = position;
            user.lastSeen = Date.now();
            users.set(socket.id, user);
            
            socket.broadcast.emit('userPositionChanged', {
                userId: socket.id,
                position: position
            });
        }
    });

    // Групповые сообщения
    socket.on('groupMessage', (messageData) => {
        const user = users.get(socket.id);
        if (user) {
            const message = {
                id: Date.now() + Math.random(),
                senderId: socket.id,
                senderName: user.name,
                content: messageData.content || messageData,
                timestamp: Date.now()
            };
            
            groupMessages.push(message);
            
            // Ограничиваем историю последними 100 сообщениями
            if (groupMessages.length > 100) {
                groupMessages.shift();
            }
            
            io.emit('groupMessage', message);
        }
    });

    // Приватные сообщения
    socket.on('privateMessage', (data) => {
        const user = users.get(socket.id);
        if (user && data.to) {
            const message = {
                id: Date.now() + Math.random(),
                from: socket.id,
                fromName: user.name,
                to: data.to,
                content: data.content,
                timestamp: Date.now()
            };
            
            // Сохраняем в истории
            const chatKey = [socket.id, data.to].sort().join('-');
            if (!privateMessages.has(chatKey)) {
                privateMessages.set(chatKey, []);
            }
            privateMessages.get(chatKey).push(message);
            
            // Отправляем получателю и отправителю
            socket.to(data.to).emit('privateMessage', message);
            socket.emit('privateMessage', message);
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
                trip: tripData
            });
        }
    });

    // Отключение пользователя
    socket.on('disconnect', () => {
        console.log(`👤 Пользователь отключился: ${socket.id}`);
        
        if (users.has(socket.id)) {
            users.delete(socket.id);
            socket.broadcast.emit('userDisconnected', socket.id);
        }
    });
});

// Очистка неактивных пользователей каждые 5 минут
setInterval(() => {
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;
    
    for (const [socketId, user] of users.entries()) {
        if (now - user.lastSeen > fiveMinutes) {
            users.delete(socketId);
            io.emit('userDisconnected', socketId);
        }
    }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});

module.exports = app;
