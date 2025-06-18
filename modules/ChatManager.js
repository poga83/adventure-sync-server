class ChatManager {
    constructor() {
        this.groupMessages = []; // Хранит групповые сообщения
        this.privateMessages = new Map(); // Хранит приватные сообщения по паре ID пользователей
        
        // Ограничение на количество хранимых сообщений
        this.maxGroupMessages = 100;
        this.maxPrivateMessages = 50;
    }
    
    addGroupMessage(message) {
        // Добавляем сообщение в начало массива
        this.groupMessages.push(message);
        
        // Ограничиваем количество сообщений
        if (this.groupMessages.length > this.maxGroupMessages) {
            this.groupMessages = this.groupMessages.slice(-this.maxGroupMessages);
        }
        
        return message;
    }
    
    addPrivateMessage(message) {
        const senderId = message.senderId;
        const recipientId = message.recipientId;
        
        // Создаем уникальный ключ для пары пользователей
        const chatKey = this.getChatKey(senderId, recipientId);
        
        // Проверяем, есть ли уже сообщения для этой пары
        if (!this.privateMessages.has(chatKey)) {
            this.privateMessages.set(chatKey, []);
        }
        
        // Добавляем сообщение
        this.privateMessages.get(chatKey).push(message);
        
        // Ограничиваем количество сообщений
        const messages = this.privateMessages.get(chatKey);
        if (messages.length > this.maxPrivateMessages) {
            this.privateMessages.set(chatKey, messages.slice(-this.maxPrivateMessages));
        }
        
        return message;
    }
    
    getGroupMessages() {
        return this.groupMessages;
    }
    
    getPrivateMessages(userId1, userId2) {
        const chatKey = this.getChatKey(userId1, userId2);
        
        // Возвращаем сообщения или пустой массив, если их нет
        return this.privateMessages.get(chatKey) || [];
    }
    
    getChatKey(userId1, userId2) {
        // Создаем уникальный ключ для пары пользователей
        // Сортируем ID, чтобы ключ был одинаковым независимо от порядка
        return [userId1, userId2].sort().join('_');
    }
}

module.exports = ChatManager;
