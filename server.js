const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

class AdventureSyncServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = socketIo(this.server, {
            cors: {
                origin: process.env.CLIENT_URL || "*",
                methods: ["GET", "POST"],
                credentials: true
            },
            transports: ['websocket', 'polling']
        });

        // Хранилища данных
        this.users = new Map();
        this.rooms = new Map();
        this.markers = new Map();
        this.groupRoutes = new Map();
        this.chatHistory = new Map();
        this.privateChats = new Map();

        this.setupMiddleware();
        this.setupRoutes();
        this.setupSocketHandlers();
    }

    setupMiddleware() {
        // Безопасность
        this.app.use(helmet({
            contentSecurityPolicy: false,
            crossOriginEmbedderPolicy: false
        }));

        // CORS
        this.app.use(cors({
            origin: process.env.CLIENT_URL || "*",
            credentials: true
        }));

        // Rate limiting
        const limiter = rateLimit({
            windowMs: 15 * 60 * 1000, // 15 минут
            max: 100, // максимум 100 запросов с одного IP
            message: 'Слишком много запросов, попробуйте позже'
        });
        this.app.use('/api/', limiter);

        // JSON parsing
        this.app.use(express.json({ limit: '1mb' }));
        this.app.use(express.urlencoded({ extended: true }));

        // Статические файлы
        this.app.use(express.static(path.join(__dirname, 'public')));

        // Логирование
        this.app.use((req, res, next) => {
            console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
            next();
        });
    }

    setupRoutes() {
        // API маршруты
        this.app.get('/api/health', (req, res) => {
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                users: this.users.size,
                routes: this.groupRoutes.size,
                markers: this.markers.size
            });
        });

        this.app.get('/api/stats', (req, res) => {
            res.json({
                activeUsers: this.users.size,
                totalRoutes: this.groupRoutes.size,
                totalMarkers: this.markers.size,
                uptime: process.uptime()
            });
        });

        // Основной маршрут
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({ error: 'Маршрут не найден' });
        });

        // Error handler
        this.app.use((err, req, res, next) => {
            console.error('Server error:', err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        });
    }

    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            console.log(`Пользователь подключился: ${socket.id}`);

            // Регистрация пользователя
            socket.on('register', (data) => this.handleUserRegister(socket, data));

            // Обновление статуса
            socket.on('statusUpdate', (data) => this.handleStatusUpdate(socket, data));

            // Обновление местоположения
            socket.on('locationUpdate', (data) => this.handleLocationUpdate(socket, data));

            // Групповые сообщения
            socket.on('groupMessage', (data) => this.handleGroupMessage(socket, data));

            // Приватные сообщения
            socket.on('privateMessage', (data) => this.handlePrivateMessage(socket, data));

            // История чата
            socket.on('getChatHistory', (data) => this.handleGetChatHistory(socket, data));
            socket.on('getGroupChatHistory', () => this.handleGetGroupChatHistory(socket));

            // Маркеры
            socket.on('createMarker', (data) => this.handleCreateMarker(socket, data));
            socket.on('deleteMarker', (data) => this.handleDeleteMarker(socket, data));

            // Групповые маршруты
            socket.on('createGroupRoute', (data) => this.handleCreateGroupRoute(socket, data));
            socket.on('joinGroupRoute', (data) => this.handleJoinGroupRoute(socket, data));
            socket.on('leaveGroupRoute', (data) => this.handleLeaveGroupRoute(socket, data));
            socket.on('getGroupRoutes', () => this.handleGetGroupRoutes(socket));
            socket.on('addRouteWaypoint', (data) => this.handleAddRouteWaypoint(socket, data));

            // Отключение
            socket.on('disconnect', () => this.handleUserDisconnect(socket));

            // Обработка ошибок
            socket.on('error', (error) => {
                console.error(`Socket error for ${socket.id}:`, error);
            });
        });
    }

    handleUserRegister(socket, data) {
        try {
            if (!data.name || data.name.trim() === '') {
                socket.emit('error', { message: 'Имя пользователя обязательно' });
                return;
            }

            const user = {
                id: socket.id,
                name: this.sanitizeString(data.name),
                status: data.status || 'available',
                position: null,
                lastActivity: Date.now(),
                connectedAt: Date.now()
            };

            this.users.set(socket.id, user);
            
            // Отправка списка пользователей новому пользователю
            socket.emit('users', Array.from(this.users.values()));
            
            // Уведомление других пользователей
            socket.broadcast.emit('userJoined', user);

            console.log(`Пользователь зарегистрирован: ${user.name} (${socket.id})`);
            
        } catch (error) {
            console.error('Error in handleUserRegister:', error);
            socket.emit('error', { message: 'Ошибка регистрации пользователя' });
        }
    }

    handleStatusUpdate(socket, data) {
        try {
            const user = this.users.get(socket.id);
            if (!user) return;

            user.status = data.status;
            user.lastActivity = Date.now();
            
            this.io.emit('userStatusChanged', {
                userId: socket.id,
                status: data.status
            });

            console.log(`Статус пользователя ${user.name} изменен на: ${data.status}`);
            
        } catch (error) {
            console.error('Error in handleStatusUpdate:', error);
            socket.emit('error', { message: 'Ошибка обновления статуса' });
        }
    }

    handleLocationUpdate(socket, data) {
        try {
            const user = this.users.get(socket.id);
            if (!user) return;

            if (!this.isValidPosition(data.position)) {
                socket.emit('error', { message: 'Некорректные координаты' });
                return;
            }

            user.position = data.position;
            user.lastActivity = Date.now();
            
            // Отправка обновленного списка пользователей
            this.io.emit('users', Array.from(this.users.values()));

        } catch (error) {
            console.error('Error in handleLocationUpdate:', error);
            socket.emit('error', { message: 'Ошибка обновления местоположения' });
        }
    }

    handleGroupMessage(socket, data) {
        try {
            const user = this.users.get(socket.id);
            if (!user) return;

            if (!data.text || data.text.trim() === '') return;

            const message = {
                id: uuidv4(),
                text: this.sanitizeString(data.text),
                from: socket.id,
                fromName: user.name,
                timestamp: new Date().toISOString(),
                type: 'group'
            };

            // Сохранение в историю
            if (!this.chatHistory.has('group')) {
                this.chatHistory.set('group', []);
            }
            const history = this.chatHistory.get('group');
            history.push(message);
            
            // Ограничение истории (последние 100 сообщений)
            if (history.length > 100) {
                history.splice(0, history.length - 100);
            }

            this.io.emit('groupMessage', message);

        } catch (error) {
            console.error('Error in handleGroupMessage:', error);
            socket.emit('error', { message: 'Ошибка отправки сообщения' });
        }
    }

    handlePrivateMessage(socket, data) {
        try {
            const user = this.users.get(socket.id);
            const targetUser = this.users.get(data.to);
            
            if (!user || !targetUser) {
                socket.emit('error', { message: 'Пользователь не найден' });
                return;
            }

            if (!data.text || data.text.trim() === '') return;

            const message = {
                id: uuidv4(),
                text: this.sanitizeString(data.text),
                from: socket.id,
                fromName: user.name,
                to: data.to,
                toName: targetUser.name,
                timestamp: new Date().toISOString(),
                type: 'private'
            };

            // Сохранение в историю приватных сообщений
            const chatKey = this.getChatKey(socket.id, data.to);
            if (!this.privateChats.has(chatKey)) {
                this.privateChats.set(chatKey, []);
            }
            const history = this.privateChats.get(chatKey);
            history.push(message);
            
            // Ограничение истории
            if (history.length > 50) {
                history.splice(0, history.length - 50);
            }

            // Отправка сообщения получателю
            socket.to(data.to).emit('privateMessage', message);

        } catch (error) {
            console.error('Error in handlePrivateMessage:', error);
            socket.emit('error', { message: 'Ошибка отправки приватного сообщения' });
        }
    }

    handleGetChatHistory(socket, data) {
        try {
            const chatKey = this.getChatKey(socket.id, data.withUser);
            const messages = this.privateChats.get(chatKey) || [];
            
            socket.emit('chatHistory', {
                type: 'private',
                messages: messages.map(msg => ({
                    ...msg,
                    isOwn: msg.from === socket.id
                }))
            });

        } catch (error) {
            console.error('Error in handleGetChatHistory:', error);
            socket.emit('error', { message: 'Ошибка загрузки истории чата' });
        }
    }

    handleGetGroupChatHistory(socket) {
        try {
            const messages = this.chatHistory.get('group') || [];
            
            socket.emit('chatHistory', {
                type: 'group',
                messages: messages.map(msg => ({
                    ...msg,
                    isOwn: msg.from === socket.id
                }))
            });

        } catch (error) {
            console.error('Error in handleGetGroupChatHistory:', error);
            socket.emit('error', { message: 'Ошибка загрузки истории группового чата' });
        }
    }

    handleCreateMarker(socket, data) {
        try {
            const user = this.users.get(socket.id);
            if (!user) return;

            if (!data.title || !data.coordinates || !this.isValidPosition(data.coordinates)) {
                socket.emit('error', { message: 'Некорректные данные метки' });
                return;
            }

            const marker = {
                id: uuidv4(),
                title: this.sanitizeString(data.title),
                description: this.sanitizeString(data.description || ''),
                category: data.category || 'note',
                coordinates: data.coordinates,
                createdBy: user.name,
                createdById: socket.id,
                createdAt: new Date().toISOString()
            };

            this.markers.set(marker.id, marker);
            this.io.emit('markerCreated', { marker });

            console.log(`Метка создана: ${marker.title} пользователем ${user.name}`);

        } catch (error) {
            console.error('Error in handleCreateMarker:', error);
            socket.emit('error', { message: 'Ошибка создания метки' });
        }
    }

    handleDeleteMarker(socket, data) {
        try {
            const marker = this.markers.get(data.markerId);
            if (!marker) {
                socket.emit('error', { message: 'Метка не найдена' });
                return;
            }

            if (marker.createdById !== socket.id) {
                socket.emit('error', { message: 'Недостаточно прав для удаления метки' });
                return;
            }

            this.markers.delete(data.markerId);
            this.io.emit('markerDeleted', { markerId: data.markerId });

            console.log(`Метка удалена: ${marker.title}`);

        } catch (error) {
            console.error('Error in handleDeleteMarker:', error);
            socket.emit('error', { message: 'Ошибка удаления метки' });
        }
    }

    handleCreateGroupRoute(socket, data) {
        try {
            const user = this.users.get(socket.id);
            if (!user) return;

            if (!data.name || data.name.trim() === '') {
                socket.emit('error', { message: 'Название маршрута обязательно' });
                return;
            }

            const route = {
                id: uuidv4(),
                name: this.sanitizeString(data.name),
                description: this.sanitizeString(data.description || ''),
                type: data.type || 'public',
                maxParticipants: Math.min(Math.max(data.maxParticipants || 10, 2), 50),
                createdBy: user.name,
                createdById: socket.id,
                createdAt: new Date().toISOString(),
                participants: [socket.id],
                waypoints: []
            };

            this.groupRoutes.set(route.id, route);
            this.io.emit('routeCreated', route);

            console.log(`Групповой маршрут создан: ${route.name} пользователем ${user.name}`);

        } catch (error) {
            console.error('Error in handleCreateGroupRoute:', error);
            socket.emit('error', { message: 'Ошибка создания маршрута' });
        }
    }

    handleJoinGroupRoute(socket, data) {
        try {
            const user = this.users.get(socket.id);
            const route = this.groupRoutes.get(data.routeId);
            
            if (!user || !route) {
                socket.emit('error', { message: 'Маршрут не найден' });
                return;
            }

            if (route.participants.includes(socket.id)) {
                return; // Уже участник
            }

            if (route.participants.length >= route.maxParticipants) {
                socket.emit('error', { message: 'Маршрут переполнен' });
                return;
            }

            route.participants.push(socket.id);
            
            this.io.emit('routeJoined', {
                routeId: data.routeId,
                userId: socket.id,
                userName: user.name
            });

            console.log(`${user.name} присоединился к маршруту ${route.name}`);

        } catch (error) {
            console.error('Error in handleJoinGroupRoute:', error);
            socket.emit('error', { message: 'Ошибка присоединения к маршруту' });
        }
    }

    handleLeaveGroupRoute(socket, data) {
        try {
            const user = this.users.get(socket.id);
            const route = this.groupRoutes.get(data.routeId);
            
            if (!user || !route) return;

            const index = route.participants.indexOf(socket.id);
            if (index > -1) {
                route.participants.splice(index, 1);
                
                this.io.emit('routeLeft', {
                    routeId: data.routeId,
                    userId: socket.id,
                    userName: user.name
                });

                // Удаление маршрута если нет участников
                if (route.participants.length === 0) {
                    this.groupRoutes.delete(data.routeId);
                }
            }

        } catch (error) {
            console.error('Error in handleLeaveGroupRoute:', error);
            socket.emit('error', { message: 'Ошибка покидания маршрута' });
        }
    }

    handleGetGroupRoutes(socket) {
        try {
            const routes = Array.from(this.groupRoutes.values())
                .filter(route => route.type === 'public' || route.participants.includes(socket.id))
                .map(route => ({
                    ...route,
                    participants: route.participants.map(id => {
                        const user = this.users.get(id);
                        return user ? { id, name: user.name } : null;
                    }).filter(Boolean)
                }));

            socket.emit('groupRoutes', routes);

        } catch (error) {
            console.error('Error in handleGetGroupRoutes:', error);
            socket.emit('error', { message: 'Ошибка загрузки маршрутов' });
        }
    }

    handleAddRouteWaypoint(socket, data) {
        try {
            const route = this.groupRoutes.get(data.routeId);
            if (!route || !route.participants.includes(socket.id)) {
                socket.emit('error', { message: 'Недостаточно прав' });
                return;
            }

            if (!this.isValidPosition([data.waypoint.lat, data.waypoint.lng])) {
                socket.emit('error', { message: 'Некорректные координаты' });
                return;
            }

            const waypoint = {
                id: uuidv4(),
                lat: data.waypoint.lat,
                lng: data.waypoint.lng,
                addedBy: socket.id,
                addedAt: new Date().toISOString()
            };

            route.waypoints.push(waypoint);

            this.io.emit('routeWaypointAdded', {
                routeId: data.routeId,
                waypoint
            });

        } catch (error) {
            console.error('Error in handleAddRouteWaypoint:', error);
            socket.emit('error', { message: 'Ошибка добавления точки маршрута' });
        }
    }

    handleUserDisconnect(socket) {
        try {
            const user = this.users.get(socket.id);
            if (user) {
                console.log(`Пользователь отключился: ${user.name} (${socket.id})`);
                
                // Удаление пользователя из всех маршрутов
                this.groupRoutes.forEach((route, routeId) => {
                    const index = route.participants.indexOf(socket.id);
                    if (index > -1) {
                        route.participants.splice(index, 1);
                        if (route.participants.length === 0) {
                            this.groupRoutes.delete(routeId);
                        }
                    }
                });

                this.users.delete(socket.id);
                socket.broadcast.emit('userLeft', socket.id);
            }
        } catch (error) {
            console.error('Error in handleUserDisconnect:', error);
        }
    }

    // Утилиты
    sanitizeString(str) {
        if (typeof str !== 'string') return '';
        return str.trim().substring(0, 500).replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    }

    isValidPosition(position) {
        return Array.isArray(position) && 
               position.length === 2 && 
               typeof position[0] === 'number' && 
               typeof position[1] === 'number' &&
               position[0] >= -90 && position[0] <= 90 &&
               position[1] >= -180 && position[1] <= 180;
    }

    getChatKey(userId1, userId2) {
        return [userId1, userId2].sort().join('-');
    }

    start(port = 3000) {
        this.server.listen(port, () => {
            console.log(`🚀 Adventure Sync Server запущен на порту ${port}`);
            console.log(`📊 Статистика: http://localhost:${port}/api/stats`);
            console.log(`💚 Проверка работоспособности: http://localhost:${port}/api/health`);
        });

        // Graceful shutdown
        process.on('SIGTERM', () => {
            console.log('Получен сигнал SIGTERM, завершение работы сервера...');
            this.server.close(() => {
                console.log('Сервер остановлен');
                process.exit(0);
            });
        });

        process.on('SIGINT', () => {
            console.log('Получен сигнал SIGINT, завершение работы сервера...');
            this.server.close(() => {
                console.log('Сервер остановлен');
                process.exit(0);
            });
        });
    }
}

// Создание и запуск сервера
const server = new AdventureSyncServer();
const port = process.env.PORT || 3000;
server.start(port);

module.exports = AdventureSyncServer;
