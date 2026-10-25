# Cây chức năng toolPage — Facebook Pages only

Tài liệu để owner chọn phạm vi. Đánh dấu [x] là có route/handler thực tế trong phiên bản v0.1. Không gán hoàn thành cho mục thiếu.

## Đề xuất cho khoảng 10 Facebook Page

- **01. Tổng quan**
  - [x] Tổng Page, Group, bài nháp
  - [ ] Trạng thái đồng bộ/đăng từng Page; log lỗi API và reconnect
- **02. Facebook Pages**
  - [x] Danh sách tối đa 10 Page, thêm local, tìm kiếm, xóa có guard
  - [x] Đồng bộ Page id/name từ Meta qua token chỉ đọc trong môi trường (bấm tay)
  - [x] Nhóm Page CRUD, Page membership và member count
  - [ ] Meta OAuth/Login, encrypted token vault, token expiry, quyền Page
  - [ ] Lọc theo quyền/connection status
- **03. Nội dung**
  - [x] Bản nháp theo Page (SQLite CRUD)
  - [x] Thời gian dự kiến lưu trong draft (không có scheduler)
  - [x] **Video Auto Scheduler mỗi Page một thư mục: scan/slot hằng ngày/queue SQLite/stop và cancel**
  - [x] **Meta Page Videos upload adapter với Page token + owner confirmation** (mock HTTP test PASS)
  - [ ] **Kiểm chứng đăng video thật và Meta processing/hiển thị**, OAuth/secure vault
  - [ ] Content Pool/Spintax/CSV TXT import
  - [ ] Media Pool ảnh/video, thư viện và upload Graph
  - [ ] Bulk composer (chọn nhiều Page, xác nhận riêng)
  - [ ] Queue scheduling + retry/idempotency/pause
  - [ ] Đăng Page thật với Page token hợp lệ/owner confirmation
- **04. Tương tác**
  - [ ] Read comments/replies Page nếu được Meta cấp quyền
  - [ ] Quy tắc keyword, gợi ý reply và duyệt thủ công
  - [ ] Hide/reply comment có xác nhận; Messenger Inbox hoãn
- **05. Báo cáo**
  - [ ] Bài đã đăng, lỗi, mức tương tác theo Graph cho phép
  - [ ] Export CSV, audit log, cảnh báo token/API-limit
- **06. Cài đặt**
  - [x] Localhost loopback, SQLite, no Electron, fail-closed live publish
  - [x] Không bao giờ lưu user access token vào repo/SQLite/UI
  - [ ] Backup/restore, Meta OAuth vault mã hóa

## Giữ/bỏ so với LoHaPage

**Giữ và làm gọn:** Dashboard, Pages, Groups, Posts, Content Pool, Media, Scheduler/Queue, comment management, reporting.

**Bỏ hẳn:** Instagram, Electron, ASAR, license vendor, toàn bộ dự án V8 reverse engineering, proxy/token farm, Telegram, auto-story/avatar/cover, video render AI, crawler/scraping hàng loạt, Bio hàng loạt.

**Tùy chọn sau khi có bằng chứng:** CSV/TXT import, Spintax, post rotation, bulk composer có xác nhận và thống kê Graph.

## Tái sử dụng

Tham khảo mô hình logic và test design của LoHaPage: foreign keys SQLite, transaction/rollback, Page/Group relations, draft, Content Pool cursor, worker/idempotency, local-only network/owner consent. KHÔNG sao chép React bundle/ASAR gốc, profile, token, cookie, SQLite owner hay mã proprietary sang repo public.

## Quy tắc sản phẩm

Page local chỉ là metadata; Meta Page được đồng bộ id/name qua /me/accounts, không đồng nghĩa có quyền publish. Draft có scheduled_at chỉ là ý định, không chạy. Video Auto Scheduler dùng queue riêng. Chỉ khi opt-in LIVE với Page token và xác nhận mới gọi Meta write. Chưa nghiệm thu live, SUBMITTED chỉ là Meta ACK.
