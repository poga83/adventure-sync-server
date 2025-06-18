class UserManager {
    constructor() {
        this.users = new Map(); // Хранит пользователей по их ID
        this.socketMap = new Map(); // Хранит соответствие socket.id -> user.id
    }
    
    addUser(userData) {
        // Добавляем пользователя в Map
        this.users.set(userData.id, userData);
        
        // Добавляем соответствие socket.id -> user.id
        this.socketMap.set(userData.socketId, userData.id);
        
        return userData;
    }
    
    removeUser(userId) {
        const user = this.users.get(userId);
        if (user) {
            // Удаляем соответствие socket.id -> user.id
            this.socketMap.delete(user.socketId);
            
            // Удаляем пользователя
            this.users.delete(userId);
        }
    }
    
    getUser(userId) {
        return this.users.get(userId);
    }
    
    getUserBySocketId(socketId) {
        const userId = this.socketMap.get(socketId);
        if (userId) {
            return this.users.get(userId);
        }
        return null;
    }
    
    getAllUsers() {
        return Array.from(this.users.values());
    }
    
    updateUserStatus(userId, status) {
        const user = this.users.get(userId);
        if (user) {
            user.status = status;
        }
    }
    
    updateUserPosition(userId, position) {
        const user = this.users.get(userId);
        if (user) {
            user.position = position;
        }
    }
}

module.exports = UserManager;
