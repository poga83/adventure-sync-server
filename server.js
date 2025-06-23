const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

// Импорт модулей
const UserManager = require('./modules/UserManager');
const ChatManager = require('./modules/ChatManager');

const app = express();
const server = http.createServer(app);

// ИСПРАВЛЕНО: Правильная конфигурация CORS для Socket.IO
const io = socketIo(server, {
    cors: {
        origin: ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:8080", "http://127.0.0.1:8080"],
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["Content-Type"]
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000
});

// Middleware
app.use(cors({
    origin: ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:8080", "http://127.0.0.1:8080"],
    credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// Инициализация менеджеров
const userManager = new UserManager();
const chatManager = new ChatManager();

// ИСПРАВЛЕНО: Улучшенная обработка подключений
io.on('connection', (socket) => {
    console.log(`✅ Новое подключение: ${socket.id}`);
    
    // Обработка подключения пользователя
    socket.on('userConnected', (userData) => {
        try {
            console.log(`👤 Пользователь подключился:`, userData);
            
            // Добавляем пользователя
            userManager.addUser(socket.id, userData);
            
            // Отправляем список всех пользователей новому клиенту
            socket.emit('users', userManager.getAllUsers());
            
            // Уведомляем других пользователей о новом подключении
            socket.broadcast.emit('userConnected', userData);
            
            console.log(`📊 Всего пользователей онлайн: ${userManager.getUserCount()}`);
        } catch (error) {
            console.error('❌ Ошибка при подключении пользователя:', error);
            socket.emit('error', { message: 'Ошибка при подключении' });
        }
    });
    
    // Получение списка пользователей
    socket.on('getUsers', () => {
        socket.emit('users', userManager.getAllUsers());
    });
    
    // Обновление статуса пользователя
    socket.on('updateStatus', (status) => {
        try {
            const user = userManager.updateUserStatus(socket.id, status);
            if (user) {
                io.emit('userStatusChanged', {
                    userId: user.id,
                    status: status
                });
            }
        } catch (error) {
            console.error('❌ Ошибка при обновлении статуса:', error);
        }
    });
    
    // Обновление позиции пользователя
    socket.on('updatePosition', (position) => {
        try {
            const user = userManager.updateUserPosition(socket.id, position);
            if (user) {
                socket.broadcast.emit('userPositionChanged', {
                    userId: user.id,
                    position: position
                });
            }
        } catch (error) {
            console.error('❌ Ошибка при обновлении позиции:', error);
        }
    });
    
    // Групповые сообщения
    socket.on('groupMessage', (message) => {
        try {
            const fullMessage = {
                ...message,
                id: Date.now(),
                timestamp: new Date().toISOString()
            };
            
            chatManager.addGroupMessage(fullMessage);
            io.emit('groupMessage', fullMessage);
            
            console.log(`💬 Групповое сообщение от ${message.senderName}: ${message.content}`);
        } catch (error) {
            console.error('❌ Ошибка при отправке группового сообщения:', error);
        }
    });
    
    // Приватные сообщения
    socket.on('privateMessage', (data) => {
        try {
            const message = {
                ...data.content,
                id: Date.now(),
                timestamp: new Date().toISOString()
            };
            
            chatManager.addPrivateMessage(data.to, message);
            
            // Отправляем сообщение получателю
            const targetUser = userManager.getUserByUserId(data.to);
            if (targetUser) {
                io.to(targetUser.socketId).emit('privateMessage', message);
            }
            
            // Подтверждение отправителю
            socket.emit('privateMessage', message);
        } catch (error) {
            console.error('❌ Ошибка при отправке приватного сообщения:', error);
        }
    });
    
    // История группового чата
    socket.on('getGroupChatHistory', () => {
        socket.emit('groupChatHistory', chatManager.getGroupMessages());
    });
    
    // История приватного чата
    socket.on('getPrivateChatHistory', (userId) => {
        const messages = chatManager.getPrivateMessages(userId);
        socket.emit('privateChatHistory', {
            userId: userId,
            messages: messages
        });
    });
    
    // ИСПРАВЛЕНО: Обработка отключения
    socket.on('disconnect', (reason) => {
        console.log(`❌ Пользователь отключился: ${socket.id}, причина: ${reason}`);
        
        try {
            const user = userManager.removeUser(socket.id);
            if (user) {
                socket.broadcast.emit('userDisconnected', user.id);
                console.log(`📊 Пользователей онлайн: ${userManager.getUserCount()}`);
            }
        } catch (error) {
            console.error('❌ Ошибка при отключении пользователя:', error);
        }
    });
    
    // Обработка ошибок сокета
    socket.on('error', (error) => {
        console.error(`❌ Ошибка сокета ${socket.id}:`, error);
    });
});

// ИСПРАВЛЕНО: Обработка ошибок подключения на уровне движка
io.engine.on("connection_error", (err) => {
    console.log('❌ Ошибка подключения движка:', {
        req: err.req?.url,
        code: err.code,
        message: err.message,
        context: err.context
    });
});

// REST API endpoints для диагностики
app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        users: userManager.getUserCount(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/api/users', (req, res) => {
    res.json(userManager.getAllUsers());
});

// Основная страница для тестирования
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>Adventure Sync Server</title></head>
        <body style="font-family: Arial; padding: 20px; background: #2C2C2C; color: #E0E0E0;">
            <h1>🌍 Adventure Sync Server</h1>
            <p>Сервер запущен и работает!</p>
            <p>Пользователей онлайн: <span id="userCount">${userManager.getUserCount()}</span></p>
            <p>Время работы: ${Math.floor(process.uptime())} секунд</p>
            <hr>
            <h3>Диагностика:</h3>
            <p>• <a href="/api/status" style="color: #64B5F6;">Статус сервера</a></p>
            <p>• <a href="/api/users" style="color: #64B5F6;">Список пользователей</a></p>
            <script>
                setInterval(() => {
                    fetch('/api/status')
                        .then(r => r.json())
                        .then(data => {
                            document.getElementById('userCount').textContent = data.users;
                        });
                }, 5000);
            </script>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🚀 Adventure Sync Server запущен!
    📡 Порт: ${PORT}
    🌐 URL: http://localhost:${PORT}
    🔌 Socket.IO готов к подключениям
    📊 Пользователей онлайн: ${userManager.getUserCount()}
    `);
});

// Обработка ошибок процесса
process.on('uncaughtException', (error) => {
    console.error('❌ Необработанная ошибка:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Необработанное отклонение промиса:', reason);
});
