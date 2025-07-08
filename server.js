const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Client } = require('pg');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// CORS
app.use(cors({
  origin: [
    'https://adventure-sync-client.vercel.app',
    'https://poga83.github.io',
    'http://localhost:3000'
  ],
  methods: ['GET','POST'],
  credentials: false
}));
app.use(express.json({limit:'10mb'}));
app.use(express.urlencoded({extended:true,limit:'10mb'}));

// PostgreSQL
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV==='production'
    ? { rejectUnauthorized: false }
    : false
});
async function initDatabase(){
  await client.connect();
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      socket_id TEXT UNIQUE,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'walking',
      position POINT,
      last_seen TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS trips (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      start_date DATE,
      end_date DATE,
      gathering_point POINT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      trip_id INT REFERENCES trips(id),
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tracks (
      id SERIAL PRIMARY KEY,
      trip_id INT REFERENCES trips(id),
      user_name TEXT,
      track_name TEXT,
      track_data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ DB ready');
}

// Health
app.get('/health',(req,res)=>res.json({
  status:'ok',time:new Date().toISOString()
}));

// API trips
app.post('/api/trips',async(req,res)=>{
  try{
    const {name,description,startDate,endDate,gatheringPoint} = req.body;
    const {rows} = await client.query(
      'INSERT INTO trips(name,description,start_date,end_date,gathering_point) VALUES($1,$2,$3,$4,POINT($5,$6)) RETURNING *',
      [name,description,startDate,endDate,gatheringPoint.lng,gatheringPoint.lat]
    );
    res.json(rows[0]);
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/trips',async(req,res)=>{
  try{
    const {rows} = await client.query('SELECT * FROM trips ORDER BY created_at DESC');
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

// Socket.IO
const io = new Server(server,{
  cors:{origin:['http://localhost:3000'],methods:['GET','POST']}
});
const activeUsers = new Map();
io.on('connection',socket=>{
  socket.emit('connectionConfirmed',{socketId:socket.id});
  socket.on('userConnected',async(data)=>{
    await client.query(
      'INSERT INTO users(socket_id,name,status) VALUES($1,$2,$3) ON CONFLICT(socket_id) DO UPDATE SET name=$2,status=$3,last_seen=NOW()',
      [socket.id,data.name,data.status]
    );
    activeUsers.set(socket.id,{...data,socketId:socket.id});
    const list = Array.from(activeUsers.values());
    io.emit('users',list);
  });
  socket.on('updatePosition',async(pos)=>{
    activeUsers.get(socket.id).position=pos;
    await client.query(
      'UPDATE users SET position=POINT($1,$2),last_seen=NOW() WHERE socket_id=$3',
      [pos.lng,pos.lat,socket.id]
    );
    socket.broadcast.emit('userPositionChanged',{userId:socket.id,position:pos});
  });
  socket.on('groupMessage',async(msg)=>{
    const user = activeUsers.get(socket.id);
    if(user){
      await client.query(
        'INSERT INTO messages(trip_id,sender_name,content) VALUES($1,$2,$3)',
        [msg.tripId,user.name,msg.content]
      );
      io.emit('groupMessage',{senderName:user.name,content:msg.content,timestamp:Date.now()});
    }
  });
  socket.on('joinTrip',tripId=>{
    socket.join(`trip_${tripId}`);
  });
  socket.on('saveTrack',async(track)=>{
    const user=activeUsers.get(socket.id);
    await client.query(
      'INSERT INTO tracks(trip_id,user_name,track_name,track_data) VALUES($1,$2,$3,$4)',
      [track.tripId,user.name,track.name,track.data]
    );
    socket.emit('trackSaved',{success:true});
  });
  socket.on('disconnect',async()=>{
    activeUsers.delete(socket.id);
    await client.query('UPDATE users SET last_seen=NOW() WHERE socket_id=$1',[socket.id]);
    io.emit('userDisconnected',socket.id);
  });
});

// Start
initDatabase().then(()=>{
  server.listen(PORT,'0.0.0.0',()=>console.log(`🚀 on port ${PORT}`));
});
