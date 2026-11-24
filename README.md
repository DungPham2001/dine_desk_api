# DineDesk — API

Node.js (Express 4) + MongoDB (Mongoose 8) cho app Flutter **DineDesk** (quản lý nhà hàng: bàn, gọi món, bếp, kho, đặt bàn, ca quỹ, báo cáo).
Cùng kiến trúc với `rent_rack_api` / `seat_route_api`: entry Vercel ở `api/`, rate limit lưu trong Mongo, test trên MongoDB in-memory (replica set).
**Một nhà hàng, một vai trò `admin`** (không có `shopId`).

- Hợp đồng gốc: [docs/DineDesk-API.md](docs/DineDesk-API.md)
- Đã làm gì, khác gì, trả lời các câu hỏi mở: [docs/API-cho-FE.md](docs/API-cho-FE.md)

```bash
cp .env.example .env     # MONGODB_URI (database: dinedesk), JWT_SECRET, SMTP...
npm install
npm run db:init          # collection + index (bắt buộc một lần: unique email / nhãn bàn / SĐT khách)
npm run dev              # http://localhost:4000/v1/health
npm run seed             # nhà hàng mẫu "Bếp Phố Huế" + 4 tuần lịch sử; -- --reset để dựng lại (xóa sạch DB). CHỈ dùng DB test/duyệt
npm test                 # 35 test, dùng mongod local nếu có (/opt/homebrew/bin/mongod)
```

## Cấu trúc

| Thư mục | Nội dung |
|---|---|
| `src/models/index.js` | tất cả collection (đơn chứa luôn dòng món, giảm giá, thanh toán) |
| `src/routes/index.js` | toàn bộ `/v1/*` |
| `src/services/orders.js` | đơn: tính tiền 5.1, `version`/`If-Match`, thêm món dạng nối, đóng/hủy/mở lại/hoàn tiền |
| `src/services/stock.js` | sổ kho append-only, FEFO, nhập hàng, kiểm kho, gợi ý nhập |
| `src/services/bookings.js` | đặt bàn (chống trùng trong giao dịch), danh sách chờ, `/floor` |
| `src/services/shifts.js` | ca, thu chi, tiền mặt kỳ vọng 5.5 |
| `src/services/reports.js` | dashboard, báo cáo, tìm kiếm, nhắc việc, CSV |
| `src/services/catalog.js`, `crud.js` | khu vực, bàn, thực đơn, nguyên liệu, khách, khuyến mãi, nhân viên, chi phí |
| `src/services/accounts.js`, `tokens.js` | đăng ký, đăng nhập, refresh xoay vòng, quên/đổi mật khẩu, admin |
| `src/web/` | trang `/privacy` và `/account/delete` (Google Play) |

## Deploy (Vercel)

`vercel.json` chuyển mọi request vào `api/index.js` (region `sin1`). Đặt `MONGODB_URI`, `JWT_SECRET` (≥ 32 ký tự), `PUBLIC_BASE_URL`, SMTP; chạy `npm run db:init` một lần. Cần MongoDB **replica set** (Atlas) để các lệnh nhiều bước (đóng đơn, nhập hàng, đặt bàn) chạy trong giao dịch; trên mongod đơn lẻ vẫn chạy nhưng không có giao dịch và không chặn được hai đặt bàn trùng nhau cùng lúc.
