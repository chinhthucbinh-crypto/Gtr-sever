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
  // Thêm cột quyền admin / trạng thái khóa tài khoản (an toàn khi chạy lại nhiều lần).
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ban_reason TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value JSONB
    );
  `);
  console.log('✅ Đã kết nối PostgreSQL — dữ liệu sẽ không mất khi server khởi động lại.');
}

// 👉 Danh sách tài khoản admin — đặt biến môi trường ADMIN_USERNAMES trên Railway,
// cách nhau bằng dấu phẩy, ví dụ: ADMIN_USERNAMES=binh,chinhthuc
// Mỗi lần tài khoản trong danh sách này đăng nhập/đăng ký, hệ thống tự cấp quyền admin.
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '').split(',').map(s=>s.trim()).filter(Boolean);

async function autoPromoteIfAdmin(username){
  if(!hasDatabase) return;
  if(ADMIN_USERNAMES.includes(username)){
    await pool.query('UPDATE accounts SET is_admin=true WHERE username=$1', [username]);
  }
}

// Xác thực 1 request admin: kiểm tra đúng mật khẩu VÀ đúng là admin trước khi cho làm bất cứ gì.
// (Ứng dụng demo này không có hệ thống phiên đăng nhập/token, nên mỗi thao tác admin phải gửi
// lại đúng mật khẩu — đơn giản nhưng vẫn ngăn được người ngoài giả danh admin.)
async function verifyAdmin(username, password){
  if(!hasDatabase || !username || !password) return false;
  const r = await pool.query('SELECT password_hash, is_admin FROM accounts WHERE username=$1', [username]);
  if(r.rowCount === 0) return false;
  const row = r.rows[0];
  if(!row.is_admin) return false;
  return bcrypt.compare(password, row.password_hash);
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
    await autoPromoteIfAdmin(username);
    res.json({ ok:true, isAdmin: ADMIN_USERNAMES.includes(username) });
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
      const r = await pool.query('SELECT password_hash, banned, ban_reason, is_admin FROM accounts WHERE username=$1', [username]);
      account = r.rows[0] ? {
        passwordHash: r.rows[0].password_hash,
        banned: r.rows[0].banned,
        banReason: r.rows[0].ban_reason,
        isAdmin: r.rows[0].is_admin
      } : null;
    } else {
      account = memAccounts.get(username) || null;
    }
    if(!account) return res.status(404).json({ ok:false, error:'Tài khoản không tồn tại.' });

    const match = await bcrypt.compare(password, account.passwordHash);
    if(!match) return res.status(401).json({ ok:false, error:'Sai mật khẩu.' });

    if(account.banned){
      return res.status(403).json({
        ok:false,
        error: 'Tài khoản của bạn đã bị khóa vì vi phạm nội quy GTR' + (account.banReason ? `: ${account.banReason}` : '.')
      });
    }

    const now = Date.now();
    if(hasDatabase){
      await pool.query('UPDATE accounts SET last_seen=$1 WHERE username=$2', [now, username]);
    } else {
      memAccounts.get(username).lastSeen = now;
    }
    await autoPromoteIfAdmin(username);
    res.json({ ok:true, isAdmin: !!account.isAdmin || ADMIN_USERNAMES.includes(username) });
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
// API dành cho quản trị viên (admin). Mỗi request đều phải gửi lại đúng
// adminUsername + adminPassword để server tự xác thực lại (verifyAdmin) —
// ứng dụng demo này không có hệ thống phiên đăng nhập/token riêng, nên đây là
// cách đơn giản nhất để không cho người ngoài giả danh admin.
// ============================================================================

// Danh sách toàn bộ tài khoản, kèm trạng thái khóa/quyền admin — để hiển thị bảng quản lý người dùng.
app.post('/api/admin/users', async (req, res) => {
  try{
    const { adminUsername, adminPassword } = req.body || {};
    if(!(await verifyAdmin(adminUsername, adminPassword))){
      return res.status(403).json({ ok:false, error:'Không có quyền quản trị.' });
    }
    const r = await pool.query('SELECT username, last_seen, coins, is_admin, banned, ban_reason FROM accounts ORDER BY last_seen DESC');
    res.json({ ok:true, users: r.rows.map(row => ({
      username: row.username, lastSeen: Number(row.last_seen), coins: row.coins,
      isAdmin: row.is_admin, banned: row.banned, banReason: row.ban_reason
    })) });
  }catch(e){
    console.error('admin/users error:', e.message);
    res.status(500).json({ ok:false, error:'Lỗi server.' });
  }
});

// Khóa hoặc mở khóa 1 tài khoản. body: { adminUsername, adminPassword, targetUsername, banned, reason }
app.post('/api/admin/ban', async (req, res) => {
  try{
    const { adminUsername, adminPassword, targetUsername, banned, reason } = req.body || {};
    if(!(await verifyAdmin(adminUsername, adminPassword))){
      return res.status(403).json({ ok:false, error:'Không có quyền quản trị.' });
    }
    if(targetUsername === adminUsername){
      return res.status(400).json({ ok:false, error:'Không thể tự khóa chính mình.' });
    }
    await pool.query('UPDATE accounts SET banned=$1, ban_reason=$2 WHERE username=$3', [!!banned, reason || null, targetUsername]);
    res.json({ ok:true });
  }catch(e){
    console.error('admin/ban error:', e.message);
    res.status(500).json({ ok:false, error:'Lỗi server.' });
  }
});

// Chỉnh số dư GTR-Coin của 1 người chơi, kèm thông báo tùy chọn gửi thẳng vào hộp thư của họ.
// body: { adminUsername, adminPassword, targetUsername, coins, message }
app.post('/api/admin/set-coins', async (req, res) => {
  try{
    const { adminUsername, adminPassword, targetUsername, message } = req.body || {};
    const coins = Math.max(0, parseInt(req.body?.coins, 10) || 0);
    if(!(await verifyAdmin(adminUsername, adminPassword))){
      return res.status(403).json({ ok:false, error:'Không có quyền quản trị.' });
    }
    const exists = await pool.query('SELECT 1 FROM accounts WHERE username=$1', [targetUsername]);
    if(exists.rowCount === 0){
      return res.status(404).json({ ok:false, error:'Không tìm thấy người chơi này.' });
    }
    await pool.query('UPDATE accounts SET coins=$1 WHERE username=$2', [coins, targetUsername]);

    if(message){
      const key = `gtr_account:${targetUsername}`;
      const r = await pool.query('SELECT value FROM kv_store WHERE key=$1', [key]);
      const account = r.rows[0] ? r.rows[0].value : { coins, lastClaim: null, notifications: [] };
      account.notifications = account.notifications || [];
      account.notifications.unshift({
        id: Date.now(),
        text: `🛡️ Thông báo từ quản trị viên: ${message}`,
        time: new Date().toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Ho_Chi_Minh' }),
        read: false
      });
      await pool.query(
        'INSERT INTO kv_store (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
        [key, JSON.stringify(account)]
      );
    }
    res.json({ ok:true });
  }catch(e){
    console.error('admin/set-coins error:', e.message);
    res.status(500).json({ ok:false, error:'Lỗi server.' });
  }
});

// Chỉnh GTR-Coin + gửi thông báo cho TOÀN BỘ người chơi cùng lúc.
// body: { adminUsername, adminPassword, mode: 'set'|'add', amount, message }
// mode 'set' = đặt lại đúng bằng "amount" cho mọi người; mode 'add' = cộng/trừ thêm "amount" vào số hiện có.
app.post('/api/admin/broadcast', async (req, res) => {
  try{
    const { adminUsername, adminPassword, mode, message } = req.body || {};
    const amount = parseInt(req.body?.amount, 10) || 0;
    if(!(await verifyAdmin(adminUsername, adminPassword))){
      return res.status(403).json({ ok:false, error:'Không có quyền quản trị.' });
    }
    if(mode !== 'set' && mode !== 'add'){
      return res.status(400).json({ ok:false, error:'Thiếu kiểu áp dụng (set/add).' });
    }

    const usersRes = await pool.query('SELECT username, coins FROM accounts');
    const users = usersRes.rows;

    for(const u of users){
      const newCoins = Math.max(0, mode === 'set' ? amount : (u.coins + amount));
      await pool.query('UPDATE accounts SET coins=$1 WHERE username=$2', [newCoins, u.username]);

      if(message){
        const key = `gtr_account:${u.username}`;
        const r = await pool.query('SELECT value FROM kv_store WHERE key=$1', [key]);
        const account = r.rows[0] ? r.rows[0].value : { coins: newCoins, lastClaim: null, notifications: [] };
        account.notifications = account.notifications || [];
        account.notifications.unshift({
          id: Date.now() + Math.floor(Math.random()*1000),
          text: `📢 Thông báo từ GTR: ${message}`,
          time: new Date().toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Ho_Chi_Minh' }),
          read: false
        });
        await pool.query(
          'INSERT INTO kv_store (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
          [key, JSON.stringify(account)]
        );
      }
    }
    res.json({ ok:true, affected: users.length });
  }catch(e){
    console.error('admin/broadcast error:', e.message);
    res.status(500).json({ ok:false, error:'Lỗi server.' });
  }
});

// Danh sách các cuộc trò chuyện đang có (dựa trên các key gtr_chat:* trong kho chung) — để kiểm duyệt.
app.post('/api/admin/chats', async (req, res) => {
  try{
    const { adminUsername, adminPassword } = req.body || {};
    if(!(await verifyAdmin(adminUsername, adminPassword))){
      return res.status(403).json({ ok:false, error:'Không có quyền quản trị.' });
    }
    const r = await pool.query(`SELECT key, value FROM kv_store WHERE key LIKE 'gtr_chat:%'`);
    const chats = r.rows.map(row => {
      const pairKey = row.key.replace('gtr_chat:', '');
      const messages = Array.isArray(row.value) ? row.value : [];
      const reportedCount = messages.filter(m => m.reported).length;
      return {
        key: row.key,
        pair: pairKey,
        messageCount: messages.length,
        reportedCount,
        lastMessageAt: messages.length ? messages[messages.length-1].id : 0
      };
    }).sort((a,b) => b.lastMessageAt - a.lastMessageAt);
    res.json({ ok:true, chats });
  }catch(e){
    console.error('admin/chats error:', e.message);
    res.status(500).json({ ok:false, error:'Lỗi server.' });
  }
});

// Nội dung đầy đủ của 1 cuộc trò chuyện cụ thể — để đọc kiểm duyệt khi cần.
app.post('/api/admin/chat-detail', async (req, res) => {
  try{
    const { adminUsername, adminPassword, key } = req.body || {};
    if(!(await verifyAdmin(adminUsername, adminPassword))){
      return res.status(403).json({ ok:false, error:'Không có quyền quản trị.' });
    }
    if(!key || !key.startsWith('gtr_chat:')){
      return res.status(400).json({ ok:false, error:'Key không hợp lệ.' });
    }
    const r = await pool.query('SELECT value FROM kv_store WHERE key=$1', [key]);
    res.json({ ok:true, messages: r.rows[0] ? r.rows[0].value : [] });
  }catch(e){
    console.error('admin/chat-detail error:', e.message);
    res.status(500).json({ ok:false, error:'Lỗi server.' });
  }
});

// Xóa 1 game đã xuất bản khỏi thư viện chung (vi phạm nội quy / game rác).
app.post('/api/admin/delete-game', async (req, res) => {
  try{
    const { adminUsername, adminPassword, gameId } = req.body || {};
    if(!(await verifyAdmin(adminUsername, adminPassword))){
      return res.status(403).json({ ok:false, error:'Không có quyền quản trị.' });
    }
    const r = await pool.query(`SELECT value FROM kv_store WHERE key='gtr_games'`);
    const games = r.rows[0] ? r.rows[0].value : {};
    if(games && games[gameId]){
      delete games[gameId];
      await pool.query(`UPDATE kv_store SET value=$1 WHERE key='gtr_games'`, [JSON.stringify(games)]);
    }
    res.json({ ok:true });
  }catch(e){
    console.error('admin/delete-game error:', e.message);
    res.status(500).json({ ok:false, error:'Lỗi server.' });
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
