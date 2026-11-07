# Baseline hiệu năng — Đêm Xác Sống

Nguyên tắc: **không tuyên bố nhanh hơn nếu không có số**. Mọi thay đổi hiệu năng phải
điền vào bảng dưới, kèm file CSV gốc.

## Trạng thái công cụ

| Thành phần | Trạng thái |
|---|---|
| Bảng F3 (ping, fps, sim/draw ms, snap/s, interp, corr) | ✅ đã có |
| Xuất CSV mỗi giây + p50/p95 | ✅ đã có (`⬇ xuất CSV` trong F3) |
| Giả lập mạng xấu trong `server.js` (`--lag/--jitter/--loss/--dup/--reorder`) | ✅ đã có |
| Vết gói tin ra CSV (`--trace`) | ✅ đã có |
| Kiểm chứng bộ giả lập (`test/netsim.js`) | ✅ tự động |
| **Số đo thực tế trên trình duyệt** | ⛔ **chưa đo** — cần tab hiển thị thật |

## Bảng đo

Mỗi dòng: chạy kịch bản trong `docs/qa.md`, xuất CSV từ F3, điền p95.

| Kịch bản | Mức mạng | fps p50 | draw p95 (ms) | sim p95 (ms) | KB/s p95 | corr | Ghi chú |
|---|---|---|---|---|---|---|---|
| S1 · 150 quái | LAN | chưa đo | chưa đo | chưa đo | chưa đo | chưa đo | |
| S1 · 150 quái | Thường (60 ms) | chưa đo | chưa đo | chưa đo | chưa đo | chưa đo | |
| S1 · 150 quái | Xấu (150 ms) | chưa đo | chưa đo | chưa đo | chưa đo | chưa đo | |
| S2 · Boss | LAN | chưa đo | chưa đo | chưa đo | chưa đo | chưa đo | |
| S6 · 10k đạn | LAN | chưa đo | chưa đo | chưa đo | chưa đo | chưa đo | |
| S7 · 30 phút | LAN | chưa đo | chưa đo | chưa đo | chưa đo | chưa đo | heap cuối: ? |

## Ngưỡng đạt

- `draw p95` < 16 ms khi 150 quái.
- `KB/s p95` < 35 KB/s mỗi client (mục tiêu của netcode v2; hiện tại JSON nên sẽ cao hơn).
- `corr` < 20 lần/phút ở mức Thường.
- Heap sau 30 phút không tăng đơn điệu (dao động < 20 %).

## Lịch sử

| Ngày | Thay đổi | Trước | Sau |
|---|---|---|---|
| — | (trống, chờ lần đo đầu tiên) | — | — |
