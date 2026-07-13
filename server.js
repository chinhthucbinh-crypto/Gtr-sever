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
const cors = require('cors');
const http = require('http');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

// 👉 Chỉnh số này để đổi giới hạn người chơi mỗi phòng
const MAX_PLAYERS_PER_ROOM = 20;

const app = express();
app.use(cors());              // cho phép file game (chạy trên domain khác) gọi API này
app.use(express.json());      // đọc được JSON trong body của request
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// Lớp lưu trữ dữ liệu
//
// Nếu Railway có gắn addon PostgreSQL (biến môi trường DATABASE_URL tồn tại),
// server dùng PostgreSQL thật — dữ liệu KHÔNG mất khi container restart/redeploy.
// Nếu không có DATABASE_URL (ví dụ đang chạy `npm start` trên máy cá nhân chưa
// cài Postgres), server tự lùi về lưu tạm trong bộ nhớ (mất khi tắt server) —
// để bạn vẫn chạy thử được ngay mà không bắt buộc phải cài database trước.
// ============================================================================
const hasDatabase = !!process.env.DATABASE_URL;
let pool = null;

if(hasDatabase){
  const useSSL = !/localhost|127\.0\.0\.1|\.railway\.internal/.test(process.env.DATABASE_URL);
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false
  });
  pool.on('error', (err) => {
    console.error('❌ Lỗi kết nối PostgreSQL (idle client):', err.message);
  });
}

async function initDb(){
  if(!hasDatabase) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      last_seen BIGINT NOT NULL,
      coins INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value JSONB
    );
  `);
  console.log('✅ Đã kết nối PostgreSQL — dữ liệu sẽ không mất khi server khởi động lại.');
}

// ---- Bộ nhớ tạm dùng khi KHÔNG có PostgreSQL (chỉ để chạy thử cục bộ) ----
const memAccounts = new Map(); // username -> { passwordHash, lastSeen, coins }
const memKv = new Map();       // key -> value

// ============================================================================
// Accounts: đăng ký / đăng nhập / heartbeat / coins — mật khẩu luôn được băm
// bằng bcrypt NGAY TRÊN SERVER, không bao giờ nhận/so sánh mật khẩu thô đã xử
// lý sẵn từ phía trình duyệt.
// ============================================================================
app.get('/api/health', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if(!hasDatabase){
    return res.json({ ok:true, database: 'memory (không có DATABASE_URL)' });
  }
  try{
    await pool.query('SELECT 1');
    res.json({ ok:true, database: 'postgres (kết nối OK)' });
  }catch(e){
    res.status(500).json({ ok:false, database: 'postgres (LỖI KẾT NỐI)', error: e.message });
  }
});

app.post('/api/register', async (req, res) => {
  try{
    const username = (req.body?.username || '').toString().trim().slice(0, 24);
    const password = (req.body?.password || '').toString();
    if(!username || password.length < 4){
      return res.status(400).json({ ok:false, error:'Tên người dùng hoặc mật khẩu không hợp lệ.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const now = Date.now();

    if(hasDatabase){
      const exists = await pool.query('SELECT 1 FROM accounts WHERE username=$1', [username]);
      if(exists.rowCount > 0){
        return res.status(409).json({ ok:false, error:'Tên người dùng đã tồn tại.' });
      }
      await pool.query(
        'INSERT INTO accounts (username, password_hash, last_seen, coins) VALUES ($1,$2,$3,0)',
        [username, passwordHash, now]
      );
    } else {
      if(memAccounts.has(username)){
        return res.status(409).json({ ok:false, error:'Tên người dùng đã tồn tại.' });
      }
      memAccounts.set(username, { passwordHash, lastSeen: now, coins: 0 });
    }
    res.json({ ok:true });
  }catch(e){
    console.error('register error:', e.message);
    res.status(500).json({ ok:false, error:'Lỗi server, thử lại sau.' });
  }
});

app.post('/api/login', async (req, res) => {
  try{
    const username = (req.body?.username || '').toString().trim();
    const password = (req.body?.password || '').toString();

    let account;
    if(hasDatabase){
      const r = await pool.query('SELECT password_hash FROM accounts WHERE username=$1', [username]);
      account = r.rows[0] ? { passwordHash: r.rows[0].password_hash } : null;
    } else {
      account = memAccounts.get(username) || null;
    }
    if(!account) return res.status(404).json({ ok:false, error:'Tài khoản không tồn tại.' });

    const match = await bcrypt.compare(password, account.passwordHash);
    if(!match) return res.status(401).json({ ok:false, error:'Sai mật khẩu.' });

    const now = Date.now();
    if(hasDatabase){
      await pool.query('UPDATE accounts SET last_seen=$1 WHERE username=$2', [now, username]);
    } else {
      memAccounts.get(username).lastSeen = now;
    }
    res.json({ ok:true });
  }catch(e){
    console.error('login error:', e.message);
    res.status(500).json({ ok:false, error:'Lỗi server, thử lại sau.' });
  }
});

app.post('/api/heartbeat', async (req, res) => {
  try{
    const username = (req.body?.username || '').toString();
    const now = Date.now();
    if(hasDatabase){
      await pool.query('UPDATE accounts SET last_seen=$1 WHERE username=$2', [now, username]);
    } else if(memAccounts.has(username)){
      memAccounts.get(username).lastSeen = now;
    }
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});

app.post('/api/coins', async (req, res) => {
  try{
    const username = (req.body?.username || '').toString();
    const coins = Math.max(0, parseInt(req.body?.coins, 10) || 0);
    if(hasDatabase){
      await pool.query('UPDATE accounts SET coins=$1 WHERE username=$2', [coins, username]);
    } else if(memAccounts.has(username)){
      memAccounts.get(username).coins = coins;
    }
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});

// Dữ liệu công khai (KHÔNG bao giờ trả password_hash) — dùng cho bảng xếp hạng,
// kiểm tra tên đăng nhập tồn tại khi kết bạn, và trạng thái online/offline.
app.get('/api/accounts', async (req, res) => {
  try{
    res.set('Cache-Control', 'no-store');
    const out = {};
    if(hasDatabase){
      const r = await pool.query('SELECT username, last_seen, coins FROM accounts');
      r.rows.forEach(row => { out[row.username] = { lastSeen: Number(row.last_seen), coins: row.coins }; });
    } else {
      memAccounts.forEach((v, k) => { out[k] = { lastSeen: v.lastSeen, coins: v.coins }; });
    }
    res.json(out);
  }catch(e){
    console.error('accounts error:', e.message);
    res.status(500).json({ error: 'server error: ' + e.message });
  }
});

// ============================================================================
// Kho key-value dùng chung cho bạn bè / chat (không nhạy cảm như mật khẩu nên
// vẫn dùng chung 1 cơ chế đơn giản, giờ backed bởi Postgres thay vì file JSON).
// ============================================================================
app.get('/api/kv/:key', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const key = decodeURIComponent(req.params.key);
  try{
    if(hasDatabase){
      const r = await pool.query('SELECT value FROM kv_store WHERE key=$1', [key]);
      if(r.rowCount === 0) return res.status(404).json({ error:'not found' });
      return res.json({ key, value: r.rows[0].value });
    } else {
      if(!memKv.has(key)) return res.status(404).json({ error:'not found' });
      return res.json({ key, value: memKv.get(key) });
    }
  }catch(e){
    console.error('kv get error:', e.message);
    res.status(500).json({ error:'server error' });
  }
});

app.post('/api/kv/:key', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const key = decodeURIComponent(req.params.key);
  const value = req.body ? req.body.value : undefined;
  try{
    if(hasDatabase){
      await pool.query(
        'INSERT INTO kv_store (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
        [key, JSON.stringify(value)]
      );
    } else {
      memKv.set(key, value);
    }
    res.json({ ok:true });
  }catch(e){
    console.error('kv set error:', e.message);
    res.status(500).json({ ok:false });
  }
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

initDb()
  .then(() => {
    if(!hasDatabase){
      console.log('⚠️  Không thấy DATABASE_URL — đang chạy với bộ nhớ tạm (dữ liệu mất khi tắt server).');
      console.log('   Gắn addon PostgreSQL trên Railway để dữ liệu được lưu thật.');
    }
    server.listen(PORT, () => {
      console.log(`GTR server đang chạy tại http://localhost:${PORT}`);
      console.log(`Giới hạn ${MAX_PLAYERS_PER_ROOM} người chơi / phòng — tự động tạo phòng mới khi đầy.`);
    });
  })
  .catch((e) => {
    console.error('Không khởi tạo được database:', e.message);
    process.exit(1);
  });
        
