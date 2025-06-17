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
const privateChats = new Map();
const groupMessages = [];
let meetupPoint = null;
const customMarkers = new Map();
const messageDeliveryStatus = new Map();

// Функция для сохранения пользовательской метки
function saveCustomMarker(markerData, userId) {
    const markerId = Date.now() + Math.random();
    const marker = {
        id: markerId,
        coordinates: markerData.coordinates,
        title: markerData.title,
        description: markerData.description,
        eventDate: markerData.eventDate,
        category: markerData.category,
        createdBy: userId,
        timestamp: new Date().toISOString()
    };
    
    customMarkers.set(markerId, marker);
    
    // Уведомляем всех пользователей о новой метке
    io.emit('markerUpdate', {
        action: 'add',
        marker: marker
    });
    
    return markerId;
}

// Функция для удаления метки
function deleteCustomMarker(markerId, userId) {
    const marker = customMarkers.get(markerId);
    if (marker && marker.createdBy === userId) {
        customMarkers.delete(markerId);
        io.emit('markerUpdate', {
            action: 'delete',
            markerId: markerId
        });
        return true;
    }
    return false;
}

// Функция для сохранения точки сбора
function saveMeetupPoint(point, setBy) {
    meetupPoint = {
        coordinates: point.coordinates,
        setBy: setBy,
        timestamp: new Date().toISOString(),
        description: point.description || 'Точка сбора'
    };
    
    io.emit('meetupPointUpdate', meetupPoint);
    console.log(`Точка сбора установлена пользователем ${setBy}:`, meetupPoint);
}

// Функция для расчета времени в пути по типу транспорта
function calculateTravelTime(distance, transportType) {
    const speeds = {
        '🏍️ Мото': 60,
        '🚲 Вело': 15,
        '🚶 Пешкодрали': 5,
        '☕ Чаи пинаю': 3,
        '🟢 Свободен': 50,
        '🔴 Не беспокоить': 40
    };
    
    const speed = speeds[transportType] || 40;
    return Math.round((distance / speed) * 60);
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

// Функция расчета расстояния между двумя точками
function calculateDistance(coords1, coords2) {
    const R = 6371;
    const dLat = (coords2[0] - coords1[0]) * Math.PI / 180;
    const dLon = (coords2[1] - coords1[1]) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(coords1[0] * Math.PI / 180) * Math.cos(coords2[0] * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
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
        
        // Отправляем все пользовательские метки
        socket.emit('allMarkers', Array.from(customMarkers.values()));
        
        // Отправляем историю группового чата
        socket.emit('groupChatHistory', groupMessages.slice(-50));
        
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

    // Создание пользовательской метки
    socket.on('createMarker', (markerData) => {
        const user = users.get(socket.id);
        if (user) {
            const markerId = saveCustomMarker(markerData, user.name);
            socket.emit('markerCreated', { id: markerId, success: true });
        }
    });

    // Удаление пользовательской метки
    socket.on('deleteMarker', (data) => {
        const success = deleteCustomMarker(data.markerId, socket.id);
        socket.emit('markerDeleted', { 
            markerId: data.markerId, 
            success: success 
        });
    });

    // Редактирование метки
    socket.on('editMarker', (data) => {
        const marker = customMarkers.get(data.markerId);
        if (marker && (marker.createdBy === users.get(socket.id)?.name)) {
            marker.title = data.title || marker.title;
            marker.description = data.description || marker.description;
            marker.eventDate = data.eventDate || marker.eventDate;
            marker.category = data.category || marker.category;
            
            io.emit('markerUpdate', {
                action: 'edit',
                marker: marker
            });
            
            socket.emit('markerEdited', { 
                markerId: data.markerId, 
                success: true 
            });
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
        
        users.forEach((user, userId) => {
            if (userId !== socket.id) {
                io.to(userId).emit('chat', messageData);
                messageData.deliveredTo.push(userId);
            }
        });
        
        socket.emit('messageDelivered', {
            messageId: messageData.id,
            deliveredCount: messageData.deliveredTo.length
        });
    });

    // Приватные сообщения
    socket.on('privateMessage', (data) => {
        const messageData = savePrivateMessage(socket.id, data.to, data.text);
        
        io.to(data.to).emit('privateMessage', {
            id: messageData.id,
            from: socket.id,
            text: data.text,
            timestamp: messageData.timestamp
        });
        
        const fromUser = users.get(socket.id);
        io.to(data.to).emit('showNotification', {
            title: `Сообщение от ${fromUser ? fromUser.name : 'Пользователя'}`,
            body: data.text,
            from: socket.id
        });
        
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
