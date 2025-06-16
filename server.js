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
app.use(express.static('public'));

// Хранилища данных
const users = new Map();
const privateChats = new Map();
const groupMessages = [];
const customMarkers = new Map();
const groupRoutes = new Map();

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
        timestamp: new Date().toISOString()
    };
    
    privateChats.get(chatKey).push(messageData);
    return messageData;
}

// Функция для создания метки
function createCustomMarker(markerData, userId) {
    const markerId = Date.now() + Math.random();
    const marker = {
        id: markerId,
        coordinates: markerData.coordinates,
        title: markerData.title,
        description: markerData.description,
        category: markerData.category,
        createdBy: markerData.createdBy,
        timestamp: new Date().toISOString()
    };
    
    customMarkers.set(markerId, marker);
    return marker;
}

// Функция для создания группового маршрута
function createGroupRoute(routeData, userId) {
    const routeId = Date.now() + Math.random();
    const route = {
        id: routeId,
        name: routeData.name,
        description: routeData.description,
        type: routeData.type,
        creator: routeData.creator,
        createdBy: userId,
        waypoints: routeData.waypoints || [],
        participants: [userId],
        timestamp: new Date().toISOString()
    };
    
    groupRoutes.set(routeId, route);
    return route;
}

// Функция для оптимизации маршрута
function optimizeRoute(waypoints) {
    // Здесь можно реализовать алгоритм оптимизации маршрута
    // Например, алгоритм ближайшего соседа или другие алгоритмы для решения задачи коммивояжера
    // В данном примере просто возвращаем исходные точки
    return waypoints;
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
        
        // Отправляем все кастомные метки
        socket.emit('allMarkers', Array.from(customMarkers.values()));
        
        // Отправляем историю группового чата
        socket.emit('groupChatHistory', groupMessages.slice(-50));
        
        // Обновляем список пользователей для всех
        io.emit('users', Array.from(users.values()));
        
        console.log(`Пользователь ${userData.name} зарегистрирован`);
    });

    // Обновление позиции
    socket.on('position', (coords) => {
        const user = users.get(socket.id);
        if (user) {
            user.position = coords;
            user.lastSeen = new Date().toISOString();
            io.emit('users', Array.from(users.values()));
        }
    });

    // Создание метки
    socket.on('createMarker', (markerData) => {
        try {
            const marker = createCustomMarker(markerData, socket.id);
            socket.emit('markerCreated', { 
                success: true, 
                marker: marker 
            });
            
            // Уведомляем всех пользователей о новой метке
            socket.broadcast.emit('markerCreated', { 
                success: true, 
                marker: marker 
            });
            
            console.log(`Метка "${markerData.title}" создана пользователем ${markerData.createdBy}`);
        } catch (error) {
            console.error('Ошибка создания метки:', error);
            socket.emit('markerCreated', { success: false, error: error.message });
        }
    });

    // Групповые сообщения
    socket.on('chat', (message) => {
        const messageData = {
            id: Date.now() + Math.random(),
            text: message.text,
            author: message.author,
            timestamp: message.timestamp
        };
        
        groupMessages.push(messageData);
        
        // Ограничиваем историю до 100 сообщений
        if (groupMessages.length > 100) {
            groupMessages.shift();
        }
        
        io.emit('chat', messageData);
        console.log(`Сообщение от ${message.author}: ${message.text}`);
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
        
        console.log(`Приватное сообщение от ${socket.id} к ${data.to}`);
    });

    // Запрос истории приватного чата
    socket.on('getChatHistory', (data) => {
        const history = getChatHistory(socket.id, data.withUser);
        socket.emit('chatHistory', {
            withUser: data.withUser,
            messages: history
        });
    });

    // Создание группового маршрута
    socket.on('createGroupRoute', (routeData) => {
        try {
            const route = createGroupRoute(routeData, socket.id);
            
            socket.emit('groupRouteUpdate', {
                action: 'created',
                route: route
            });
            
            // Уведомляем всех о новом маршруте если он публичный
            if (route.type === 'public') {
                socket.broadcast.emit('groupRouteUpdate', {
                    action: 'created',
                    route: route
                });
            }
            
            console.log(`Групповой маршрут "${routeData.name}" создан пользователем ${routeData.creator}`);
        } catch (error) {
            console.error('Ошибка создания группового маршрута:', error);
        }
    });

    // Получение списка групповых маршрутов
    socket.on('getGroupRoutes', () => {
        const routes = Array.from(groupRoutes.values())
            .filter(route => route.type === 'public' || route.participants.includes(socket.id));
        socket.emit('groupRoutes', routes);
    });

    // Присоединение к групповому маршруту
    socket.on('joinGroupRoute', (data) => {
        const route = groupRoutes.get(data.routeId);
        if (route && !route.participants.includes(socket.id)) {
            route.participants.push(socket.id);
            
            // Уведомляем участников маршрута
            route.participants.forEach(participantId => {
                io.to(participantId).emit('groupRouteUpdate', {
                    action: 'userJoined',
                    route: route,
                    userId: socket.id
                });
            });
            
            console.log(`Пользователь ${socket.id} присоединился к маршруту ${route.name}`);
        }
    });

    // Покидание группового маршрута
    socket.on('leaveGroupRoute', (data) => {
        const route = groupRoutes.get(data.routeId);
        if (route) {
            route.participants = route.participants.filter(id => id !== socket.id);
            
            // Уведомляем участников маршрута
            route.participants.forEach(participantId => {
                io.to(participantId).emit('groupRouteUpdate', {
                    action: 'userLeft',
                    route: route,
                    userId: socket.id
                });
            });
            
            console.log(`Пользователь ${socket.id} покинул маршрут ${route.name}`);
        }
    });

        // Добавление точки к групповому маршруту
    socket.on('addWaypointToRoute', (data) => {
        const route = groupRoutes.get(data.routeId);
        if (route && route.participants.includes(socket.id)) {
            route.waypoints.push(data.waypoint);
            
            // Оптимизируем маршрут при необходимости
            if (route.waypoints.length > 2) {
                route.waypoints = optimizeRoute(route.waypoints);
            }
            
            // Уведомляем всех участников маршрута
            route.participants.forEach(participantId => {
                io.to(participantId).emit('routeWaypointAdded', {
                    routeId: data.routeId,
                    waypoint: data.waypoint
                });
            });
            
            console.log(`Добавлена точка к маршруту ${route.name} пользователем ${data.waypoint.addedBy}`);
        }
    });

    // Отключение пользователя
    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user) {
            console.log(`Пользователь ${user.name} отключился`);
        }
        
        users.delete(socket.id);
        
        // Удаляем пользователя из всех групповых маршрутов
        groupRoutes.forEach(route => {
            if (route.participants.includes(socket.id)) {
                route.participants = route.participants.filter(id => id !== socket.id);
            }
        });
        
        io.emit('users', Array.from(users.values()));
    });
});
// Исправленный код для server.js
io.on('connection', (socket) => {
    console.log('Пользователь подключился:', socket.id);

    // Регистрация пользователя
    socket.on('register', (userData) => {
        // Добавляем пользователя в Map
        users.set(socket.id, {
            id: socket.id,
            name: userData.name,
            status: userData.status,
            position: userData.position,
            lastSeen: new Date().toISOString()
        });
        
        // Важно: отправляем обновленный список ВСЕМ клиентам
        io.emit('users', Array.from(users.values()));
        
        console.log(`Пользователь ${userData.name} зарегистрирован`);
        console.log(`Всего пользователей: ${users.size}`);
    });

    // Обновление позиции
    socket.on('position', (coords) => {
        const user = users.get(socket.id);
        if (user) {
            user.position = coords;
            user.lastSeen = new Date().toISOString();
            // Отправляем обновленный список ВСЕМ клиентам
            io.emit('users', Array.from(users.values()));
        }
    });

    // Отключение пользователя
    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user) {
            console.log(`Пользователь ${user.name} отключился`);
        }
        
        users.delete(socket.id);
        
        // Отправляем обновленный список ВСЕМ клиентам
        io.emit('users', Array.from(users.values()));
    });
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Adventure Sync сервер запущен на порту ${PORT}`);
    console.log('Функции сервера:');
    console.log('- Регистрация и отслеживание пользователей');
    console.log('- Групповой и приватный чат');
    console.log('- Создание и управление метками');
    console.log('- Групповые маршруты с совместным редактированием');
});
