# QA — "Chứng minh là không lag"

Mục tiêu: mọi tuyên bố "đã hết lag" phải kèm **số đo**, không phải cảm giác.

## 1. Ba mức chất lượng mạng

| Mức | Điều kiện | Đạt khi |
|---|---|---|
| LAN | RTT < 5 ms, 0 % mất gói | không giật; `corr` < 5 lần/phút; quái trễ ≤ 1 snapshot |
| Thường | 60 ms, 1 % mất gói | di chuyển mượt; không teleport; `corr` < 20/phút |
| Xấu | 150 ms, 3 % mất gói, jitter 30 ms | vẫn chơi được; không lệch trạng thái; `corr` < 60/phút |

## 2. Chạy từng mức

```bash
# LAN — không giả lập gì
npm start

# Thường — 60ms, 1% mất snapshot, jitter 10ms
node server.js --lag 60 --jitter 10 --loss 0.01 --trace docs/trace-thuong.csv

# Xấu — 150ms, 3% mất snapshot, jitter 30ms, đảo thứ tự 1%
node server.js --lag 150 --jitter 30 --loss 0.03 --reorder 0.01 --trace docs/trace-xau.csv
```

Cờ có sẵn: `--lag` (ms), `--jitter` (± ms), `--loss` (0–1), `--dup` (0–1), `--reorder` (0–1), `--trace` (file CSV).

**Quy tắc quan trọng:** chỉ **snapshot** bị bỏ/nhân bản/đảo thứ tự. Input, sự kiện bắn, cứu đồng đội và chia thưởng luôn tới đủ — vì trên TCP thật, mất gói là *trễ* chứ không phải *mất thông điệp*. Bỏ chúng đi sẽ là test một lỗi không tồn tại.

Server in ra mỗi 10 giây: số gói, số bỏ, trễ trung bình, KB — đủ để biết bộ giả lập có đang chạy đúng.

## 3. Lấy số trong game

1. Vào trận co-op, bấm **F3** → hiện bảng: ping, jitter, fps, sim ms, draw ms, snap/s, interp, `corr`, số quái/đạn.
2. Mỗi giây một dòng được ghi lại (tối đa 2 giờ).
3. Bấm **⬇ xuất CSV** → tải `netmetrics-<thời gian>.csv`: mỗi giây một dòng, có fps/sim/draw/KB/corr/heap, cuối file là p50/p95 và số phút đã đo.
4. Dán số p95 vào bảng ở mục 5 và vào `docs/baseline.md`.

## 4. Bảy kịch bản (3 phút mỗi cái, cùng seed)

| ID | Kịch bản | Câu hỏi | Kết quả |
|---|---|---|---|
| S1 | 150 quái, bắn liên tục | p95 frame time, KB/s | chưa đo |
| S2 | Boss + đòn diện rộng | client có thấy đòn để né | chưa đo |
| S3 | Một người ngã, người kia cứu | trạng thái hai máy có khớp | chưa đo |
| S4 | Host thoát giữa trận | phòng sống tiếp, đợt liền mạch | chưa đo |
| S5 | Vào phòng giữa đợt | có nhảy đợt / spawn sai chỗ | chưa đo |
| S6 | 10.000 viên đạn | rò rỉ bộ nhớ, `S.b`/`S.sp` phình | chưa đo |
| S7 | Chơi liên tục 30 phút | heap, tile cache, entity sau 30 phút | chưa đo |

Cột "Kết quả" chỉ được điền sau khi có CSV. Không điền bằng cảm nhận.

## 5. Triệu chứng → nguyên nhân → sửa

| Triệu chứng | Nguyên nhân thường gặp | Sửa ở đâu |
|---|---|---|
| Teleport khi chạm quái | hoà giải quá tay | ngưỡng 200 px + kéo 14×dt (`net.js`) |
| Quái trượt nhẹ | interp ngắn hơn nhịp snapshot | đệm 1,6× khoảng cách gói (`interp`) |
| Bắn trúng mà không mất máu | host kiểm tra ở vị trí mới | lag compensation `RTT/2` (chưa làm) |
| Càng chơi càng chậm | máu vẽ vào tile cache | trần vết máu/tile, dọn tile xa |
| Vào phòng là khựng | client chạy frame rỗng trước snapshot đầu | chờ snapshot đầu rồi mới `run=true` |

## 6. Checklist chơi thử 2 máy (10 phút)

1. `npm start` trên máy mạnh; mở `http://<IP-LAN>:8080` trên máy thứ hai (điện thoại cũng được).
2. Cùng mã phòng, chọn **Online · Cùng chiến**, chơi 3 đợt.
3. Bấm F3 cả hai máy, chụp màn hình, xuất CSV cả hai.
4. Lặp lại với `--lag 60` rồi `--lag 150 --loss 0.03`.
5. Ghi 3 dòng cảm nhận: di chuyển / bắn / quái.

## 7. Lưu ý khi đo

- **Tab ẩn làm `requestAnimationFrame` dừng** → fps và mọi số liệu trong game sẽ bằng 0. Phải mở tab thật (cửa sổ trình duyệt hiển thị), không đo qua tab nền.
- Đo trên máy đang chạy server sẽ tính cả công việc của server; muốn số sạch thì chạy server ở máy khác.
- Bộ giả lập mạng được kiểm chứng tự động: `npm test` (xem `test/netsim.js`).
