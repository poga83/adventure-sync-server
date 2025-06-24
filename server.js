const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors({ origin:'*', credentials:true }));
app.get('/health',(req,res)=>res.json({status:'ok'}));

const server = http.createServer(app);
const io = new Server(server,{
  cors:{ origin:'*', credentials:true },
  transports:['websocket','polling']
});

io.on('connection', socket => {
  socket.emit('connectionConfirmed',{time:Date.now()});
  socket.on('updateStatus', data=>{
    io.emit('userStatusChanged',data);
  });
  socket.on('disconnect',()=>{});
});

server.listen(process.env.PORT||3000,()=>console.log('Server up'));
