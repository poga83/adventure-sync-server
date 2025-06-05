const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let users = new Map();

io.on('connection', (socket) => {
  socket.on('register', (userData) => {
    users.set(socket.id, { ...userData, position: null });
    io.emit('users', Array.from(users.values()));
  });

  socket.on('position', (coords) => {
    const user = users.get(socket.id);
    if (user) {
      user.position = coords;
      io.emit('users', Array.from(users.values()));
    }
  });

  socket.on('disconnect', () => {
    users.delete(socket.id);
    io.emit('users', Array.from(users.values()));
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log('Server started');
});
