const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const UserManager = require('./modules/UserManager');
const ChatManager = require('./modules/ChatManager');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const userManager = new UserManager();
const chatManager = new ChatManager();

io.on('connection', (socket) => {
    console.log(`Новое подключение: ${socket.id}`);
    
    socket.on('userConnected', (userData) => {
        userData.socketId = socket.id;
        userManager.addUser(userData);
        socket.broadcast.emit('userConnected', userData);
        console.log(`Пользователь подключен: ${userData.name} (${userData.id})`);
    });
    
    socket.on('getUsers', () => {
        socket.emit('users', userManager.getAllUsers());
    });
    
    socket.on('updateStatus', (status) => {
        const user = userManager.getUserBySocketId(socket.id);
        if (user) {
            userManager.updateUserStatus(user.id, status);
            io.emit('userStatusChanged', {
                userId: user.id,
                status: status
            });
            console.log(`Статус пользователя обновлен: ${user.name} -> ${status}`);
        }
    });
    
    socket.on('updatePosition', (position) => {
        const user = userManager.getUserBySocketId(socket.id);
        if (user) {
            userManager.updateUserPosition(user.id, position);
            io.emit('userPositionChanged', {
                userId: user.id,
                position: position
            });
        }
    });
    
    socket.on('groupMessage', (message) => {
        chatManager.addGroupMessage(message);
        io.emit('groupMessage', message);
        console.log(`Групповое сообщение от ${message.senderName}: ${message.content}`);
    });
    
    socket.on('privateMessage', (data) => {
        const sender = userManager.getUserBySocketId(socket.id);
        if (!sender) return;
        
        const recipient = userManager.getUser(data.to);
        if (!recipient) return;
        
        const message = {
            senderId: sender.id,
            senderName: sender.name,
            recipientId: recipient.id,
            content: data.content,
            timestamp: new Date().toISOString()
        };
        
        chatManager.addPrivateMessage(message);
        
        if (recipient.socketId) {
            io.to(recipient.socketId).emit('privateMessage', message);
        }
        
        socket.emit('privateMessage', message);
        console.log(`Приватное сообщение от ${sender.name} к ${recipient.name}: ${data.content}`);
    });
    
    socket.on('getGroupChatHistory', () => {
        socket.emit('groupChatHistory', chatManager.getGroupMessages());
    });
    
    socket.on('getPrivateChatHistory', (userId) => {
        const user = userManager.getUserBySocketId(socket.id);
        if (!user) return;
        
        const messages = chatManager.getPrivateMessages(user.id, userId);
        
        socket.emit('privateChatHistory', {
            userId: userId,
            messages: messages
        });
    });
    
    socket.on('disconnect', () => {
        const user = userManager.getUserBySocketId(socket.id);
        if (user) {
            console.log(`Пользователь отключен: ${user.name} (${user.id})`);
            userManager.removeUser(user.id);
            io.emit('userDisconnected', user.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
