# DineDesk API — ghi chú ghép cho FE

Làm theo [DineDesk-API.md](DineDesk-API.md). Mục này chỉ nêu **những chỗ thêm / khác / đã chốt**.

## Đã chốt các câu hỏi mở (mục 7)

| # | Quyết định |
|---|---|
| 1 Đăng ký | Phương án (a): `POST /auth/register` chỉ chạy khi **chưa có admin nào** (admin đầu tiên). Sau đó → `403 registration_closed`; thêm người bằng `POST /admins`. Môi trường duyệt Google Play có thể đặt `REGISTRATION_OPEN=true`. FE nên ẩn tab "Đăng ký" khi nhận `registration_closed`. |
| 2 Đa nhà hàng | Một nhà hàng, không có `shopId`. |
| 3 Mở lại đơn | `reopen` **hoàn kho**: ghi bút toán `sale` dương, trả về đúng các lô đã trừ; đóng lại sẽ trừ lại. Điểm thân thiết cũng bị trừ lại. |
| 4 Mã giảm giá | `used` **giảm lại** khi gỡ giảm giá đó hoặc hủy đơn. Một mã chỉ áp một lần trên một đơn. |
| 5 Chi phí lặp | Chỉ lưu nhãn `recurring`. |
| 6 Nhắc việc đa máy | Chưa đồng bộ trạng thái. |

## Thêm so với tài liệu

- **Quên mật khẩu** (làm như `rent_rack_api`, tài liệu gốc chưa có):
  - `POST /auth/forgot { email }` → `202 { status: "accepted" }` (luôn như nhau dù email có tồn tại hay không; tối đa 3 lần/giờ/email). Mã 8 ký tự gửi qua email, hết hạn sau 30 phút, dùng một lần. Khi chưa cấu hình SMTP và không phải production, mã trả trong `devToken`.
  - `POST /auth/reset { token, newPassword }` → `204`. Mã sai/hết hạn → `400 reset_invalid`. Thành công: đăng xuất mọi thiết bị, `mustChangePassword = false`, gửi email báo đã đổi.
  - `POST /auth/change-password` cũng đăng xuất các thiết bị khác và gửi email báo.
- `GET /menu-items/{id}/recipe`, `GET /wait-list`, `POST /wait-list`, `GET /menu-items/{id}`.
- `POST /tables/{id}/open` nhận `Idempotency-Key`.
- Trang web công khai `GET /privacy`, `GET /account/delete` (xóa tài khoản theo yêu cầu Google Play). Admin cuối cùng không xóa được (`409 last_admin`).
- Header `X-App-Version` thấp hơn `MIN_APP_VERSION` → `426 upgrade_required` (trừ `/health`).

## Quy ước lỗi (khớp mục 1.7)

- Body: `{ code, message, details?, requestId }`.
- Dữ liệu sai: `400 validation_failed` với `details: { field, reason }` (`required`, `invalid_type`, `invalid_format`, `invalid_enum`, `too_long`, `min_N`, `max_N`, `weak_password`, `not_found`).
- Chỉ ba chỗ là `422 validation_failed` (đúng như tài liệu): thiếu/thừa lựa chọn của món (`details.reason = required_group | single_choice | unknown_choice`), thanh toán vượt `due` (`exceeds_due`), hoàn tiền vượt đã thu (`exceeds_paid`).
- Token: access hết hạn → `401 token_expired` (FE gọi `refresh` một lần); mọi trường hợp token sai/phiên bị thu hồi/`refresh` thất bại → `401 unauthorized`.
- Mã mới ngoài bảng: `403 registration_closed`, `400 reset_invalid`, `409 duplicate` (trùng nhãn bàn / mã khuyến mãi), `409 request_in_progress` (cùng `Idempotency-Key` đang chạy), `422 same_password`, `422 invalid_state` (thao tác không hợp lệ với trạng thái hiện tại, vd. đóng món đã hủy, thanh toán đơn đã đóng), `426 upgrade_required`.
- `429 rate_limited` kèm `Retry-After`. Đăng nhập sai 5 lần → khóa email 15 phút (`429`).

## Thêm khi ghép app Flutter

- `POST` tạo danh mục (`/areas`, `/tables`, `/menu-groups`, `/menu-items`, `/ingredients`, `/suppliers`, `/staff`, `/customers`, `/promotions`, `/expenses`, `/wait-list`) nhận thêm `id` do app sinh (8-64 ký tự `A-Za-z0-9_-`); trùng → `409 duplicate`. Nhờ vậy app đồng bộ được các chỉnh sửa tại chỗ mà không phải đổi id.
- Món (`/menu-items`) trả thêm `recipe: [{ingredientId, qty}]` để app tính "còn bán được không" ngay khi tồn kho đổi.
- Ca (`/shifts`, `/shifts/current`) trả thêm `cashIn` (tiền mặt thu trong ca) và `entriesTotal` (tổng thu chi tay).
- Đặt bàn/đơn/ca/kho là thao tác chờ máy chủ trả lời (không lạc quan); danh mục sửa tại chỗ được gửi sau 0,4 giây, lỗi thì app báo và tải lại từ máy chủ.

## Chỗ tài liệu để ngỏ, đã chọn

- `GET /shifts/current` khi chưa có ca → `404 not_found`.
- Đơn: `from`/`to` của `GET /orders` lọc theo `openedAt`. Danh sách trả đầy đủ đơn (có `lines`, `totals`).
- Thời gian trả dạng `2026-11-24T19:05:00+07:00` theo `shop.timezone`.
- `If-Match` nhận `7` hoặc `"7"`; hoặc `"version"` trong body. Không gửi thì thao tác sửa vẫn chạy (chỉ thêm món luôn là thao tác nối).
- **Ghép bàn** chuyển cả `lines`, `discounts` **và `payments`** của đơn nguồn sang đơn đích (nếu không, tiền đã thu sẽ biến mất cùng đơn bị hủy).
- `GET /floor`: `nextBooking` gồm cả đặt bàn trễ giờ nhưng còn trong thời gian giữ bàn (`holdMinutes`), để bàn không hiện "trống" khi khách sắp tới.
- `today-glance.tables.free` là số bàn `free` thật; `reserved` là tập con trong đó (bàn trống nhưng có đặt trước).
- `topItems`/`dashboard/items` tính trên dòng không hủy của đơn đã đóng (tặng món vẫn tính số lượng, `revenue` = 0).
- Gỡ/hủy dòng đã gửi bếp: dòng `draft` xóa bằng `DELETE`; `cancel` dùng được cho mọi dòng chưa hủy.
- `exports/closeout.csv`: hai cột `chỉ_tiêu,giá_trị`. CSV không có BOM.
- Món `available` chỉ kiểm **một phần** theo công thức (5.6); gọi nhiều phần vẫn được (tồn cho phép âm).
- Xóa đặt bàn / xóa khách / xóa nhân viên / xóa nguyên liệu / xóa phiếu nhập đều là xóa thật (có ghi `AdminAction` ở những chỗ mục 3.13 yêu cầu).

## Việc cần làm một lần

`npm run db:init` (tạo index unique: email, nhãn bàn, SĐT khách, mã khuyến mãi).
