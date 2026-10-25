# toolPage — Facebook Pages localhost workspace

Web app nhỏ cho khoảng **10 Facebook Page** từ Windows localhost; dark sidebar, **không Electron, không Instagram**.

**v0.1:** Page/Group/Draft CRUD dùng SQLite thực, giao diện Web localhost; tùy chọn đồng bộ Page id/name qua Graph API khi owner đã có Meta user token. **Chưa có OAuth trong app, không tự đăng bài, không có worker.**

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

Chức năng live publishing yêu cầu Page token, quyền pages_manage_posts và kiểm định riêng; **chưa được triển khai**.

## Bảo mật

Bind loopback, kiểm Host và Origin, custom action header + JSON cho mutation, CSP, no CORS, file DB và .env bỏ khỏi git. Local Page không phải tài khoản Facebook thật.

## Cây chức năng

Xem [docs/FEATURE_TREE.md](docs/FEATURE_TREE.md): từng mục lớn, chức năng con, trạng thái hiện có/đề xuất/bỏ so với LoHaPage.

## Dự án mã nguồn mở tham khảo (không chép source)

- [Mixpost Lite](https://github.com/inovector/mixpost) — MIT, tham khảo UX scheduler; PHP/Laravel nên không fork.
- [Postiz](https://github.com/gitroomhq/postiz-app) — AGPL-3.0, nhiều dịch vụ; không phù hợp cho localhost nhẹ.
- [Meta Business SDK](https://github.com/facebook/facebook-nodejs-business-sdk) — API official SDK; v0.1 dùng fetch Graph trực tiếp để không thêm dependency.

Mã nguồn toolPage v0.1 mới hoàn toàn; không đẩy vendor ASAR/React bundle, token, cookie, profile hoặc dữ liệu cũ của repo LoHaPage (private) lên repo công khai này.
