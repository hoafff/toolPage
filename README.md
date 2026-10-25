# toolPage — Facebook Pages localhost workspace

Web app nhỏ cho khoảng **10 Facebook Page** từ Windows localhost; dark sidebar, **không Electron, không Instagram**.

**v0.2:** Page/Group/Draft CRUD với SQLite và **Video Auto Scheduler: 1 Page / 1 thư mục video**, queue + worker 30 giây, stream multipart Meta video khi opt-in. **Chưa có OAuth UI; chưa nghiệm thu live posting**.

## Chạy

- Node.js >= 22.13 (khuyến nghị Node 24.x; dùng node:sqlite)
- Không cần npm install, Docker, Python, FFmpeg.

~~~powershell
git clone https://github.com/hoafff/toolPage.git
cd toolPage
node --version
npm start
~~~

Mở http://127.0.0.1:3210 . Database tự tạo tại data/toolpage.sqlite. Dừng bằng Ctrl+C. Kiểm thử bằng npm test.

Port khác đặt TOOLPAGE_PORT. Database path khác đặt TOOLPAGE_DB. Server chỉ bind 127.0.0.1.

## Đồng bộ Page qua Meta (tùy chọn)

Yêu cầu Meta App, Facebook Login và các quyền phù hợp như pages_show_list. Có thể cần App Review/Advanced Access cho sản phẩm thực tế. Không dùng cookie scraping hoặc checkpoint.

Đặt user token của chính owner trong biến môi trường PowerShell tại máy đang chạy. Không commit token:

~~~powershell
$env:TOOLPAGE_META_USER_TOKEN = '<TOKEN_CUA_OWNER>'
$env:TOOLPAGE_GRAPH_VERSION = 'v24.0'
npm start
~~~

Vào tab Kết nối Facebook, bấm Đồng bộ Page. Server thực hiện GET /me/accounts?fields=id,name,tasks; chỉ lưu Page ID/tên. Không lưu token trong database hoặc UI. Tắt server và xóa biến môi trường khi xong: Remove-Item Env:TOOLPAGE_META_USER_TOKEN.

**Video Auto Scheduler**: vào mục mới trên sidebar, chọn Page, đường dẫn folder trên máy Node, giờ đăng Việt Nam, nhập caption. Đăng thật đòi Page token, permission phù hợp, biến môi trường TOOLPAGE_LIVE_PUBLISH=1 và bấm xác nhận trên UI cho mỗi phiên Node. Có Graph upload adapter và kiểm thử synthetic, chưa có owner live acceptance.

## Bảo mật

Bind loopback, kiểm Host và Origin, custom action header + JSON cho mutation, CSP, no CORS, file DB và .env bỏ khỏi git. Local Page không phải tài khoản Facebook thật.

## Hướng dẫn Video Auto Scheduler

Xem [docs/VIDEO_SCHEDULER.md](docs/VIDEO_SCHEDULER.md) để dùng thư mục riêng từng Page, thiết lập giờ đăng, Page token, và hiểu trạng thái UNCERTAIN chống đăng trùng. Khi Node tắt sẽ không tự đăng. Không dùng cho Reels.

## Cây chức năng

Xem [docs/FEATURE_TREE.md](docs/FEATURE_TREE.md): từng mục lớn, chức năng con, trạng thái hiện có/đề xuất/bỏ so với LoHaPage.

## Dự án mã nguồn mở tham khảo (không chép source)

- [Mixpost Lite](https://github.com/inovector/mixpost) — MIT, tham khảo UX scheduler; PHP/Laravel nên không fork.
- [Postiz](https://github.com/gitroomhq/postiz-app) — AGPL-3.0, nhiều dịch vụ; không phù hợp cho localhost nhẹ.
- [Meta Business SDK](https://github.com/facebook/facebook-nodejs-business-sdk) — API official SDK; v0.1 dùng fetch Graph trực tiếp để không thêm dependency.

Mã nguồn toolPage v0.1 mới hoàn toàn; không đẩy vendor ASAR/React bundle, token, cookie, profile hoặc dữ liệu cũ của repo LoHaPage (private) lên repo công khai này.
