// garden.js — Vườn Cây 3D nhiều người chơi (Socket.IO)
//
// Cách gắn vào server GTR (file server chính, ngay sau khi tạo `io`):
//     require('./garden')(io);
//
// Module này chỉ THÊM sự kiện mới có tiền tố "garden_", không đụng gì tới
// các sự kiện cũ (join_game / move / chat bạn bè...), nên game đua và các phần khác vẫn chạy như cũ.
//
// Máy chủ chỉ chuyển tiếp thông tin giữa những người trong cùng phòng và kiểm tra dữ liệu hợp lệ.
// Xu / hạt giống / cây của mỗi người vẫn lưu ở /api/kv như trước.

module.exports = function attachGarden(io){
  const MAX_PLAYERS = 8;
  const SEED_IDS = new Set(['s1', 's2', 's3', 's4']);
  const TILE_KEY = /^[0-2]_[0-2]$/;
  const PHRASE_COUNT = 6; // khớp với GARDEN_QUICK_PHRASES trên client
  const EMOTE_COUNT = 6;  // khớp với GARDEN_EMOTES trên client

  const rooms = new Map(); // roomId -> Map(socketId -> player)
  let roomCounter = 0;

  const channel = (roomId) => 'garden:' + roomId;
  const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null; };
  const cleanColor = (v) => (Number.isInteger(v) && v >= 0 && v <= 0xFFFFFF) ? v : null;
  const cleanName = (v) => String(v || 'Khách').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || 'Khách';

  function cleanTiles(raw){
    const out = {};
    if(!raw || typeof raw !== 'object') return out;
    for(const key of Object.keys(raw)){
      if(!TILE_KEY.test(key)) continue;
      const t = raw[key];
      if(!t || !SEED_IDS.has(t.seedId)) continue;
      const age = num(t.age, 0, 1e7), pt = num(t.pt, 0, 1e15);
      if(age === null || pt === null) continue;
      out[key] = { seedId: t.seedId, age, pt };
    }
    return out;
  }
  function tilesAtNow(p, now){ // cộng thêm thời gian đã trôi qua kể từ lúc chủ vườn gửi
    const extra = (now - p.tilesAt) / 1000, out = {};
    for(const k of Object.keys(p.tiles)) out[k] = { seedId: p.tiles[k].seedId, age: p.tiles[k].age + extra, pt: p.tiles[k].pt };
    return out;
  }
  function publicView(p, now){
    return { id: p.id, username: p.username, slot: p.slot, outfit: p.outfit, x: p.x, z: p.z, ry: p.ry, tiles: tilesAtNow(p, now) };
  }
  function pickRoom(){
    for(const [id, members] of rooms){ if(members.size < MAX_PLAYERS) return id; }
    const id = 'V' + (++roomCounter).toString(36).toUpperCase();
    rooms.set(id, new Map());
    return id;
  }
  function freeSlot(members){
    const used = new Set(Array.from(members.values()).map(p => p.slot));
    for(let i = 0; i < MAX_PLAYERS; i++) if(!used.has(i)) return i;
    return -1;
  }

  io.on('connection', (socket) => {
    let roomId = null;
    const self = () => (roomId && rooms.get(roomId) && rooms.get(roomId).get(socket.id)) || null;

    socket.on('garden_join', (data) => {
      if(roomId) return; // đã ở trong phòng rồi
      data = data || {};
      const id = pickRoom(), members = rooms.get(id), slot = freeSlot(members);
      if(slot < 0) return;
      const o = data.outfit || {};
      const p = {
        id: socket.id, username: cleanName(data.username), slot,
        outfit: { head: cleanColor(o.head), torso: cleanColor(o.torso), limb: cleanColor(o.limb) },
        x: 0, z: 0, ry: 0,
        tiles: cleanTiles(data.tiles), tilesAt: Date.now(),
        lastMoveAt: 0, lastPlotsAt: 0, lastSayAt: 0, lastWaterAt: 0,
      };
      members.set(socket.id, p);
      roomId = id;
      socket.join(channel(id));
      const now = Date.now();
      const others = Array.from(members.values()).filter(m => m.id !== socket.id).map(m => publicView(m, now));
      socket.emit('garden_joined', { roomId: id, id: socket.id, slot, players: others });
      socket.to(channel(id)).emit('garden_player_joined', publicView(p, now));
    });

    socket.on('garden_move', (d) => {
      const p = self(); if(!p || !d) return;
      const now = Date.now();
      if(now - p.lastMoveAt < 45) return; // chống gửi quá dày
      const x = num(d.x, -60, 60), z = num(d.z, -60, 60), ry = num(d.ry, -20, 20);
      if(x === null || z === null || ry === null) return;
      p.lastMoveAt = now; p.x = x; p.z = z; p.ry = ry;
      socket.to(channel(roomId)).emit('garden_player_moved', { id: socket.id, x, z, ry });
    });

    socket.on('garden_plots', (d) => {
      const p = self(); if(!p || !d) return;
      const now = Date.now();
      if(now - p.lastPlotsAt < 150) return;
      p.lastPlotsAt = now;
      p.tiles = cleanTiles(d.tiles); p.tilesAt = now;
      socket.to(channel(roomId)).emit('garden_plots', { id: socket.id, tiles: p.tiles });
    });

    // Chat chỉ dùng câu có sẵn (gửi số thứ tự) → không có nội dung tự gõ, không cần lọc từ ngữ
    socket.on('garden_say', (d) => {
      const p = self(); if(!p || !d) return;
      const now = Date.now();
      if(now - p.lastSayAt < 1000) return;
      if(!Number.isInteger(d.p) || d.p < 0 || d.p >= PHRASE_COUNT) return;
      p.lastSayAt = now;
      socket.to(channel(roomId)).emit('garden_said', { id: socket.id, p: d.p });
    });
    socket.on('garden_emote', (d) => {
      const p = self(); if(!p || !d) return;
      const now = Date.now();
      if(now - p.lastSayAt < 1000) return;
      if(!Number.isInteger(d.e) || d.e < 0 || d.e >= EMOTE_COUNT) return;
      p.lastSayAt = now;
      socket.to(channel(roomId)).emit('garden_emoted', { id: socket.id, e: d.e });
    });

    // Tưới giúp: chỉ chuyển tiếp cho đúng chủ vườn trong cùng phòng
    socket.on('garden_water', (d) => {
      const p = self(); if(!p || !d) return;
      const now = Date.now();
      if(now - p.lastWaterAt < 800) return;
      if(typeof d.toId !== 'string' || !TILE_KEY.test(String(d.key))) return;
      const target = rooms.get(roomId).get(d.toId);
      if(!target || target.id === socket.id) return;
      p.lastWaterAt = now;
      io.to(target.id).emit('garden_watered', { fromId: socket.id, fromName: p.username, key: d.key });
    });

    socket.on('disconnect', () => {
      if(!roomId) return;
      const members = rooms.get(roomId);
      if(members){
        members.delete(socket.id);
        io.to(channel(roomId)).emit('garden_player_left', { id: socket.id });
        if(members.size === 0) rooms.delete(roomId);
      }
      roomId = null;
    });
  });
};
