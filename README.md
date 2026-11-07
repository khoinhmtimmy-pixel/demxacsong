# Đêm Xác Sống — bản co-op online

Game bắn zombie sinh tồn một-file, nay có **engine co-op thật** (host-authoritative) chạy qua một máy chủ nhỏ.

## Chạy game

```bash
npm install      # cài "ws" (chỉ 1 gói)
npm start        # http://localhost:8080
```

Mở **2 tab** (hoặc 2 máy trong cùng mạng LAN) → chọn chế độ **Cùng chiến** hoặc **Đấu trường** → nhập **cùng một mã phòng** → Bắt đầu.
Máy vào phòng đầu tiên làm **chủ phòng** (HOST), máy sau là **CLIENT**.

Trên mạng LAN, máy khác mở `http://<IP-máy-chủ>:8080` (IP in ra khi chạy `npm start`).

Nhấn **F3** trong game để xem bảng thông số mạng: ping, jitter, snapshot/giây, thời gian nội suy, số lần phải kéo vị trí.

## Kiến trúc

| Thành phần | Vai trò |
|---|---|
| `index.html` | Toàn bộ game (giữ nguyên, chỉ thêm vài điểm nối) |
| `net.js` | Engine co-op: dự đoán phía client, snapshot, nội suy, AOI |
| `server.js` | Phục vụ file tĩnh + relay gói tin + bầu chủ phòng |

Mô hình giống các battleground hiện đại (kiểu Chaos Battlegrounds) chứ không phải "gửi vị trí 12 lần/giây":

1. **Host-authoritative** — chủ phòng mô phỏng thế giới (quái, rương, sát thương) và phát **snapshot 20 Hz**. Client không tự quyết định hạ gục để tránh lệch trạng thái.
2. **Client-side prediction** — máy client vẫn chạy di chuyển của mình ngay lập tức, không chờ máy chủ, nên cảm giác điều khiển không bị trễ.
3. **Reconciliation** — khi snapshot của host về, client so vị trí thật với vị trí dự đoán: lệch nhỏ thì kéo êm (14×dt), lệch lớn (>200 px) mới đặt lại. Hết kiểu giật/teleport.
4. **Snapshot interpolation** — quái và rương được nội suy giữa hai snapshot với đệm ~100–160 ms (tự co giãn theo jitter), nên chuyển động mượt dù chỉ có 20 gói/giây.
5. **Quantize + AOI** — toạ độ gửi dạng số nguyên, chỉ gửi thực thể trong bán kính 1300 px quanh đồng đội, dữ liệu hiển thị (màu, hình dáng, tên boss) chỉ gửi **một lần** cho mỗi thực thể.
6. **Không nén gói tin** — `perMessageDeflate` tắt vì nén làm tăng trễ từng gói; gói tin vẫn nhỏ nhờ lượng tử hoá.
7. **Bầu lại chủ phòng** — host thoát thì máy kế tiếp lên làm chủ, phòng không chết.

## Đồng bộ trong co-op

- Quái, rương, vật phẩm, đòn của boss: do host quyết định, client chỉ hiển thị.
- Đạn của đồng đội: client gửi sự kiện bắn, host kiểm tra va chạm và cộng xu cho **đúng người hạ gục**.
- Xu, điểm, súng, nâng cấp, nhiệm vụ, rương: vẫn là tiến trình **riêng của từng máy** (lưu localStorage như cũ).
- Ngã xuống / cứu đồng đội: host giữ trạng thái, tín hiệu cứu đi qua server.
- Chế độ chơi đơn (không nhập mã phòng) chạy y như bản gốc, không phụ thuộc mạng.

## Đo hiệu năng & thử mạng xấu

Bấm **F3** trong trận để xem: ping, jitter, fps, thời gian mô phỏng/vẽ (ms), snapshot/giây, thời gian nội suy, số lần phải kéo vị trí, số quái/đạn.

- Mỗi giây một dòng số liệu được ghi lại; bấm **⬇ xuất CSV** để tải về (có p50/p95 ở cuối file).
- Giả lập mạng xấu (mặc định tắt):

```bash
node server.js --lag 60 --jitter 10 --loss 0.01                 # mạng thường
node server.js --lag 150 --jitter 30 --loss 0.03 --reorder 0.01  # mạng xấu
node server.js --lag 80 --loss 0.02 --trace docs/trace.csv       # ghi vết từng gói
```

Chỉ **snapshot** bị làm rơi/nhân bản/đảo thứ tự; input, sự kiện bắn, cứu đồng đội và chia thưởng luôn tới đủ (giống TCP thật, nơi mất gói là trễ chứ không phải mất thông điệp).

Quy trình đo đầy đủ, 7 kịch bản và ngưỡng đạt: xem `docs/qa.md`. Số đo hiện tại: `docs/baseline.md`.

## Kiểm thử

```bash
node server.js &                 # hoặc npm start ở cổng 8080
PORT=8090 node server.js &       # cổng riêng cho test
PORT=8090 node test/net-smoke.js
```

`npm test` chạy `test/netsim.js` — kiểm chứng bộ giả lập mạng (không cờ thì không thêm trễ, `--lag 60` tạo đúng trễ, `--loss` rơi đúng tỉ lệ, file `--trace` đúng định dạng).

`test/net-smoke.js` kiểm tra: vào phòng, bầu host, chuyển input client→host, phát snapshot host→client, sự kiện bắn, chia thưởng đúng người, đo ping, và bầu lại host khi host thoát.

## Ghi chú

- Chơi qua Internet cần mở cổng 8080 và dùng IP công khai / VPN (Tailscale, ZeroTier…) hoặc đặt sau reverse proxy có WebSocket.
- Server không mô phỏng game, chỉ relay — nên độ trễ thêm gần như bằng 0 so với kết nối trực tiếp.
- Nếu host có ping cao, client vẫn mượt khi di chuyển (nhờ dự đoán), nhưng quái sẽ phản ứng theo nhịp của host.
