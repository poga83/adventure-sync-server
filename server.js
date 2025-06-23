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
        origin: [
            "http://localhost:3000", 
            "http://127.0.0.1:3000", 
            "http://localhost:8080", 
            "http://127.0.0.1:8080",
            "http://localhost:5500",
            "http://127.0.0.1:5500"
        ],
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["Content-Type"]
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000
});

// Middleware для Express
app.use(cors({
    origin: [
        "http://localhost:3000", 
        "http://127.0.0.1:3000", 
        "http://localhost:8080", 
        "http://127.0.0.1:8080",
        "http://localhost:5500",
        "http://127.0.0.1:5500"
    ],
    credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// Инициализация менеджеров
const userManager = new UserManager();
const chatManager = new ChatManager();

// ИСПРАВЛЕНО: Улучшенная обработка подключений Socket.IO
io.on('connection', (socket) => {
    console.log(`✅ Новое подключение: ${socket.id} в ${new Date().toLocaleTimeString()}`);
    
    // Отправляем подтверждение подключения
    socket.emit('connectionConfirmed', { 
        message: 'Подключение установлено', 
        socketId: socket.id,
        serverTime: new Date().toISOString()
    });
    
    // Обработка подключения пользователя
    socket.on('userConnected', (userData) => {
        try {
            console.log(`👤 Пользователь подключился:`, userData);
            
            // Добавляем пользователя в менеджер
            const user = userManager.addUser(socket.id, userData);
            
            // Отправляем список всех пользователей новому клиенту
            const allUsers = userManager.getAllUsers();
            socket.emit('users', allUsers);
            
            // Уведомляем других пользователей о новом подключении
            socket.broadcast.emit('userConnected', user);
            
            console.log(`📊 Всего пользователей онлайн: ${userManager.getUserCount()}`);
        } catch (error) {
            console.error('❌ Ошибка при подключении пользователя:', error);
            socket.emit('error', { message: 'Ошибка при подключении', error: error.message });
        }
    });
    
    // Получение списка пользователей
    socket.on('getUsers', () => {
        try {
            const users = userManager.getAllUsers();
            socket.emit('users', users);
        } catch (error) {
            console.error('❌ Ошибка при получении списка пользователей:', error);
            socket.emit('error', { message: 'Ошибка при получении пользователей' });
        }
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
                console.log(`🔄 Обновлен статус пользователя ${user.nickname} на ${status}`);
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
            
            // Найдем получателя и отправим ему сообщение
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
        try {
            const messages = chatManager.getGroupMessages();
            socket.emit('groupChatHistory', messages);
        } catch (error) {
            console.error('❌ Ошибка при получении истории группового чата:', error);
        }
    });
    
    // История приватного чата
    socket.on('getPrivateChatHistory', (userId) => {
        try {
            const messages = chatManager.getPrivateMessages(userId);
            socket.emit('privateChatHistory', {
                userId: userId,
                messages: messages
            });
        } catch (error) {
            console.error('❌ Ошибка при получении истории приватного чата:', error);
        }
    });
    
    // ИСПРАВЛЕНО: Правильная обработка отключения
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

// ИСПРАВЛЕНО: Обработка ошибок подключения на уровне движка Socket.IO
io.engine.on("connection_error", (err) => {
    console.log('❌ Ошибка подключения движка Socket.IO:', {
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
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

app.get('/api/users', (req, res) => {
    res.json(userManager.getAllUsers());
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Основная страница для тестирования
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Adventure Sync Server</title>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; background: #1a1a1a; color: #e0e0e0; }
                .status { background: #2c2c2c; padding: 15px; border-radius: 8px; margin: 10px 0; }
                .online { color: #4caf50; }
                .endpoint { background: #3a3a3a; padding: 10px; border-radius: 4px; margin: 5px 0; }
                a { color: #64b5f6; text-decoration: none; }
                a:hover { text-decoration: underline; }
            </style>
        </head>
        <body>
            <h1>🌍 Adventure Sync Server</h1>
            <div class="status">
                <h3>Статус сервера: <span class="online">ЗАПУЩЕН</span></h3>
                <p>Пользователей онлайн: <span id="userCount">${userManager.getUserCount()}</span></p>
                <p>Время работы: ${Math.floor(process.uptime())} секунд</p>
                <p>Версия: 1.0.0</p>
            </div>
            
            <h3>API Endpoints:</h3>
            <div class="endpoint">GET <a href="/api/status">/api/status</a> - Статус сервера</div>
            <div class="endpoint">GET <a href="/api/users">/api/users</a> - Список пользователей</div>
            <div class="endpoint">GET <a href="/health">/health</a> - Проверка здоровья</div>
            
            <h3>Socket.IO:</h3>
            <div class="endpoint">Транспорты: WebSocket, Polling</div>
            <div class="endpoint">CORS: Включен для localhost</div>
            <div class="endpoint">Активных подключений: <span id="socketCount">0</span></div>
            
            <script>
                function updateStats() {
                    fetch('/api/status')
                        .then(r => r.json())
                        .then(data => {
                            document.getElementById('userCount').textContent = data.users;
                        })
                        .catch(e => console.error('Ошибка получения статуса:', e));
                }
                
                setInterval(updateStats, 5000);
                updateStats();
            </script>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`
    🚀 Adventure Sync Server успешно запущен!
    📡 Порт: ${PORT}
    🌐 Host: ${HOST}
    🔗 URL: http://localhost:${PORT}
    🔌 Socket.IO готов к подключениям
    📊 Пользователей онлайн: ${userManager.getUserCount()}
    ⏰ Время запуска: ${new Date().toLocaleString()}
    `);
});

// Обработка ошибок процесса
process.on('uncaughtException', (error) => {
    console.error('❌ Необработанная ошибка:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Необработанное отклонение промиса:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('📴 Получен сигнал SIGTERM, завершение работы...');
    server.close(() => {
        console.log('✅ HTTP сервер закрыт');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('📴 Получен сигнал SIGINT, завершение работы...');
    server.close(() => {
        console.log('✅ HTTP сервер закрыт');
        process.exit(0);
    });
});
