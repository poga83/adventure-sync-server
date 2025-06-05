import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let users = {};

io.on('connection', (socket) => {
  socket.on('register', (user) => {
    users[socket.id] = { ...user, id: socket.id };
    io.emit('users', Object.values(users));
  });

  socket.on('position', (coords) => {
    if (users[socket.id]) {
      users[socket.id].position = coords;
      io.emit('users', Object.values(users));
    }
  });

  socket.on('status', (status) => {
    if (users[socket.id]) {
      users[socket.id].status = status;
      io.emit('users', Object.values(users));
    }
  });

  socket.on('chat', (msg) => {
    io.emit('chat', { ...msg, time: new Date().toISOString() });
  });

  socket.on('disconnect', () => {
    delete users[socket.id];
    io.emit('users', Object.values(users));
  });
});

app.get('/', (req, res) => {
  res.send('Adventure Sync Server is running!');
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
