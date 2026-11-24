# DineDesk – Tài liệu API cho Backend

Phiên bản tài liệu: 1.0 · Cập nhật: 24/11/2026 · Ứng dụng: Flutter (Android/iOS)

Tài liệu này mô tả **hợp đồng API** mà app DineDesk cần để chạy với máy chủ thật. Hiện app đang lưu dữ liệu cục bộ và mô phỏng toàn bộ nghiệp vụ bên dưới; Backend (BE) cần cài đặt lại đúng các quy tắc này ở phía máy chủ. Nếu BE muốn đổi tên trường hay đường dẫn, hãy báo để app đổi theo, nhưng **các quy tắc nghiệp vụ ở mục 5 phải giữ nguyên** vì số liệu doanh thu, kho, ca quỹ phụ thuộc vào chúng.

---

## 0. Phạm vi

- **Một nhà hàng, một vai trò: `admin`.** Chủ, quản lý, thu ngân dùng chung loại tài khoản. Mọi admin có quyền ngang nhau. Không có tài khoản cho nhân viên, không có tài khoản cho khách ăn.
- **Nhân viên (`staff`) và khách (`customer`) chỉ là hồ sơ dữ liệu**, không đăng nhập.
- Không xử lý thanh toán online, không giữ tiền, không xuất hóa đơn thuế, không in. API chỉ **ghi nhận** thu chi do admin nhập.
- Không có ảnh, không upload file.
- Không có thanh toán sau, không công nợ: đơn chỉ đóng khi đã thu đủ hoặc ghi miễn phí kèm lý do.
- Nhắc việc là **thông báo cục bộ trên app**, không dùng push (FCM). BE chỉ cung cấp dữ liệu nguồn (mục 4.17).
- Không có chế độ offline: mất mạng thì app báo lỗi.

---

## 1. Quy ước chung

### 1.1 Cơ bản

| Mục | Quy ước |
|---|---|
| Giao thức | **Chỉ HTTPS** (app chặn HTTP thường) |
| Base URL | `https://{host}/v1` (tiền tố phiên bản `/v1`) |
| Định dạng | JSON UTF-8, `Content-Type: application/json` |
| Xác thực | Header `Authorization: Bearer <accessToken>` ở mọi endpoint trừ nhóm "công khai" (4.1) và `/health` |
| Ngôn ngữ lỗi | Header `Accept-Language: vi` hoặc `en`. **Lỗi trả mã ổn định (`code`)**, app tự dịch; `message` chỉ để debug |
| ID | UUID v4 dạng chuỗi, do server sinh |
| Tên trường | `camelCase` |

### 1.2 Thời gian

- Thời điểm (`openedAt`, `at`…): **ISO 8601 có múi giờ**, ví dụ `2026-11-24T19:05:00+07:00`.
- Ngày (`date`, `expiry`, `birthday`): `YYYY-MM-DD`.
- Giờ trong ngày của đặt bàn: số phút kể từ 00:00 (`startMin`, ví dụ 19:30 → `1170`).
- Mọi ranh giới "hôm nay", "tuần", "tháng", "giờ" tính theo **múi giờ của nhà hàng** (`shop.timezone`, mặc định `Asia/Ho_Chi_Minh`), không phải múi giờ máy chủ hay máy khách.
- Khoảng thời gian truy vấn: `from` **bao gồm**, `to` **không bao gồm** (nửa mở). App gửi `from`/`to` dạng ngày; BE hiểu là 00:00 theo múi giờ nhà hàng.

### 1.3 Tiền và số lượng

- **Tiền: số nguyên đồng (VND)**, không có phần thập phân. Ví dụ `139000`.
- **Số lượng nguyên liệu: số (decimal) theo đơn vị nhỏ nhất** (`g`, `ml`, `cái`, `lon`, `chai`, `quả`…). App hiện dùng số thực, ví dụ `0.5`; BE nên lưu `NUMERIC(14,3)`.
- Số lượng món (`qty`) và số khách (`party`): số nguyên ≥ 1.

### 1.4 Phân trang và lọc

Danh sách lớn dùng **cursor**:

```
GET /v1/orders?limit=50&cursor=<opaque>
→ { "items": [...], "nextCursor": "..." | null }
```

- `limit` mặc định 50, tối đa 200.
- Danh sách nhỏ (khu vực, bàn, nhóm món, nhân viên, mã giảm giá…) có thể trả toàn bộ không cần cursor, nhưng vẫn bọc `{ "items": [...] }`.
- Hỗ trợ `updatedSince=<ISO>` trên các danh sách danh mục để app đồng bộ nhẹ.

### 1.5 Idempotency (bắt buộc)

Các `POST` tạo bản ghi tiền hoặc đơn **phải hỗ trợ header `Idempotency-Key`** (UUID do app sinh mỗi lần người dùng bấm). Cùng key + cùng body trong 24 giờ → trả lại đúng kết quả lần đầu (không tạo trùng). Áp dụng cho:

`POST /orders`, `POST /orders/{id}/payments`, `POST /orders/{id}/close`, `POST /orders/{id}/refund`, `POST /purchases`, `POST /bookings`, `POST /shifts/open`, `POST /cash-entries`.

Cùng key nhưng khác body → `422 idempotency_key_reused`.

### 1.6 Chống ghi đè (optimistic concurrency)

Nhiều máy (quầy, bếp, điện thoại chủ) cùng thao tác một đơn.

- Mỗi `Order` có `version` (số nguyên, tăng 1 sau mỗi thay đổi).
- **Thêm món là thao tác nối thêm** (`POST /orders/{id}/lines`), không cần version và không ghi đè cả đơn.
- Các thao tác sửa đơn (`PATCH /orders/{id}`, `move`, `merge`, `close`, `reopen`, thêm/xóa giảm giá, ghi thanh toán) gửi `If-Match: <version>` hoặc `"version"` trong body. Sai version → `409 version_conflict`, body lỗi chứa `details.current` là đơn mới nhất.
- Mở bàn đang dùng → `409 table_in_use` kèm `details.orderId` để app mở đơn hiện có.

### 1.7 Định dạng lỗi

```json
{
  "code": "validation_failed",
  "message": "Human readable, for logs only",
  "details": { "field": "party", "reason": "min_1" }
}
```

| HTTP | `code` thường gặp |
|---|---|
| 400 | `bad_request`, `validation_failed` |
| 401 | `unauthorized`, `token_expired`, `invalid_credentials` |
| 403 | `password_change_required`, `forbidden` |
| 404 | `not_found` |
| 409 | `version_conflict`, `table_in_use`, `booking_overlap`, `email_taken`, `last_admin`, `has_dependents` |
| 422 | Lỗi nghiệp vụ, xem bảng dưới |
| 429 | `rate_limited` (kèm `Retry-After`) |
| 5xx | `server_error` |

Mã 422 nghiệp vụ:

| `code` | Khi nào |
|---|---|
| `reason_required` | Hủy món, tặng món, hủy đơn, hoàn tiền, miễn phí, hao hụt, giảm giá lớn mà thiếu `reason` |
| `item_unavailable` | Gọi món đang `out`/`off` hoặc không đủ nguyên liệu theo công thức |
| `draft_lines_pending` | Đóng đơn khi còn món chưa gửi bếp |
| `payment_incomplete` | Đóng đơn khi `due > 0` |
| `empty_order` | Đóng đơn không có món nào hợp lệ |
| `promo_invalid` | Mã không tồn tại, hết hạn, hết lượt |
| `promo_min_amount` | Đơn chưa đạt mức tối thiểu của mã |
| `shift_not_open` | Ghi thu chi khi chưa có ca |
| `open_orders_exist` | Đóng ca khi còn đơn mở |
| `not_enough_seats` | Tổng chỗ các bàn chọn < số khách |
| `idempotency_key_reused` | Xem 1.5 |

### 1.8 Hiệu năng và vận hành

- Màn hình bếp **polling mỗi 30 giây** (không có push): `GET /kitchen` phải nhẹ.
- Dashboard/báo cáo **gộp ở máy chủ**; khoảng dài như "Tất cả" không được trả từng đơn.
- Giới hạn thử đăng nhập: khuyến nghị 5 lần/15 phút/IP+email → `429`.
- Hết thời gian chờ phía app: 15 giây; app không tự thử lại mù quáng các `POST` (chỉ thử lại cùng `Idempotency-Key`).

---

## 2. Enum

| Tên | Giá trị |
|---|---|
| `TableStatus` (lưu ở server) | `free`, `busy`, `billing`, `cleaning` |
| `ItemStatus` | `on` (đang bán), `out` (hết hôm nay), `off` (ngừng bán) |
| `Station` | `kitchen`, `bar`, `grill` |
| `OrderKind` | `dine`, `take`, `delivery` |
| `OrderStatus` | `open`, `closed`, `cancelled` |
| `LineStatus` | `draft` → `sent` → `cooking` → `done` → `served`; hoặc `cancelled` |
| `DeliveryStatus` | `received`, `cooking`, `ready`, `delivering`, `delivered` |
| `PaymentKind` | `pay`, `tip`, `refund`, `deposit` |
| `PaymentMethod` | `cash`, `transfer`, `free` |
| `BookingStatus` (lưu ở server) | `booked`, `arrived`, `noshow`, `cancelled` |
| `StaffRole` | `waiter`, `kitchen`, `bar`, `cashier`, `delivery` |
| `StockMoveKind` | `receive`, `sale`, `waste`, `count` |
| `PromoKind` | `percent`, `amount` |

Ghi chú:

- Trạng thái **`reserved`** của bàn và **`late`** của đặt bàn là **suy ra**, không lưu. `reserved` = bàn `free` mà có đặt bàn `booked` bắt đầu trong ≤ 60 phút tới. `late` = đặt bàn `booked`, hôm nay, và `now > start + holdMinutes`. BE có thể trả sẵn (`nextBooking` ở `/floor`, `isLate` ở `/bookings`) để app khỏi tự tính; xem 4.4 và 4.13.
- Lệnh `StockMoveKind.count` dùng cho cả kiểm kho lẫn điều chỉnh khi xóa lô/phiếu nhập.

---

## 3. Mô hình dữ liệu

Chỉ liệt kê trường app đang dùng. Trường `createdAt`, `updatedAt` có ở mọi bản ghi (không liệt kê lại).

### 3.1 Account (admin)
| Trường | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid | |
| `email` | string | duy nhất, **lưu chữ thường** |
| `name` | string | |
| `phone` | string? | |
| `language` | `vi`\|`en` | |
| `mustChangePassword` | bool | `true` khi mật khẩu tạm do admin khác cấp |

Không bao giờ trả `passwordHash`. Băm bằng **Argon2id hoặc bcrypt**.

### 3.2 Shop (một dòng duy nhất)
`name`, `description`, `phone`, `address`, `openText`, `representative`, `businessRegText`, `timezone`.

### 3.3 Rules (một dòng duy nhất)
| Trường | Kiểu | Mặc định | Ý nghĩa |
|---|---|---|---|
| `servicePct` | int 0–30 | 0 | Phí phục vụ % (chỉ đơn `dine`) |
| `roundTo` | int | 1000 | Làm tròn tổng đơn đến bội số này (`1` = không làm tròn) |
| `seatMinutes` | int | 90 | Thời gian ngồi dự kiến, dùng cho đặt bàn |
| `holdMinutes` | int | 15 | Giữ bàn sau giờ hẹn |
| `longSitMinutes` | int | 120 | Cảnh báo bàn ngồi lâu |
| `reminderLeadMin` | int | 30 | Nhắc trước giờ đặt bàn |

### 3.4 Area / Table
```json
{ "id": "…", "name": "Tầng 1" }
{ "id": "…", "areaId": "…", "label": "A1", "seats": 4, "canMerge": true,
  "status": "free", "currentOrderId": null }
```
`label` duy nhất trong toàn nhà hàng.

### 3.5 MenuGroup / MenuItem
```json
{
  "id": "…", "groupId": "…", "code": "M01", "name": "Cơm chiên hải sản",
  "desc": "", "unit": "", "price": 89000, "prepMin": 10,
  "station": "kitchen", "status": "on", "tags": ["chay"],
  "options": [
    { "name": "Size", "required": true, "multi": false,
      "choices": [ { "name": "Vừa", "extra": 0 }, { "name": "Lớn", "extra": 15000 } ] }
  ],
  "available": true,
  "unavailableReason": null
}
```
- `options` nhúng trong món (không cần bảng riêng ở API).
- `available` và `unavailableReason` (`"status"` | `"stock"`) **do server tính** (mục 5.6).
- Tên món và nội dung nhập tay **không dịch**.

### 3.6 Ingredient / Recipe / Lot / StockMove
```json
{ "id": "…", "name": "Thịt bò", "unit": "g", "group": "", "minQty": 3000,
  "supplierId": null, "onHand": 14000.0, "lastCost": 260 }
```
`onHand` và `lastCost` do server tính.

Công thức là danh sách thay thế toàn bộ theo món:
```json
{ "itemId": "…", "lines": [ { "ingredientId": "…", "qty": 200 } ] }
```
`qty` = lượng nguyên liệu cho **một phần**.

```json
{ "id": "…", "ingredientId": "…", "purchaseId": null, "received": 5000.0,
  "remaining": 4200.0, "unitCost": 260, "expiry": "2026-11-28", "receivedAt": "…" }

{ "id": "…", "ingredientId": "…", "qty": -200.0, "kind": "sale", "note": "Đơn B012", "at": "…" }
```
**Sổ kho chỉ ghi thêm (append-only)**; tồn = tổng `qty` các bút toán.

### 3.7 Supplier / Purchase
```json
{ "id": "…", "name": "…", "phone": "", "items": "Thịt, cá", "note": "" }

{ "id": "…", "supplierId": "…", "date": "2026-11-24T09:10:00+07:00",
  "method": "cash", "note": "", "total": 1650000,
  "lines": [ { "ingredientId": "…", "qty": 5000, "unitCost": 255, "expiry": "2026-11-30" } ] }
```
`method` ∈ `cash`/`transfer`. **Thanh toán ghi ngay lúc nhập, không có công nợ nhà cung cấp.**

### 3.8 Order
```json
{
  "id": "…", "code": "B012", "number": 12, "kind": "dine",
  "status": "open", "version": 7,
  "tableId": "…", "tableLabel": "A4",
  "customerId": null, "customerName": "Chị Hương", "phone": "0988…",
  "party": 4, "note": "", "allergy": "Dị ứng hải sản vỏ cứng",
  "address": "", "deliveryFee": 0, "deliveryStatus": "received", "delivererId": null,
  "dueAt": null, "serviceOn": true, "surcharge": 0,
  "openedAt": "…", "closedAt": null, "openedBy": "Admin Test",
  "lines": [ /* OrderLine */ ],
  "discounts": [ { "id": "…", "label": "Mã HELLO10", "amount": 20000, "reason": "" } ],
  "payments": [ /* Payment */ ],
  "totals": {
    "subtotal": 456000, "discountTotal": 20000, "serviceFee": 21800,
    "surcharge": 0, "deliveryFee": 0, "rawTotal": 457800,
    "roundAdjust": 200, "total": 458000,
    "paid": 200000, "refunded": 0, "tips": 0, "due": 258000
  }
}
```
`totals` **do server tính** (công thức mục 5.1). App chỉ hiển thị.

OrderLine:
```json
{ "id": "…", "itemId": "…", "name": "Bò lúc lắc", "qty": 2, "unitPrice": 139000,
  "options": ["Lớn", "Cay"], "note": "ít mỡ", "station": "kitchen",
  "status": "cooking", "comp": false, "cancelReason": "",
  "firedAt": "…", "doneAt": null, "lineTotal": 278000 }
```
- `name` và `unitPrice` là **bản sao tại thời điểm gọi món** (đổi giá/tên món sau đó không ảnh hưởng đơn). `unitPrice` đã gồm cộng thêm của tùy chọn.
- `lineTotal` = 0 nếu `comp` hoặc `status = cancelled`, ngược lại `qty × unitPrice`.

Payment:
```json
{ "id": "…", "kind": "pay", "method": "cash", "amount": 200000,
  "note": "", "by": "Admin Test", "at": "…" }
```

### 3.9 Booking / WaitEntry
```json
{
  "id": "…", "name": "Chị Hương", "phone": "0988…", "party": 4,
  "date": "2026-11-24", "startMin": 1140, "durationMin": 90,
  "note": "Sinh nhật", "areaPref": "", "deposit": 0,
  "status": "booked", "isLate": false, "tableIds": ["…"]
}
{ "id": "…", "name": "Anh Việt", "phone": "", "party": 3, "joinedAt": "…" }
```
`deposit` là số tiền admin ghi tay, **không phải thanh toán trong app và không tính doanh thu**.

### 3.10 Customer / Promotion / Staff
```json
{ "id": "…", "name": "Chị Hương", "phone": "0988…", "allergy": "…", "pref": "", "attention": "",
  "birthday": "1990-11-26", "points": 42, "visits": 6, "totalSpent": 2150000 }

{ "id": "…", "code": "HELLO10", "kind": "percent", "value": 10, "minAmount": 200000,
  "limit": 100, "used": 23, "end": "2026-12-31", "valid": true }

{ "id": "…", "name": "Nguyễn Văn An", "phone": "…", "role": "waiter",
  "joined": "2025-01-10", "active": true, "note": "" }
```
- `phone` của khách **duy nhất** (khóa gộp khách).
- `visits`, `totalSpent`, `valid` do server tính.
- `Promotion.limit = 0` nghĩa là không giới hạn.

### 3.11 Shift / CashEntry
```json
{ "id": "…", "openedBy": "Admin Test", "openedAt": "…", "closedAt": null,
  "startCash": 2000000, "countedCash": null,
  "expectedCash": 2850000, "difference": null }
{ "id": "…", "shiftId": "…", "amount": -350000, "reason": "Mua đá", "at": "…" }
```
`amount` âm = chi, dương = thu/bù quỹ.

### 3.12 Expense / SalesTarget
```json
{ "id": "…", "category": "Mặt bằng", "amount": 18000000, "date": "2026-11-01",
  "recurring": true, "note": "" }
{ "month": "2026-11", "targetRevenue": 320000000 }
```

### 3.13 AdminAction (nhật ký, chỉ ghi)
`{ "id", "adminId", "adminName", "action", "targetType", "targetId", "note", "at" }`.
Server **tự ghi** khi: hoàn tiền, giảm giá lớn, hủy món/đơn, tặng món, miễn phí, mở lại đơn, sửa giá hàng loạt, xóa/hủy phiếu nhập, xóa lô, xóa đặt bàn, đóng ca (kèm chênh lệch), thêm/thu hồi admin, đặt lại mật khẩu, xóa tài khoản. App hiện **không có màn hình xem**, nhưng cần dữ liệu để truy vết (endpoint đọc ở 4.19).

---

## 4. Endpoint

Ký hiệu: 🔓 công khai · 🔒 cần đăng nhập. Mọi endpoint 🔒 trả `403 password_change_required` nếu tài khoản còn `mustChangePassword = true` (trừ `change-password`, `logout`, `GET /me`).

### 4.1 Xác thực

| Method | Path | Mô tả |
|---|---|---|
| 🔓 POST | `/auth/register` | Đăng ký (xem câu hỏi mở số 1) |
| 🔓 POST | `/auth/login` | Đăng nhập |
| 🔓 POST | `/auth/refresh` | Làm mới token |
| 🔒 POST | `/auth/logout` | Hủy refresh token |
| 🔒 POST | `/auth/change-password` | Đổi mật khẩu |

`POST /auth/register`
```json
// request
{ "email": "admin@dinedesk.vn", "name": "Admin Test", "password": "Test@1234" }
// 201
{ "accessToken": "…", "refreshToken": "…", "expiresIn": 7200,
  "account": { /* Account */ } }
```
- Mật khẩu ≥ 8 ký tự. Email lưu chữ thường. Trùng email → `409 email_taken`.

`POST /auth/login`
```json
{ "email": "admin@dinedesk.vn", "password": "Test@1234" }
// 200 – như register, thêm "mustChangePassword": false
// 401 invalid_credentials (không nói rõ email hay mật khẩu sai)
```

`POST /auth/refresh` `{ "refreshToken": "…" }` → token mới (xoay vòng refresh token).

`POST /auth/change-password` `{ "oldPassword": "…", "newPassword": "…" }` → `204`. Sai mật khẩu cũ → `422 wrong_password`. Thành công thì `mustChangePassword = false`.

**Phía app:** access token ~2 giờ, **chỉ giữ trong bộ nhớ**; app tự `refresh` khi đang dùng; thoát hẳn app hoặc để nền > ~1 giờ thì app bỏ phiên và yêu cầu đăng nhập lại. `401 token_expired` → app thử `refresh` một lần, thất bại thì về màn hình đăng nhập và **giữ bản nháp đơn đang gọi trong bộ nhớ**.

### 4.2 Tài khoản và quản trị viên

| Method | Path | Mô tả |
|---|---|---|
| 🔒 GET | `/me` | Hồ sơ của tôi |
| 🔒 PATCH | `/me` | Sửa `name`, `phone`, `language` |
| 🔒 DELETE | `/me` | Xóa tài khoản, body `{ "password": "…" }` |
| 🔒 GET | `/admins` | Danh sách admin |
| 🔒 POST | `/admins` | Thêm admin: `{ email, name, tempPassword }` → `mustChangePassword = true` |
| 🔒 POST | `/admins/{id}/reset-password` | `{ tempPassword }` → `mustChangePassword = true`, hủy mọi refresh token của người đó |
| 🔒 POST | `/admins/{id}/revoke` | Thu hồi quyền (xóa admin) |

Quy tắc: không thu hồi chính mình qua `/revoke`; **admin cuối cùng không xóa được** (`409 last_admin`) ở cả `/revoke` lẫn `DELETE /me`; `DELETE /me` sai mật khẩu → `422 wrong_password`. Xóa tài khoản là **xóa thật** (giữ lại tên trong `AdminAction`/`openedBy` ở các bản ghi cũ dưới dạng chuỗi).

### 4.3 Nhà hàng và quy tắc

| Method | Path |
|---|---|
| 🔒 GET/PUT | `/shop` |
| 🔒 GET/PUT | `/shop/rules` |

### 4.4 Khu vực, bàn, sơ đồ

| Method | Path | Mô tả |
|---|---|---|
| 🔒 GET/POST | `/areas` | |
| 🔒 PATCH/DELETE | `/areas/{id}` | Xóa khu vực → **xóa luôn các bàn** thuộc khu; `409 has_dependents` nếu có bàn đang có đơn mở |
| 🔒 GET/POST | `/tables` | |
| 🔒 PATCH/DELETE | `/tables/{id}` | Xóa bàn đang có đơn → `409 has_dependents` |
| 🔒 POST | `/tables/{id}/open` | Mở bàn (4.6) |
| 🔒 POST | `/tables/{id}/clean` | Dọn xong: `cleaning` → `free` |
| 🔒 GET | `/floor` | Toàn bộ sơ đồ |

`GET /floor` trả mọi bàn kèm tóm tắt để vẽ sơ đồ một lần gọi:
```json
{ "areas": [ … ],
  "tables": [ { "id": "…", "areaId": "…", "label": "A4", "seats": 4, "canMerge": true,
                "status": "busy",
                "order": { "id": "…", "code": "B012", "party": 4, "openedAt": "…", "total": 458000 },
                "nextBooking": { "id": "…", "startMin": 1140, "date": "2026-11-24" } } ] }
```
`order` null nếu bàn không có đơn mở; `nextBooking` là đặt bàn `booked` gần nhất bắt đầu trong ≤ 60 phút tới.

### 4.5 Thực đơn

| Method | Path | Mô tả |
|---|---|---|
| 🔒 GET/POST | `/menu-groups` | |
| 🔒 PATCH/DELETE | `/menu-groups/{id}` | Xóa nhóm → **xóa luôn các món** trong nhóm |
| 🔒 GET | `/menu-items?groupId=&status=&q=` | Có `available` |
| 🔒 POST | `/menu-items` | |
| 🔒 GET/PATCH/DELETE | `/menu-items/{id}` | |
| 🔒 PUT | `/menu-items/{id}/recipe` | Thay toàn bộ công thức |
| 🔒 GET | `/menu-items/{id}/cost` | `{ "cost": 61000, "marginPct": 31 }` hoặc `{ "cost": null }` (5.7) |
| 🔒 POST | `/menu-items/bulk-price` | Đổi giá hàng loạt |

`POST /menu-items/bulk-price`
```json
{ "groupId": "…" /* hoặc null = tất cả */, "percent": 5.0 }
// 200 { "updated": 38 }
```
Giá mới = `round(price × (1 + percent/100) / 1000) × 1000` (làm tròn đến nghìn). **Không ảnh hưởng đơn đang mở** (đã lưu `unitPrice`). Ghi `AdminAction`.

Xóa món không làm mất dòng món trong đơn cũ (đã có bản sao `name`, `unitPrice`).

### 4.6 Đơn hàng

| Method | Path | Mô tả |
|---|---|---|
| 🔒 POST | `/tables/{id}/open` | Mở bàn, tạo đơn `dine` |
| 🔒 POST | `/orders` | Tạo đơn `take`/`delivery` |
| 🔒 GET | `/orders?status=&kind=&from=&to=&q=&cursor=` | Danh sách |
| 🔒 GET | `/orders/{id}` | Chi tiết |
| 🔒 PATCH | `/orders/{id}` | Sửa `note`, `allergy`, `party`, `serviceOn`, `surcharge`, `dueAt`, `address`, `deliveryFee`, `delivererId` |
| 🔒 POST | `/orders/{id}/lines` | Thêm món |
| 🔒 PATCH | `/orders/{id}/lines/{lineId}` | Sửa `qty`, `note` (chỉ khi `draft`) |
| 🔒 DELETE | `/orders/{id}/lines/{lineId}` | Xóa (chỉ khi `draft`) |
| 🔒 POST | `/orders/{id}/lines/{lineId}/cancel` | Hủy món đã gửi bếp: `{ reason }` |
| 🔒 POST | `/orders/{id}/lines/{lineId}/comp` | Tặng món: `{ reason }` |
| 🔒 POST | `/orders/{id}/fire` | Gửi bếp mọi món `draft` |
| 🔒 POST | `/orders/{id}/move` | `{ toTableId }` |
| 🔒 POST | `/orders/{id}/merge` | `{ intoOrderId }` |
| 🔒 POST | `/orders/{id}/discounts` | Thêm giảm giá |
| 🔒 DELETE | `/orders/{id}/discounts/{discountId}` | Gỡ giảm giá |
| 🔒 POST | `/orders/{id}/apply-promo` | `{ code }` |
| 🔒 POST | `/orders/{id}/payments` | Ghi thanh toán / tiền boa |
| 🔒 DELETE | `/orders/{id}/payments/{paymentId}` | Hủy dòng thanh toán (chỉ khi đơn `open`) |
| 🔒 POST | `/orders/{id}/close` | Đóng đơn |
| 🔒 POST | `/orders/{id}/cancel` | Hủy cả đơn: `{ reason }` |
| 🔒 POST | `/orders/{id}/reopen` | Mở lại đơn đã đóng |
| 🔒 POST | `/orders/{id}/refund` | Hoàn tiền sau khi đóng |
| 🔒 PUT | `/orders/{id}/delivery-status` | `{ status }` |

Mọi endpoint ghi trả về **Order đầy đủ** (có `totals` mới) để app cập nhật ngay.

**Mở bàn** `POST /tables/{id}/open`
```json
{ "party": 4, "customerName": "Chị Hương", "phone": "0988…" }
```
→ `201` Order. Bàn đang có đơn mở → `409 table_in_use`. Bàn chuyển `busy`, `serviceOn = (rules.servicePct > 0)`.

**Tạo đơn mang đi / giao**
```json
{ "kind": "delivery", "customerName": "Chị Thảo", "phone": "0965…",
  "address": "45 Lê Lợi, Q.1", "deliveryFee": 25000,
  "dueAt": "2026-11-24T19:30:00+07:00", "delivererId": "…", "note": "" }
```
`kind = take` không cần `address`, `deliveryFee`. `kind = delivery` bắt buộc `customerName`, `phone`, `address`.

**Thêm món**
```json
{ "itemId": "…", "qty": 2, "options": ["Lớn", "Cay"], "extra": 15000, "note": "ít mỡ" }
```
- Server **tự lấy `name`, `station` và `price` từ món** rồi lưu `unitPrice = price + extra`. (`extra` là tổng giá cộng thêm của các lựa chọn; BE nên **tự tính lại từ `options` theo định nghĩa món** thay vì tin giá trị client gửi. App gửi sẵn `extra` chỉ để hiển thị tức thời.)
- Món `out`/`off` hoặc thiếu nguyên liệu → `422 item_unavailable`.
- Gộp dòng: nếu đã có dòng `draft` cùng `itemId`, `unitPrice`, `options`, `note` thì **cộng dồn `qty`** thay vì tạo dòng mới.
- Nhóm tùy chọn `required` mà thiếu → `422 validation_failed`.

**Gửi bếp** `POST /orders/{id}/fire` → mọi dòng `draft` thành `sent`, `firedAt = now`. Với đơn `delivery` đang `received` thì `deliveryStatus → cooking`. Trả `{ "fired": 3, "order": {…} }`.

**Hủy / tặng món** đều **bắt buộc `reason`** (`reason_required`). Hủy dòng đã `done`/`served` → ghi hao hụt kho (5.3).

**Chuyển bàn** `move`: bàn đích phải `free` (`409 table_in_use` nếu không). Bàn cũ → `free`, bàn mới → `busy`.

**Ghép bàn** `merge`: nối toàn bộ `lines`, `discounts` của đơn nguồn vào đơn đích, cộng `party`; đơn nguồn → `cancelled` (rỗng), bàn nguồn → `cleaning`. Chỉ cho bàn `canMerge = true`.

**Giảm giá** `POST /orders/{id}/discounts`
```json
{ "label": "Giảm 10%", "amount": 45600, "reason": "" }
```
`amount` là số tiền cuối cùng (app đã quy đổi từ % sang tiền). Nếu `amount > 20% subtotal` thì **bắt buộc `reason`**, ghi `AdminAction`.

**Mã giảm giá** `POST /orders/{id}/apply-promo` `{ "code": "HELLO10" }` → tạo một `discount` với `label = "Mã {code}"`. Lỗi `promo_invalid` / `promo_min_amount`. Quy tắc mã ở 5.8.

**Thanh toán** `POST /orders/{id}/payments`
```json
{ "kind": "pay", "method": "cash", "amount": 200000, "note": "" }
```
- `kind = pay`: tối đa bằng `due` (app đã chặn, BE vẫn phải kiểm). `amount > due` → `422 validation_failed`.
- `method = free`: **bắt buộc `note` (lý do)**, ghi `AdminAction`.
- `kind = tip`: ghi riêng, **không trừ vào `due`**, không tính doanh thu.
- Sau khi `due` về 0 trên đơn `dine`, bàn chuyển `billing`.
- Chia đều/tách thanh toán chỉ là nhiều lần gọi này; app tự tính phần chia (phần dư dồn người cuối).

**Đóng đơn** `POST /orders/{id}/close`
Điều kiện (kiểm theo thứ tự):
1. Không còn dòng `draft` → `draft_lines_pending`.
2. Có ít nhất một dòng không `cancelled` → `empty_order`.
3. `due = 0` → `payment_incomplete`.

Khi đóng: `closedAt = now`, `status = closed`, chốt `roundAdjust`, **trừ kho** (5.3), cộng điểm khách (5.9), bàn `dine` → `cleaning`, đơn `delivery` → `deliveryStatus = delivered`.

**Hủy đơn** `cancel`: bắt buộc `reason`; `status = cancelled`; bàn → `free`. Không trừ kho. Mọi `Payment` đã ghi trên đơn hủy **không tính doanh thu**.

**Mở lại** `reopen`: đơn `closed` → `open`, bàn (nếu vẫn thuộc đơn này) → `busy`. Ghi `AdminAction`. ⚠️ Xem câu hỏi mở số 3 về hoàn kho.

**Hoàn tiền** `POST /orders/{id}/refund` `{ "amount": 50000, "method": "cash", "reason": "…" }` → ghi `Payment { kind: "refund" }`. Bắt buộc `reason`. Tổng hoàn không vượt tổng đã thu.

**Trạng thái giao hàng** `PUT /orders/{id}/delivery-status`: chỉ cho đơn `delivery`; thứ tự gợi ý `received → cooking → ready → delivering → delivered` (app cho chọn bất kỳ).

### 4.7 Bếp

| Method | Path | Mô tả |
|---|---|---|
| 🔒 GET | `/kitchen?station=` | Danh sách món chờ |
| 🔒 POST | `/orders/{id}/lines/{lineId}/start` | `sent` → `cooking` |
| 🔒 POST | `/orders/{id}/lines/{lineId}/done` | `cooking` → `done`, `doneAt = now` |
| 🔒 POST | `/orders/{id}/lines/{lineId}/served` | `done` → `served` |

`GET /kitchen` chỉ trả dòng có `status ∈ {sent, cooking, done}` của **đơn đang mở**, sắp theo `firedAt` tăng dần:
```json
{ "items": [ { "orderId": "…", "orderCode": "B012", "tableLabel": "A4", "orderKind": "dine",
               "allergy": "Dị ứng hải sản", "lineId": "…", "name": "Bò lúc lắc", "qty": 2,
               "options": ["Cay"], "note": "", "station": "kitchen",
               "status": "sent", "firedAt": "…" } ],
  "serverTime": "…" }
```
`serverTime` để app tính "đã chờ bao lâu" không phụ thuộc đồng hồ máy khách. Cảnh báo chờ lâu: app tô đỏ khi chờ ≥ 15 phút (hằng số phía app).

### 4.8 Kho

| Method | Path | Mô tả |
|---|---|---|
| 🔒 GET/POST | `/ingredients` | Có `onHand`, `lastCost` |
| 🔒 PATCH/DELETE | `/ingredients/{id}` | Xóa → xóa luôn công thức, lô, sổ kho của nguyên liệu |
| 🔒 GET | `/stock-lots?ingredientId=&remaining=gt0` | |
| 🔒 PATCH | `/stock-lots/{id}` | Chỉ sửa `expiry` |
| 🔒 DELETE | `/stock-lots/{id}` | Xóa lô: ghi bút toán `count` bằng `-remaining` |
| 🔒 GET | `/stock-moves?ingredientId=&kinds=&cursor=` | Sổ kho |
| 🔒 POST | `/stock/receive` | Nhập kho lẻ |
| 🔒 POST | `/stock/waste` | Ghi hao hụt |
| 🔒 POST | `/stock/stocktake` | Kiểm kho |
| 🔒 GET | `/stock/reorder-suggestions` | Gợi ý nhập |

```json
// POST /stock/receive
{ "ingredientId": "…", "qty": 5000, "unitCost": 260, "expiry": "2026-11-30" }
// POST /stock/waste   (reason bắt buộc)
{ "ingredientId": "…", "qty": 300, "reason": "Hỏng" }
// POST /stock/stocktake
{ "ingredientId": "…", "countedQty": 11800, "note": "Đổ khi chế biến" }
```
- `receive` tạo `StockLot` + `StockMove(kind=receive)`.
- `waste` trừ theo FEFO (5.3) + `StockMove(kind=waste)`.
- `stocktake`: `diff = countedQty − onHand`. `diff = 0` → không làm gì. `diff < 0` → trừ FEFO; `diff > 0` → cộng thẳng bút toán (không tạo lô). Bút toán `kind = count`.

`GET /stock/reorder-suggestions` trả:
```json
{ "enoughData": true,
  "items": [ { "ingredientId": "…", "name": "Tôm", "unit": "g",
               "onHand": 1800, "suggestedQty": 3200 } ] }
```
Công thức: `suggested = minQty + (tiêu thụ 14 ngày gần nhất / 14) × 3 − onHand`, chỉ trả phần dương và chỉ cho nguyên liệu có `minQty > 0` hoặc có tiêu thụ. Tiêu thụ = tổng `−qty` của `StockMove(kind=sale)` trong 14 ngày. `enoughData = false` nếu bút toán đầu tiên cách hiện tại < 7 ngày (app hiển thị cảnh báo "dữ liệu còn ít"). Chỉ là **gợi ý**.

### 4.9 Nhà cung cấp và nhập hàng

| Method | Path | Mô tả |
|---|---|---|
| 🔒 GET/POST | `/suppliers` | |
| 🔒 PATCH/DELETE | `/suppliers/{id}` | Xóa → `ingredients.supplierId = null`; phiếu nhập cũ giữ `supplierId` |
| 🔒 GET | `/purchases?from=&to=&supplierId=` | |
| 🔒 POST | `/purchases` | Tạo phiếu (idempotent) |
| 🔒 GET | `/purchases/{id}` | |
| 🔒 PUT | `/purchases/{id}` | Sửa: **hoàn tác phiếu cũ rồi áp phiếu mới** trong một giao dịch |
| 🔒 DELETE | `/purchases/{id}` | Xóa + hoàn kho |

Tạo phiếu: với mỗi `line` tạo `StockLot` (`purchaseId` = id phiếu, `received = remaining = qty`, `unitCost`, `expiry`) và `StockMove(kind=receive)`.

Xóa/sửa phiếu: mọi lô có `purchaseId` = phiếu đó bị xóa, và ghi bút toán `count` bằng `-received` mỗi lô (**dù lô đã bị dùng một phần**, vì app coi đây là sửa sai phiếu nhập). Phiếu không có lô (dữ liệu cũ) thì chỉ xóa bản ghi. Ghi `AdminAction`.

Phản hồi có thêm `total = Σ qty × unitCost` (làm tròn mỗi dòng bằng `round`).

### 4.10 Khách và khuyến mãi

| Method | Path | Mô tả |
|---|---|---|
| 🔒 GET/POST | `/customers` | `q` tìm theo tên/SĐT (không dấu) |
| 🔒 GET/PATCH/DELETE | `/customers/{id}` | Xóa **thật** (yêu cầu xóa dữ liệu cá nhân); đơn cũ giữ tên/SĐT dạng chuỗi hoặc ẩn danh theo chính sách |
| 🔒 POST | `/customers/{id}/merge` | `{ "dropId": "…" }` gộp khách trùng |
| 🔒 GET/POST | `/promotions` | |
| 🔒 PATCH/DELETE | `/promotions/{id}` | |

- SĐT trùng khi tạo/sửa → `409 conflict` (`code: "phone_taken"`) kèm `details.customerId`; app đề xuất gộp.
- **Gộp khách**: cộng `points`, giữ `allergy` của khách giữ lại nếu trống thì lấy của khách bị gộp, chuyển mọi đơn sang khách giữ lại, xóa khách bị gộp.
- Ghi chú dị ứng là **thông tin nhạy cảm**: chỉ admin xem, **không ghi vào log**, xóa được theo yêu cầu.

### 4.11 Nhân viên

`GET/POST /staff`, `PATCH/DELETE /staff/{id}`. Chỉ là hồ sơ. Xóa nhân viên đang gắn `delivererId` trên đơn → bỏ liên kết (đặt null).

### 4.12 Chi phí và mục tiêu

| Method | Path |
|---|---|
| 🔒 GET/POST | `/expenses?from=&to=` |
| 🔒 PATCH/DELETE | `/expenses/{id}` |
| 🔒 GET/PUT | `/sales-targets/{yyyy-MM}` |

`recurring = true` chỉ là nhãn hiển thị; **BE không cần tự sinh bản ghi lặp** (app không dùng). Nếu BE muốn tự sinh hằng tháng thì báo lại để thống nhất tránh nhân đôi.

### 4.13 Đặt bàn và danh sách chờ

| Method | Path | Mô tả |
|---|---|---|
| 🔒 GET | `/bookings?date=&from=&to=&status=` | |
| 🔒 POST | `/bookings` | Tạo (idempotent, kiểm trùng) |
| 🔒 PATCH | `/bookings/{id}` | Sửa / đổi giờ / đổi bàn (kiểm trùng) |
| 🔒 DELETE | `/bookings/{id}` | Xóa hẳn |
| 🔒 POST | `/bookings/{id}/status` | `{ "status": "noshow" \| "cancelled" \| "booked" }` |
| 🔒 POST | `/bookings/{id}/arrive` | Khách đến, mở bàn |
| 🔒 GET | `/bookings/availability?date=&startMin=&durationMin=&party=&ignoreBookingId=` | Bàn còn trống |
| 🔒 GET/POST/DELETE | `/wait-list`, `/wait-list/{id}` | Danh sách chờ |

**Kiểm trùng (bắt buộc làm trong một giao dịch, kèm ràng buộc loại trừ ở DB):** hai đặt bàn `booked` cùng bàn không được chồng giờ. Khoảng thời gian của một đặt bàn là `[start, start + durationMin + 10 phút đệm dọn bàn)`. Chồng khi `startA < endB && startB < endA`. Vi phạm → `409 booking_overlap`, `details.tableIds` là các bàn bị trùng.

**Bàn trống cho khung giờ** (`/availability`): bàn thỏa **tất cả**:
1. `seats ≥ party`;
2. không có đặt bàn `booked` chồng khung `[start, start + durationMin + 10)`;
3. không có đơn đang mở trên bàn **nếu** khung giờ bắt đầu trong vòng 60 phút tới và còn giao với hiện tại (`start < now + 60 phút && end > now`).

Sắp xếp theo `seats` tăng dần (gán bàn vừa người trước). Có `ignoreBookingId` để loại chính đặt bàn đang sửa.

`POST /bookings`
```json
{ "name": "Chị Hương", "phone": "0988…", "party": 4, "date": "2026-11-24",
  "startMin": 1140, "durationMin": 90, "note": "Sinh nhật", "deposit": 0,
  "tableIds": ["…"] }
```
`tableIds` bắt buộc ≥ 1; tổng chỗ < `party` → `422 not_enough_seats`.

**Khách đến** `POST /bookings/{id}/arrive`: `status = arrived`; mở bàn đầu tiên trong `tableIds` đang trống (xem 4.6) với `party`, `name`, `phone` của đặt bàn, rồi trả `{ "booking": {…}, "order": {…} | null }`. `order = null` nếu mọi bàn đều bận (app báo "bàn đang bận").

**Hết hạn giữ bàn:** không có job đổi trạng thái; `isLate` là suy ra (`booked` & hôm nay & `now > start + holdMinutes`). Khi `noshow`/`cancelled` thì bàn tự được nhả khỏi phép kiểm trùng (vì chỉ `booked` mới tính).

### 4.14 Ca và quỹ tiền mặt

| Method | Path | Mô tả |
|---|---|---|
| 🔒 GET | `/shifts/current` | Ca đang mở, hoặc `404`/`null` |
| 🔒 GET | `/shifts?limit=` | Lịch sử |
| 🔒 POST | `/shifts/open` | `{ "startCash": 2000000 }` (nếu đã có ca mở → trả ca hiện tại, không lỗi) |
| 🔒 POST | `/shifts/close` | `{ "countedCash": 14850000 }` |
| 🔒 GET/POST | `/cash-entries?shiftId=` | Thu chi trong ca |
| 🔒 DELETE | `/cash-entries/{id}` | |
| 🔒 GET | `/day-close?date=` | Chốt cuối ngày |

- `POST /cash-entries` `{ "amount": -350000, "reason": "Mua đá" }` gắn vào ca đang mở; không có ca → `422 shift_not_open`. `reason` bắt buộc.
- `POST /shifts/close`: còn bất kỳ đơn `open` nào → `422 open_orders_exist` (`details.count`). Thành công: `closedAt = now`, `countedCash`, `difference = countedCash − expectedCash`. Ghi `AdminAction`.
- `expectedCash` công thức ở 5.5.
- `GET /day-close?date=` trả đúng các trường của `summary` (mục 4.15) cho **một ngày**, thêm `openOrders` (số đơn chưa đóng).

### 4.15 Dashboard và báo cáo

Tất cả nhận `from`, `to` (ngày, nửa mở) **hoặc** `range` ∈ `today`, `d7`, `d14`, `m1`, `m3`, `m6`, `y1`, `all`. Định nghĩa `range` theo ngày làm việc hiện tại của nhà hàng:

| `range` | Từ | Đến (không gồm) |
|---|---|---|
| `today` | hôm nay | ngày mai |
| `d7` | hôm nay − 6 | ngày mai |
| `d14` | hôm nay − 13 | ngày mai |
| `m1` | hôm nay − 29 | ngày mai |
| `m3` | hôm nay − 89 | ngày mai |
| `m6` | hôm nay − 179 | ngày mai |
| `y1` | hôm nay − 364 | ngày mai |
| `all` | ngày có thanh toán đầu tiên (hoặc hôm nay − 29 nếu chưa có) | ngày mai |

**Kỳ trước** = khoảng cùng độ dài ngay trước `from`.

| Method | Path |
|---|---|
| 🔒 GET | `/dashboard/summary` |
| 🔒 GET | `/dashboard/revenue-series` |
| 🔒 GET | `/dashboard/peaks` |
| 🔒 GET | `/dashboard/items?sort=top\|slow&limit=` |
| 🔒 GET | `/dashboard/today-glance` |

`GET /dashboard/summary`
```json
{
  "from": "2026-11-18", "to": "2026-11-25",
  "revenue": 18450000, "prevRevenue": 15900000,
  "orderCount": 142,
  "payments": { "cash": 9800000, "transfer": 8650000, "free": 120000 },
  "bySource": { "dine": 15200000, "take": 1800000, "delivery": 1450000 },
  "discounts": 640000, "refunds": 0, "tips": 350000, "roundAdjust": 8000,
  "cancelledLines": 6, "cancelReasons": { "Khách đổi món": 4, "Lên nhầm món": 2 },
  "cogs": 5900000, "cogsPartial": false, "expenses": 3200000,
  "profit": 9350000,
  "topItems": [ { "name": "Bò lúc lắc", "qty": 64, "revenue": 8896000 } ]
}
```
`topItems` sắp theo `qty` giảm dần (trả tối đa 20). Định nghĩa từng chỉ số ở mục 5.4 và 5.7.

`GET /dashboard/revenue-series`
```json
{
  "granularity": "day",
  "from": "2026-11-18", "to": "2026-11-25",
  "total": 18450000, "prevTotal": 15900000, "orders": 142,
  "buckets": [ { "start": "2026-11-18T00:00:00+07:00", "revenue": 2450000, "orders": 18 } ]
}
```
`granularity` do server chọn (nhưng nhận `granularity` để ép):

| Điều kiện | Gộp theo |
|---|---|
| `range = today` | `hour` (đủ 24 cột 0–23, cột trống = 0) |
| số ngày ≤ 31 | `day` |
| số ngày ≤ 200 | `week` (bước 7 ngày bắt đầu từ `from`) |
| còn lại | `month` (đầu tháng dương lịch) |

**Mọi bucket phải có mặt kể cả doanh thu = 0**, để app vẽ trục liền mạch. `buckets[].orders` = số đơn **đóng** (không hủy) có `closedAt` trong bucket.

`GET /dashboard/peaks` → `{ "byHour": [24 số], "byWeekday": [7 số, Thứ 2 → Chủ nhật] }`: tổng `subtotal` các đơn đóng (không hủy) theo giờ/thứ của `closedAt`.

`GET /dashboard/items?sort=slow` → **mọi** món (kể cả bán 0), sắp theo số lượng bán tăng/giảm trong kỳ: `[{ itemId, name, price, qty }]`.

`GET /dashboard/today-glance` (cho thanh đầu trang Tổng quan, gọi nhẹ):
```json
{ "todayRevenue": 2450000, "openOrders": 7,
  "tables": { "free": 9, "busy": 6, "billing": 1, "cleaning": 2, "reserved": 3, "guests": 22 },
  "longestKitchenWaitSeconds": 720,
  "bookingsToday": 6, "bookingsWithinHour": 2,
  "openShift": { "openedBy": "Admin Test", "openedAt": "…", "cashIn": 1200000 },
  "alerts": { "lowStock": 3, "expiringLots": 2, "unavailableItems": 1 } }
```
`expiringLots`: lô còn hàng, hạn ≤ hôm nay + 3 ngày. `unavailableItems`: món `status = on` nhưng `available = false`.

**Báo cáo khác** (màn "Doanh thu & báo cáo"), dùng chung tham số khoảng thời gian:

| Path | Trả về |
|---|---|
| `GET /reports/profit-loss` | `{ revenue, cogs, expenses, profit, cogsPartial }` (5.7) |
| `GET /reports/item-margins` | Món có công thức: `{ itemId, name, price, cost, margin, marginPct }` sắp theo `margin` giảm dần |
| `GET /reports/month-progress` | `{ month, revenue, target }` cho tháng hiện tại |

### 4.16 Tìm kiếm

`GET /search?q=bo%20luc%20lac` → tìm **không dấu, không phân biệt hoa thường**, lưu cột chuẩn hóa không dấu để index.
```json
{ "items": [ { "type": "item|ingredient|customer|order|booking",
               "id": "…", "title": "Bò lúc lắc", "subtitle": "Món chính" } ] }
```
Tìm trên: món (`name`, `code`), nguyên liệu (`name`), khách (`name`, `phone`), đơn (`code`, `customerName`, `phone`), đặt bàn (`name`, `phone`). Trả tối đa 50.

### 4.17 Dữ liệu nhắc việc

`GET /reminders?from=&to=` trả danh sách **sự kiện nguồn** để app tự đặt thông báo cục bộ (BE **không** gửi push). Mỗi mục có khóa chống trùng `dedupeKey`:

```json
{ "items": [
  { "dedupeKey": "booking:{id}", "kind": "booking", "at": "2026-11-24T19:00:00+07:00",
    "refType": "booking", "refId": "…", "title": "Chị Hương", "party": 4, "note": "Sinh nhật" },
  { "dedupeKey": "low:{ingredientId}:2026-11-24", "kind": "low_stock", "at": "…",
    "refType": "ingredient", "refId": "…", "onHand": 1800, "minQty": 2500, "unit": "g" },
  { "dedupeKey": "exp:{lotId}", "kind": "expiry", "at": "2026-11-26T00:00:00+07:00",
    "refType": "lot", "refId": "…", "ingredientName": "Tôm", "remaining": 1800, "unit": "g" },
  { "dedupeKey": "bday:{customerId}:2026", "kind": "birthday", "at": "…",
    "refType": "customer", "refId": "…", "title": "Chị Hương" },
  { "dedupeKey": "shift:{shiftId}", "kind": "shift_open_long", "at": "…",
    "refType": "shift", "refId": "…", "openedAt": "…" }
] }
```

Quy tắc sinh:

| `kind` | Điều kiện |
|---|---|
| `booking` | Đặt bàn `booked`, `start` trong `[from, to)` (app dùng tối đa ~14 ngày tới) |
| `hold_expired` | Đặt bàn `booked`, hôm nay, `now > start + holdMinutes` |
| `low_stock` | `minQty > 0` và `onHand < minQty` (một mục/ngày) |
| `expiry` | Lô `remaining > 0` có `expiry ≤ hôm nay + 7 ngày` (kể cả đã quá hạn) |
| `shift_open_long` | Có ca mở > 10 giờ |
| `birthday` | Sinh nhật khách rơi trong 7 ngày tới (tính theo ngày/tháng) |

Trạng thái "đã xong / hoãn" của nhắc việc hiện **lưu cục bộ trên máy**, không đồng bộ. Nếu muốn đồng bộ đa máy, báo để thêm `PUT /reminders/{dedupeKey}/state` sau.

### 4.18 Xuất dữ liệu

App hiện tự dựng CSV; nếu BE cung cấp, **giữ đúng cột sau** (UTF-8, có header, tiền là số nguyên, thời gian ISO 8601):

| Path | Cột |
|---|---|
| `GET /exports/orders.csv?from=&to=` | `code,type,table,opened,closed,subtotal,discount,service,total,paid,status` |
| `GET /exports/revenue.csv?range=m3` | `date,revenue,orders` (theo ngày) |
| `GET /exports/stock.csv` | `ingredient,unit,on_hand,min,last_cost` |
| `GET /exports/closeout.csv?date=` | `date,revenue,cash,transfer,free,discounts,refunds,tips,orders` (dạng 2 cột `chỉ_tiêu,giá_trị`) |

### 4.19 Nhật ký và sức khỏe

| Method | Path | Mô tả |
|---|---|---|
| 🔒 GET | `/audit-log?from=&to=&cursor=` | Danh sách `AdminAction` (hiện app chưa có màn hình) |
| 🔓 GET | `/health` | `{ "status": "ok", "apiVersion": "1.0.0", "minAppVersion": "1.0.0" }` |

App kiểm `/health` lúc khởi động; `minAppVersion` > phiên bản app → hiển thị yêu cầu cập nhật.

---

## 5. Quy tắc nghiệp vụ (BẮT BUỘC)

### 5.1 Tiền của đơn

Tính **một lần ở cuối**, làm tròn **một lần**; không làm tròn từng dòng.

```
lineTotal        = (comp || cancelled) ? 0 : qty × unitPrice
subtotal         = Σ lineTotal
discountTotal    = min(Σ discounts.amount, subtotal)         // không âm, không vượt subtotal
serviceFee       = (kind == dine && serviceOn)
                     ? round((subtotal − discountTotal) × servicePct / 100)
                     : 0
rawTotal         = subtotal − discountTotal + serviceFee + surcharge + deliveryFee
total            = roundTo <= 1 ? rawTotal
                   : floor((rawTotal + roundTo/2) / roundTo) × roundTo      // làm tròn nửa lên
roundAdjust      = total − rawTotal                            // ghi riêng, có thể âm
paid             = Σ payments(kind ∈ {pay, deposit}).amount
refunded         = Σ payments(kind = refund).amount
tips             = Σ payments(kind = tip).amount
due              = max(0, total − paid + refunded)
```

`round()` là làm tròn nửa lên về số nguyên. Phí phục vụ **chỉ áp cho đơn `dine`**; giảm giá chia theo đơn nên **chưa** có giảm theo từng dòng (nếu cần sẽ bổ sung `lineId` cho `discount`).

### 5.2 Giá chốt

Giá lưu ở `OrderLine.unitPrice` tại **thời điểm gọi món**. Đổi giá món, đổi giá hàng loạt, xóa món không được làm thay đổi đơn đã tạo. Combo/giá theo khung giờ hiện **chưa có** trong app.

### 5.3 Trừ kho theo công thức (FEFO)

- **Thời điểm trừ: khi đóng đơn**, không phải lúc gọi/gửi bếp.
- Với mỗi dòng **không `cancelled`** (kể cả `comp` — món tặng vẫn tốn nguyên liệu), với mỗi `RecipeLine` của món: tiêu hao `recipe.qty × line.qty`.
- Hao hụt chuẩn (`yieldLossPercent`) **chưa dùng** trong app; công thức đã là lượng thực dùng.
- **FEFO**: trừ lần lượt các lô còn hàng (`remaining > 0`) theo `expiry` tăng dần (lô không có hạn xếp **cuối**). Mỗi lô trừ `min(còn cần, remaining)`.
- Ghi **một** `StockMove(kind=sale, qty = −tổng)` cho mỗi nguyên liệu mỗi dòng (note = `Đơn {code}`), kể cả khi lô không đủ (**tồn cho phép âm**; không chặn bán, chỉ cảnh báo).
- Món **không có công thức** → không trừ kho và không tính giá vốn (hiện "chưa có công thức").
- **Hủy dòng trước khi nấu** (`draft`/`sent`/`cooking`): không trừ gì (vì chưa đóng đơn).
- **Hủy dòng đã `done`/`served`**: món đã nấu nên **ghi hao hụt ngay**: với mỗi `RecipeLine` ghi `StockMove(kind=waste, qty = −recipe.qty × line.qty)` trừ FEFO, note `Hủy món {name}`. Đồng thời dòng này không còn trong `subtotal` nên **sẽ không bị trừ lần nữa khi đóng đơn**.
- `onHand(ingredient) = Σ StockMove.qty`.

### 5.4 Doanh thu

- **Doanh thu = Σ `Payment(kind=pay, method≠free).amount` − Σ `Payment(kind=refund, method≠free).amount`**, tính theo **thời điểm ghi thanh toán (`at`)**, của các đơn **không `cancelled`**.
- **Không gồm**: tiền boa (`tip`), tiền cọc (`deposit`), thanh toán `free`.
- Hoàn tiền trừ vào kỳ **ghi nhận hoàn** (không trừ ngược về kỳ của đơn gốc).
- `payments.cash|transfer|free` trong summary: tổng `kind=pay` theo `method` (không trừ hoàn). `free` là giá trị miễn phí, báo riêng.
- `orderCount`: đơn `closed`, không `cancelled`, có `closedAt` trong kỳ.
- `bySource`: tổng **`subtotal`** của các đơn đóng trong kỳ, theo `kind` (khác doanh thu thu được, dùng để xem cơ cấu bán).
- `discounts`: tổng `discountTotal` các đơn đóng trong kỳ.
- `cancelledLines` / `cancelReasons`: dòng `cancelled` thuộc đơn **mở trong kỳ** (`openedAt`), nhóm theo `cancelReason` (rỗng → `"-"`).
- `roundAdjust`: tổng `roundAdjust` các đơn đóng trong kỳ.
- `tips`, `refunds`: tổng theo `at` trong kỳ.

### 5.5 Ca và quỹ tiền mặt

```
cashIn(shift) = Σ over payments with method = cash, at ∈ [shift.openedAt, shift.closedAt ?? ∞):
                   refund  → −amount
                   deposit → 0
                   pay, tip → +amount
expectedCash  = startCash + cashIn + Σ cashEntries(shift).amount
difference    = countedCash − expectedCash
```
Đóng ca bị chặn khi còn đơn `open` (toàn nhà hàng, không chỉ trong ca).

### 5.6 Món bán được hay không

`available = (status == on) AND ∀ recipeLine: onHand(ingredient) ≥ recipeLine.qty`.
`unavailableReason = "status"` nếu `status ≠ on`, `"stock"` nếu thiếu nguyên liệu. Món **không có công thức** chỉ phụ thuộc `status`. Tồn âm được phép nhưng khi `onHand < qty` thì món tự báo hết.

### 5.7 Giá vốn và lãi lỗ

```
itemCost(item)  = Σ recipe.qty × latestUnitCost(ingredient)     // latest = lô có receivedAt mới nhất
                  null nếu món không có công thức, hoặc BẤT KỲ nguyên liệu nào chưa có lô (giá 0)
cogs(period)    = Σ over closed orders in period, over active lines:
                     itemCost(item) × qty       // dòng có itemCost = null thì BỎ QUA và đặt cogsPartial = true
profit          = revenue − cogs − expenses
```
- Mọi con số này là **ước tính**; app luôn hiển thị nhãn "ước tính". `cogsPartial = true` để app cảnh báo thiếu công thức.
- `expenses` = tổng `Expense.amount` có `date ∈ [from, to)`. Chưa tính hao hụt, chưa tính nhập hàng (nhập hàng là tài sản kho, không phải chi phí kỳ).
- `margin = price − cost`; `marginPct = round(margin × 100 / price)`.

### 5.8 Mã giảm giá

Hợp lệ khi **tất cả**: tồn tại (so khớp `code` không phân biệt hoa thường); `end` trống hoặc `hôm nay ≤ end` (**hết hạn sau hết ngày `end`**); `limit = 0` hoặc `used < limit`; `subtotal ≥ minAmount`.
Số giảm: `percent → round(subtotal × value / 100)`, `amount → value`. Sau đó áp trần `discountTotal ≤ subtotal` (5.1).
`used` tăng khi **áp mã**. Khuyến nghị BE **giảm lại** khi gỡ giảm giá đó hoặc hủy đơn (app hiện chưa làm).

### 5.9 Điểm thân thiết

Khi đóng đơn có `customerId`: `points += floor(total / 10000)`. Hiện **không** quy đổi điểm thành giảm giá. Đơn tạo với `phone` khớp một `Customer` thì tự gắn `customerId`, điền `customerName` (nếu trống) và `allergy` mặc định từ khách. **Không tự tạo khách mới** từ đơn (khách được tạo thủ công).

### 5.10 Trạng thái bàn

| Sự kiện | Chuyển |
|---|---|
| Mở bàn | `free` → `busy` |
| Thanh toán đủ (`due = 0`) trên đơn `dine` đang mở | `busy` → `billing` |
| Đóng đơn | → `cleaning` |
| Dọn xong | `cleaning` → `free` |
| Hủy đơn | → `free` |
| Chuyển bàn | bàn cũ `free`, bàn đích `busy` |
| Ghép bàn | bàn nguồn `cleaning` |
| Mở lại đơn | → `busy` |
| Hủy/xóa dòng thanh toán khiến `due > 0` | `billing` → `busy` |

### 5.11 Số hiệu đơn

`code = {B|M|G}{number:3 chữ số}`, `B` = `dine`, `M` = `take`, `G` = `delivery`. `number` = số thứ tự trong **ngày làm việc** của nhà hàng, **chung cho mọi loại đơn** (không tách theo `kind`), bắt đầu từ 1 mỗi ngày. `code` **không duy nhất toàn cục** (lặp lại mỗi ngày); dùng `id` để tham chiếu.

### 5.12 Ngày làm việc

Hiện app dùng **ngày dương lịch** theo múi giờ nhà hàng. Nếu quán mở quá nửa đêm và cần "giờ chốt ngày" (ví dụ 04:00), BE thêm `shop.dayCutoffMinute` và áp cho mọi phép "theo ngày" ở mục 4.15; báo lại để app hiển thị cho khớp.

---

## 6. Dữ liệu cá nhân và bảo mật (yêu cầu cho BE)

- Băm mật khẩu bằng Argon2id/bcrypt; **không** có tài khoản/mật khẩu mặc định trong mã hoặc tài liệu công khai.
- Kiểm token và `mustChangePassword` ở **mọi** endpoint; giới hạn thử đăng nhập.
- **Không ghi nội dung request/response (đặc biệt `allergy`, `phone`, mật khẩu, token) vào log.**
- Xóa tài khoản và xóa hồ sơ khách là **xóa thật** (không chỉ đánh dấu), kể cả trong bản sao lưu theo chu kỳ lưu giữ đã công bố.
- Dữ liệu nhạy cảm (dị ứng có thể là thông tin sức khỏe) chỉ trả cho admin đã đăng nhập.
- Sao lưu định kỳ; môi trường **thử nghiệm riêng** cho người duyệt Google Play: tài khoản admin thử + dữ liệu thử, **không hết hạn**, máy chủ ổn định trong lúc duyệt.
- CORS không cần (app native). Bật HSTS, TLS ≥ 1.2.
- Mọi ghi nhạy cảm (mục 3.13) phải ghi `AdminAction` kèm tên người thực hiện.

---

## 7. Câu hỏi mở (cần BE/PO chốt)

1. **Đăng ký.** App có tab "Đăng ký" cho phép **tự tạo tài khoản admin**. Với mô hình *một nhà hàng, nhiều admin dùng chung*, mở đăng ký công khai nghĩa là ai cũng có thể tự trở thành admin của nhà hàng. Đề xuất: (a) chỉ cho đăng ký khi hệ thống **chưa có admin nào** (bootstrap lần đầu), sau đó chỉ admin hiện tại thêm người qua `POST /admins`; hoặc (b) đăng ký tạo **một nhà hàng/tenant mới** (cần thêm `shopId` vào mọi bảng). Cần chốt trước khi làm xác thực.
2. **Đa nhà hàng.** Tài liệu này giả định **một nhà hàng, không có `shopId`**. Nếu chọn phương án (b) ở trên thì mọi endpoint và bảng cần phân vùng theo tenant.
3. **Mở lại đơn và kho.** `reopen` hiện không hoàn lại các bút toán `sale` đã trừ khi đóng, nên đóng lại sẽ trừ **lần hai**. Đề xuất: `reopen` ghi bút toán hoàn (`kind=sale`, `qty` dương, hoàn về lô) và đóng lại trừ lại. Cần BE xác nhận để số kho không lệch.
4. **Mã giảm giá khi gỡ/hủy đơn:** có giảm `used` không (đề xuất: có).
5. **Chi phí lặp hằng tháng:** BE tự sinh bản ghi hay chỉ lưu nhãn `recurring` (đề xuất: chỉ nhãn).
6. **Trạng thái nhắc việc đa máy:** có cần đồng bộ "đã xong/hoãn" không (xem 4.17).
7. **Tính năng trong đặc tả gốc mà app bản này CHƯA có** (BE chưa cần làm): combo/set, giá theo khung giờ, thực đơn hôm nay, nhập CSV thực đơn, lịch làm việc và chấm công nhân viên, chia tiền boa theo quy tắc, bán thành phẩm, phản hồi/khiếu nại khách, thông tin chuyển khoản và mã QR, danh sách thiết bị đăng nhập, checklist mở/đóng cửa, việc cần làm, ghi chú nhanh.

---

## Phụ lục A – Màn hình ↔ endpoint

| Màn hình app | Endpoint chính |
|---|---|
| Đăng nhập / đăng ký | `/auth/login`, `/auth/register`, `/auth/refresh`, `/health` |
| Tổng quan | `/dashboard/today-glance`, `/dashboard/summary`, `/dashboard/revenue-series`, `/dashboard/items`, `/reminders` (số chưa đọc) |
| Thông báo | `/reminders` |
| Bàn & đơn › Sơ đồ | `/floor`, `/tables/{id}/open`, `/tables/{id}/clean` |
| Đơn (gọi món, thanh toán) | `/orders/*`, `/menu-items`, `/menu-groups` |
| Bếp | `/kitchen`, `/orders/{id}/lines/{lineId}/start|done|served` |
| Mang đi / giao | `/orders`, `/orders/{id}/delivery-status`, `/staff` |
| Đặt bàn | `/bookings*`, `/wait-list` |
| Ca & quỹ | `/shifts*`, `/cash-entries`, `/day-close` |
| Quản lý › Thực đơn | `/menu-groups`, `/menu-items`, `/menu-items/{id}/recipe`, `/menu-items/bulk-price` |
| Quản lý › Khu vực & bàn | `/areas`, `/tables` |
| Quản lý › Kho | `/ingredients`, `/stock-lots`, `/stock-moves`, `/stock/*` |
| Quản lý › Nhập hàng | `/purchases`, `/suppliers` |
| Quản lý › Nhân viên | `/staff` |
| Quản lý › Khách & khuyến mãi | `/customers`, `/promotions` |
| Quản lý › Chi phí | `/expenses` |
| Quản lý › Doanh thu & báo cáo | `/dashboard/*`, `/reports/*`, `/sales-targets/{yyyy-MM}` |
| Quản lý › Hồ sơ & quy tắc | `/shop`, `/shop/rules` |
| Tài khoản | `/me`, `/admins*`, `/auth/change-password`, `/exports/*`, `/search` |

## Phụ lục B – Kiểm thử BE cần có

- Hai máy cùng thêm món vào một bàn (cả hai cùng thành công, không mất dòng).
- Hai đặt bàn cùng bàn chồng giờ (một thắng, một `booking_overlap`); sửa đặt bàn không tự trùng với chính nó.
- Mất mạng giữa chừng khi đóng đơn / ghi thanh toán: gọi lại cùng `Idempotency-Key` không thu trùng.
- `401` hết hạn token, `409 version_conflict`, `429`, `5xx`, phản hồi chậm.
- Đơn có giảm giá + phí phục vụ + làm tròn: `total`, `roundAdjust` khớp công thức 5.1 (bao gồm trường hợp `roundTo = 1`).
- Chia đều thanh toán: tổng các phần = `total`, phần dư dồn người cuối (do app), `due` về đúng 0.
- Trừ kho FEFO đúng lô sắp hết hạn; hủy món sau khi nấu ghi `waste` và không trừ lần hai khi đóng đơn; tồn âm vẫn bán được.
- Kiểm kho dương/âm tạo đúng bút toán `count`; xóa lô và xóa phiếu nhập hoàn kho đúng.
- Đóng ca bị chặn khi còn đơn mở; `expectedCash` khớp 5.5 (có hoàn tiền mặt, có thu chi).
- Doanh thu không gồm `tip`, `deposit`, `free`, đơn hủy; hoàn tiền trừ vào kỳ ghi nhận.
- Series đủ bucket cho từng `granularity`, kể cả bucket doanh thu 0.
- Admin cuối cùng không xóa/thu hồi được; tài khoản `mustChangePassword` bị chặn ở mọi endpoint khác.
- Xóa khách/tài khoản xóa thật; tìm kiếm không dấu ("bo luc lac" khớp "Bò lúc lắc").
