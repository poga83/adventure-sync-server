const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

// Импорт модулей
const UserManager = require('./modules/UserManager');
const ChatManager = require('./modules/ChatManager');

// Инициализация приложения
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Настройка middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация менеджеров
const userManager = new UserManager();
const chatManager = new ChatManager();

// Обработка подключений Socket.IO
io.on('connection', (socket) => {
    console.log(`Новое подключение: ${socket.id}`);
    
    // Обработка подключения пользователя
    socket.on('userConnected', (userData) => {
        // Добавляем socketId к данным пользователя
        userData.socketId = socket.id;
        
        // Регистрируем пользователя
        userManager.addUser(userData);
        
        // Отправляем информацию о новом пользователе всем остальным
        socket.broadcast.emit('userConnected', userData);
        
        console.log(`Пользователь подключен: ${userData.name} (${userData.id})`);
    });
    
    // Отправка списка пользователей
    socket.on('getUsers', () => {
        socket.emit('users', userManager.getAllUsers());
    });
    
    // Обновление статуса пользователя
    socket.on('updateStatus', (status) => {
        const user = userManager.getUserBySocketId(socket.id);
        if (user) {
            userManager.updateUserStatus(user.id, status);
            
            // Отправляем обновление всем пользователям
            io.emit('userStatusChanged', {
                userId: user.id,
                status: status
            });
            
            console.log(`Статус пользователя обновлен: ${user.name} -> ${status}`);
        }
    });
    
    // Обновление позиции пользователя
    socket.on('updatePosition', (position) => {
        const user = userManager.getUserBySocketId(socket.id);
        if (user) {
            userManager.updateUserPosition(user.id, position);
            
            // Отправляем обновление всем пользователям
            io.emit('userPositionChanged', {
                userId: user.id,
                position: position
            });
        }
    });
    
    // Групповые сообщения
    socket.on('groupMessage', (message) => {
        // Сохраняем сообщение
        chatManager.addGroupMessage(message);
        
        // Отправляем всем пользователям
        io.emit('groupMessage', message);
        
        console.log(`Групповое сообщение от ${message.senderName}: ${message.content}`);
    });
    
    // Приватные сообщения
    socket.on('privateMessage', (data) => {
        const sender = userManager.getUserBySocketId(socket.id);
        if (!sender) return;
        
        const recipient = userManager.getUser(data.to);
        if (!recipient) return;
        
        // Создаем объект сообщения
        const message = {
            senderId: sender.id,
            senderName: sender.name,
            recipientId: recipient.id,
            content: data.content,
            timestamp: new Date().toISOString()
        };
        
        // Сохраняем сообщение
        chatManager.addPrivateMessage(message);
        
        // Отправляем получателю
        if (recipient.socketId) {
            io.to(recipient.socketId).emit('privateMessage', message);
        }
        
        // Отправляем копию отправителю
        socket.emit('privateMessage', message);
        
        console.log(`Приватное сообщение от ${sender.name} к ${recipient.name}: ${data.content}`);
    });
    
    // Запрос истории групповых сообщений
    socket.on('getGroupChatHistory', () => {
        socket.emit('groupChatHistory', chatManager.getGroupMessages());
    });
    
    // Запрос истории приватных сообщений
    socket.on('getPrivateChatHistory', (userId) => {
        const user = userManager.getUserBySocketId(socket.id);
        if (!user) return;
        
        const messages = chatManager.getPrivateMessages(user.id, userId);
        
        socket.emit('privateChatHistory', {
            userId: userId,
            messages: messages
        });
    });
    
    // Обработка отключения
    socket.on('disconnect', () => {
        const user = userManager.getUserBySocketId(socket.id);
        if (user) {
            console.log(`Пользователь отключен: ${user.name} (${user.id})`);
            
            // Удаляем пользователя
            userManager.removeUser(user.id);
            
            // Отправляем информацию об отключении всем остальным
            io.emit('userDisconnected', user.id);
        }
    });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
