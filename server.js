// ============================================================================
// GTR Realtime Server
// Node.js + Express + Socket.io
//
// Điểm quan trọng nhất trong file này: RoomManager — bộ chia phòng (instance).
// Thay vì nhồi TẤT CẢ người chơi vào một thế giới chung, server tự động chia
// họ thành nhiều phòng song song, mỗi phòng chỉ chứa tối đa MAX_PLAYERS_PER_ROOM
// người. Đây chính là cách các game như Roblox/Minecraft Realms xử lý số đông.
// ============================================================================

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

// 👉 Chỉnh số này để đổi giới hạn người chơi mỗi phòng
const MAX_PLAYERS_PER_ROOM = 20;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // demo only — siết lại domain cụ thể khi triển khai thật
});

// ----------------------------------------------------------------------------
// RoomManager: quản lý danh sách phòng, tự tạo phòng mới khi phòng hiện tại đầy
// ----------------------------------------------------------------------------
class RoomManager {
  constructor(maxPerRoom) {
    this.maxPerRoom = maxPerRoom;
    this.rooms = new Map(); // roomId -> Set(socketId)
    this.nextRoomIndex = 1;
  }

  assignRoom() {
    for (const [roomId, players] of this.rooms) {
      if (players.size < this.maxPerRoom) return roomId;
    }
    const roomId = `room-${this.nextRoomIndex++}`;
    this.rooms.set(roomId, new Set());
    return roomId;
  }

  join(roomId, socketId) {
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, new Set());
    this.rooms.get(roomId).add(socketId);
  }

  leave(roomId, socketId) {
    const players = this.rooms.get(roomId);
    if (!players) return;
    players.delete(socketId);
    if (players.size === 0) this.rooms.delete(roomId);
  }

  roomSize(roomId) {
    return this.rooms.get(roomId)?.size || 0;
  }

  stats() {
    return Array.from(this.rooms.entries()).map(([roomId, players]) => ({
      roomId,
      players: players.size,
      max: this.maxPerRoom
    }));
  }
}

const roomManager = new RoomManager(MAX_PLAYERS_PER_ROOM);
const playerState = new Map();

app.get('/api/rooms', (req, res) => {
  res.json({ maxPerRoom: MAX_PLAYERS_PER_ROOM, rooms: roomManager.stats() });
});

io.on('connection', (socket) => {
  let roomId = null;

  socket.on('join_game', ({ username }) => {
    username = (username || 'Khách').toString().slice(0, 24);

    roomId = roomManager.assignRoom();
    roomManager.join(roomId, socket.id);
    socket.join(roomId);

    playerState.set(socket.id, { username, x: 0, y: 0, z: 0, roomId });

    const others = [...roomManager.rooms.get(roomId)]
      .filter((id) => id !== socket.id)
      .map((id) => ({ id, ...playerState.get(id) }));

    socket.emit('joined', {
      roomId,
      playerCount: roomManager.roomSize(roomId),
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      players: others
    });

    socket.to(roomId).emit('player_joined', { id: socket.id, username });

    console.log(`[${roomId}] ${username} vào phòng (${roomManager.roomSize(roomId)}/${MAX_PLAYERS_PER_ROOM})`);
  });

  socket.on('move', (pos) => {
    if (!roomId) return;
    const state = playerState.get(socket.id);
    if (!state) return;
    state.x = pos.x; state.y = pos.y; state.z = pos.z;
    socket.to(roomId).emit('player_moved', { id: socket.id, x: pos.x, y: pos.y, z: pos.z });
  });

  socket.on('chat', (text) => {
    if (!roomId) return;
    const state = playerState.get(socket.id);
    if (!state) return;
    const safeText = (text || '').toString().slice(0, 300);
    io.to(roomId).emit('chat', { username: state.username, text: safeText, time: Date.now() });
  });

  socket.on('disconnect', () => {
    if (!roomId) return;
    roomManager.leave(roomId, socket.id);
    playerState.delete(socket.id);
    socket.to(roomId).emit('player_left', { id: socket.id });
    console.log(`[${roomId}] người chơi rời phòng (còn ${roomManager.roomSize(roomId)})`);
  });
});

server.listen(PORT, () => {
  console.log(`GTR server đang chạy tại http://localhost:${PORT}`);
  console.log(`Giới hạn ${MAX_PLAYERS_PER_ROOM} người chơi / phòng — tự động tạo phòng mới khi đầy.`);
});
