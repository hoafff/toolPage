# Video Auto Scheduler — Một Facebook Page / một thư mục

## Cách sử dụng

1. Chạy npm start rồi mở http://127.0.0.1:3210.
2. Đồng bộ Page với Meta Login/user token hợp lệ bằng nút Kết nối Facebook.
3. Trong Video Auto Scheduler, chọn từng Page và nhập thư mục tuyệt đối đã tồn tại trên máy chạy Node (ví dụ D:\FacebookVideos\Page01). Mỗi Page một thư mục riêng.
4. Chọn giờ đăng hàng ngày cách nhau bằng dấu phẩy, ví dụ 08:00,18:00 theo giờ Việt Nam (Asia/Ho_Chi_Minh, UTC+7 cố định); nhập caption và bật theo dõi.
5. Thêm MP4/MOV/M4V vào thư mục; giữ file không thay đổi ít nhất 30 giây. Server quét mỗi 30 giây khi đang chạy. Bấm Quét thư mục để quét thủ công.
6. File được xếp theo tên và slot trống tương lai, tối đa 12 giờ/ngày cho một Page, không đi vào thư mục con hay symlink. Không xóa file nguồn.

## Muốn tự đăng thật qua Meta

Cần Page được đồng bộ từ chính Meta, Page Access Token chính chủ có task CREATE_CONTENT và permissions pages_show_list, pages_read_engagement, pages_manage_posts. Meta App Review có thể cần cho các trường hợp khác người có vai trò trong app.

Ví dụ PowerShell (placeholder, KHÔNG đưa token vào Git/log):

~~~powershell
$env:TOOLPAGE_META_USER_TOKEN = '<YOUR_USER_TOKEN>'
$env:TOOLPAGE_PAGE_TOKEN_123456789 = '<PAGE_TOKEN_FOR_ID_123456789>'
$env:TOOLPAGE_LIVE_PUBLISH = '1'
$env:TOOLPAGE_GRAPH_VERSION = 'v26.0'
npm start
~~~

Vào video scheduler và bấm Bật LIVE (xác nhận). LIVE **không tự bật sau restart**. Mỗi Page cần token riêng đúng Page ID. Máy Node phải chạy và có Internet lúc đến giờ. Browser có thể đóng sau khi server đã chạy.

Mã gửi file stream multipart đến Meta Page Videos endpoint POST https://graph-video.facebook.com/v26.0/{page-id}/videos, fields source, published=true, description. Video Page thông thường, **không phải Reels**. Max 1.000.000.000 bytes, upload lớn cần resumable API trong tương lai. Công cụ không kiểm codec/độ dài, Meta có thể từ chối.

## Trạng thái và chống đăng trùng

- READY: đã lập lịch nhưng chưa gửi.
- UPLOADING: đã claim trước HTTP request; crash khi đang upload chuyển UNCERTAIN khi restart.
- SUBMITTED: Meta HTTP OK + video ID, **chưa xác nhận video đã công khai**.
- UNCERTAIN: có thể Meta đã nhận upload dù mất mạng; KHÔNG tự retry. Cần kiểm tra Page thật để tránh duplicate.
- FAILED: lỗi nội bộ rõ ràng hoặc Meta trả lỗi; không tự retry.
- CANCELLED: owner hủy job READY.

Mỗi file được định danh bởi Page + filename + size + mtime; quét lặp/restart không lên lịch lại cùng file. Đổi tên/sửa file tạo fingerprint mới, có nguy cơ tạo job mới nên cần kiểm tra khi Meta chưa trả kết quả. Không tự chuyển file Done.

Bật tắt theo dõi qua checkbox trong config Page. Chỉnh giờ ảnh hưởng job phát sinh mới; job cũ giữ lịch. Không tự chạy khi Node đã tắt. Job UNCERTAIN không được lên lịch lại. Muốn đổi folder khi còn job READY/UPLOADING/UNCERTAIN sẽ bị chặn để bảo đảm không dùng path sai.

## Kiểm chứng

GitHub Actions Node 22/24 chạy synthetic SQLite, file fixture, mock Meta transport, guard và crash recovery; **chưa thử đăng video thật trên Page của owner, chưa verify Meta processing/publication**, chưa nghiệm thu trên Windows. Token/credentials không đưa vào SQLite/JSON response/Git.

Meta references:
- https://developers.facebook.com/docs/graph-api/reference/page/videos/
- https://developers.facebook.com/docs/video-api/guides/publishing/
- https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api

## Trạng thái phạm vi

Đã code: folder cấu hình, quét video, slot hàng ngày, SQLite queue, cancel, pause/resume config, manual arming LIVE, Meta multipart transport, ACK status, fail-closed unknown. Chưa code: OAuth UI, encrypted token vault, resumable uploads, tự đọc Meta status, Reels, backup migration, end-to-end owner acceptance.
