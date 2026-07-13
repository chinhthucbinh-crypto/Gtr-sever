// Service worker tối giản cho GTR PWA.
// Cố tình KHÔNG cache API/dữ liệu động (tài khoản, bạn bè, chat, phòng chơi...) — chỉ tồn tại
// để trình duyệt công nhận trang là một PWA hợp lệ, đủ điều kiện "Cài đặt ứng dụng".
// Mọi request đều đi thẳng ra mạng như bình thường (network passthrough), không can thiệp.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Không làm gì cả — để trình duyệt tự xử lý request như bình thường.
  // (Không gọi event.respondWith(...) nghĩa là hành vi mạng mặc định được giữ nguyên.)
});

