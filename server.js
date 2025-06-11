const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

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

// Хранилища данных
const users = new Map();
const privateChats = new Map(); // Хранение истории приватных чатов
const groupMessages = []; // История группового чата
let meetupPoint = null; // Текущая точка сбора
const messageDeliveryStatus = new Map(); // Статусы доставки сообщений

// Функция для сохранения точки сбора
function saveMeetupPoint(point, setBy) {
    meetupPoint = {
        coordinates: point.coordinates,
        setBy: setBy,
        timestamp: new Date().toISOString(),
        description: point.description || 'Точка сбора'
    };
    
    // Уведомляем всех пользователей о новой точке сбора
    io.emit('meetupPointUpdate', meetupPoint);
    console.log(`Точка сбора установлена пользователем ${setBy}:`, meetupPoint);
}

// Функция для расчета времени в пути по типу транспорта
function calculateTravelTime(distance, transportType) {
    const speeds = {
        '🏍️ Мото': 90, // км/ч
        '🚲 Вело': 15,
        '🚶 Пешкодрали': 5,
        '🎤 Иду на концерт': 4,
        '☕ Чаи пинаю': 300,
        '🟢 Свободен': 50,
        '🔴 Не беспокоить': 40
    };
    
    const speed = speeds[transportType] || 40;
    return Math.round((distance / speed) * 60); // время в минутах
}

// Функция для получения истории чата
function getChatHistory(userId1, userId2) {
    const chatKey = [userId1, userId2].sort().join('-');
    return privateChats.get(chatKey) || [];
}

// Функция для сохранения сообщения в историю
function savePrivateMessage(fromId, toId, message) {
    const chatKey = [fromId, toId].sort().join('-');
    if (!privateChats.has(chatKey)) {
        privateChats.set(chatKey, []);
    }
    
    const messageData = {
        id: Date.now() + Math.random(),
        from: fromId,
        to: toId,
        text: message,
        timestamp: new Date().toISOString(),
        delivered: false,
        read: false
    };
    
    privateChats.get(chatKey).push(messageData);
    return messageData;
}

io.on('connection', (socket) => {
    console.log('Пользователь подключился:', socket.id);

    // Регистрация пользователя
    socket.on('register', (userData) => {
        users.set(socket.id, {
            id: socket.id,
            name: userData.name,
            status: userData.status,
            position: userData.position,
            lastSeen: new Date().toISOString()
        });
        
        // Отправляем текущую точку сбора новому пользователю
        if (meetupPoint) {
            socket.emit('meetupPointUpdate', meetupPoint);
        }
        
        // Отправляем историю группового чата
        socket.emit('groupChatHistory', groupMessages.slice(-50)); // последние 50 сообщений
        
        // Обновляем список пользователей для всех
        io.emit('users', Array.from(users.values()));
    });

    // Обновление позиции
    socket.on('position', (coords) => {
        const user = users.get(socket.id);
        if (user) {
            user.position = coords;
            user.lastSeen = new Date().toISOString();
            
            // Если есть точка сбора, рассчитываем время в пути
            if (meetupPoint && coords) {
                const distance = calculateDistance(coords, meetupPoint.coordinates);
                const travelTime = calculateTravelTime(distance, user.status);
                
                socket.emit('travelTimeUpdate', {
                    distance: distance,
                    time: travelTime,
                    transportType: user.status
                });
            }
            
            io.emit('users', Array.from(users.values()));
        }
    });

    // Установка точки сбора
    socket.on('setMeetupPoint', (pointData) => {
        const user = users.get(socket.id);
        if (user) {
            saveMeetupPoint(pointData, user.name);
        }
    });

    // Групповые сообщения
    socket.on('chat', (message) => {
        const messageData = {
            id: Date.now() + Math.random(),
            text: message.text,
            author: message.author,
            timestamp: message.timestamp,
            deliveredTo: []
        };
        
        groupMessages.push(messageData);
        
        // Отправляем сообщение всем пользователям
        users.forEach((user, userId) => {
            if (userId !== socket.id) {
                io.to(userId).emit('chat', messageData);
                messageData.deliveredTo.push(userId);
            }
        });
        
        // Подтверждение отправки автору
        socket.emit('messageDelivered', {
            messageId: messageData.id,
            deliveredCount: messageData.deliveredTo.length
        });
    });

    // Приватные сообщения
    socket.on('privateMessage', (data) => {
        const messageData = savePrivateMessage(socket.id, data.to, data.text);
        
        // Отправляем сообщение получателю
        io.to(data.to).emit('privateMessage', {
            id: messageData.id,
            from: socket.id,
            text: data.text,
            timestamp: messageData.timestamp
        });
        
        // Уведомление получателю
        const fromUser = users.get(socket.id);
        io.to(data.to).emit('showNotification', {
            title: `Сообщение от ${fromUser ? fromUser.name : 'Пользователя'}`,
            body: data.text,
            from: socket.id
        });
        
        // Подтверждение отправки
        socket.emit('messageDelivered', {
            messageId: messageData.id,
            to: data.to
        });
    });

    // Подтверждение прочтения сообщения
    socket.on('messageRead', (data) => {
        const chatKey = [socket.id, data.from].sort().join('-');
        const chatHistory = privateChats.get(chatKey);
        
        if (chatHistory) {
            const message = chatHistory.find(msg => msg.id === data.messageId);
            if (message) {
                message.read = true;
                message.readAt = new Date().toISOString();
                
                // Уведомляем отправителя о прочтении
                io.to(data.from).emit('messageReadConfirmation', {
                    messageId: data.messageId,
                    readBy: socket.id,
                    readAt: message.readAt
                });
            }
        }
    });

    // Запрос истории приватного чата
    socket.on('getChatHistory', (data) => {
        const history = getChatHistory(socket.id, data.withUser);
        socket.emit('chatHistory', {
            withUser: data.withUser,
            messages: history
        });
    });

    socket.on('disconnect', () => {
        users.delete(socket.id);
        io.emit('users', Array.from(users.values()));
        console.log('Пользователь отключился:', socket.id);
    });
});

// Функция расчета расстояния между двумя точками
function calculateDistance(coords1, coords2) {
    const R = 6371; // радиус Земли в км
    const dLat = (coords2[0] - coords1[0]) * Math.PI / 180;
    const dLon = (coords2[1] - coords1[1]) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(coords1[0] * Math.PI / 180) * Math.cos(coords2[0] * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
