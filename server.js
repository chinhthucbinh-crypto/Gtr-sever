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
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

// 👉 Chỉnh số này để đổi giới hạn người chơi mỗi phòng
const MAX_PLAYERS_PER_ROOM = 20;

const app = express();
app.use(cors());              // cho phép file game (chạy trên domain khác) gọi API này
app.use(express.json());      // đọc được JSON trong body của request
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------------------
// Kho lưu trữ dùng chung kiểu key-value — dùng cho tài khoản, bạn bè, chat.
// Lưu ra file data.json mỗi khi ghi, để dữ liệu còn sống sót qua các lần
// Railway khởi động lại container (restart/redeploy). Đây vẫn là lưu trữ đơn
// giản (1 file), phù hợp cho demo/vài trăm người dùng — không phải database
// thật cho quy mô lớn.
// ----------------------------------------------------------------------------
const DATA_FILE = path.join(__dirname, 'data.json');
let kvStore = {};
try{
  if(fs.existsSync(DATA_FILE)){
    kvStore = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
}catch(e){
  console.error('Không đọc được data.json, bắt đầu với kho trống:', e.message);
}
let saveQueued = false;
function persist(){
  if(saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    fs.writeFile(DATA_FILE, JSON.stringify(kvStore), (err) => {
      if(err) console.error('Lỗi lưu data.json:', err.message);
    });
  }, 250); // gộp các lần ghi liên tiếp lại, tránh ghi đĩa liên tục
}

app.get('/api/kv/:key', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const key = decodeURIComponent(req.params.key);
  if(!(key in kvStore)) return res.status(404).json({ error: 'not found' });
  res.json({ key, value: kvStore[key] });
});

app.post('/api/kv/:key', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const key = decodeURIComponent(req.params.key);
  kvStore[key] = req.body ? req.body.value : undefined;
  persist();
  res.json({ ok: true });
});

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

  // Tìm phòng còn chỗ trống, hoặc tạo phòng mới nếu tất cả đã đầy
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
    // dọn phòng trống để không tốn bộ nhớ / duyệt thừa
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

// player state hiện tại theo socket.id, để phát cho người mới vào phòng biết ai đang ở đó
const playerState = new Map(); // socketId -> { username, x, y, z, roomId }

// ----------------------------------------------------------------------------
// Endpoint kiểm tra nhanh tình trạng phòng (hữu ích để debug / màn hình admin)
// ----------------------------------------------------------------------------
app.get('/api/rooms', (req, res) => {
  res.json({ maxPerRoom: MAX_PLAYERS_PER_ROOM, rooms: roomManager.stats() });
});

// ----------------------------------------------------------------------------
// Socket.io — kết nối thời gian thực
// ----------------------------------------------------------------------------
io.on('connection', (socket) => {
  let roomId = null;

  socket.on('join_game', ({ username }) => {
    username = (username || 'Khách').toString().slice(0, 24);

    roomId = roomManager.assignRoom();
    roomManager.join(roomId, socket.id);
    socket.join(roomId);

    playerState.set(socket.id, { username, x: 0, y: 0, z: 0, roomId });

    // báo cho chính người này biết họ đã vào phòng nào, cùng ai
    const others = [...roomManager.rooms.get(roomId)]
      .filter((id) => id !== socket.id)
      .map((id) => ({ id, ...playerState.get(id) }));

    socket.emit('joined', {
      roomId,
      playerCount: roomManager.roomSize(roomId),
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      players: others
    });

    // báo cho những người còn lại trong phòng biết có người mới vào
    socket.to(roomId).emit('player_joined', { id: socket.id, username });

    console.log(`[${roomId}] ${username} vào phòng (${roomManager.roomSize(roomId)}/${MAX_PLAYERS_PER_ROOM})`);
  });

  // đồng bộ vị trí người chơi trong game 3D — chỉ gửi trong cùng phòng, không gửi toàn server
  socket.on('move', (pos) => {
    if (!roomId) return;
    const state = playerState.get(socket.id);
    if (!state) return;
    state.x = pos.x; state.y = pos.y; state.z = pos.z;
    socket.to(roomId).emit('player_moved', { id: socket.id, x: pos.x, y: pos.y, z: pos.z });
  });

  // chat trong phòng
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
