const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors:{ origin:"*", methods:["GET","POST"] }
});
app.use(cors());
app.use(express.json());

const users = new Map();
const privateChats = new Map();
const customMarkers = new Map();
const groupRoutes = new Map();

// Приватный чат
function getChatHistory(u1,u2){
  const key=[u1,u2].sort().join('-');
  return privateChats.get(key)||[];
}
function savePrivate(from,to,text){
  const key=[from,to].sort().join('-');
  if(!privateChats.has(key))privateChats.set(key,[]);
  const m={id:Date.now(),from,to,text,timestamp:new Date().toISOString()};
  privateChats.get(key).push(m);
  return m;
}

// Метки
function createMarker(data){
  const id=Date.now()+Math.random();
  const m={id,...data,timestamp:new Date().toISOString()};
  customMarkers.set(id,m);
  return m;
}

// Маршруты
function createGroupRoute(data,userId){
  const id=Date.now()+Math.random();
  const r={id,...data,creator:userId,participants:[userId],waypoints:[]};
  groupRoutes.set(id,r);
  return r;
}

io.on('connection',socket=>{
  socket.on('register',u=>{
    users.set(socket.id,{id:socket.id,name:u.name,status:u.status,position:u.position});
    io.emit('users',Array.from(users.values()));
    socket.emit('allMarkers',Array.from(customMarkers.values()));
  });

  socket.on('getChatHistory',d=>{
    socket.emit('chatHistory',{withUser:d.withUser,messages:getChatHistory(socket.id,d.withUser)});
  });
  socket.on('privateMessage',d=>{
    const m=savePrivate(socket.id,d.to,d.text);
    io.to(d.to).emit('privateMessage',m);
  });

  socket.on('createMarker',d=>{
    const m=createMarker(d);
    socket.emit('markerCreated',{success:true,marker:m});
    socket.broadcast.emit('markerCreated',{success:true,marker:m});
  });

  socket.on('createGroupRoute',d=>{
    const r=createGroupRoute(d,socket.id);
    io.emit('groupRouteUpdate',{action:'created',route:r});
  });
  socket.on('getGroupRoutes',()=>{
    socket.emit('groupRoutes',Array.from(groupRoutes.values()));
  });
  socket.on('joinGroupRoute',d=>{
    const r=groupRoutes.get(d.routeId);
    if(r&&!r.participants.includes(socket.id)){
      r.participants.push(socket.id);
      io.emit('groupRouteUpdate',{action:'userJoined',route:r,userId:socket.id});
    }
  });
  socket.on('addWaypointToRoute',d=>{
    const r=groupRoutes.get(d.routeId);
    if(r&&r.participants.includes(socket.id)){
      r.waypoints.push(d.waypoint);
      io.emit('routeWaypointAdded',{routeId:d.routeId,waypoint:d.waypoint});
    }
  });

  socket.on('position',coords=>{
    if(users.has(socket.id)){
      users.get(socket.id).position=coords;
      io.emit('users',Array.from(users.values()));
    }
  });

  socket.on('disconnect',()=>{
    users.delete(socket.id);
    io.emit('users',Array.from(users.values()));
  });
});

server.listen(3000,()=>console.log('Сервер запущен на 3000'))[5];
