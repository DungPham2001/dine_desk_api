/**
 * Public privacy policy page (Google Play requirement): GET /privacy (?lang=en).
 * The text describes what this API actually stores; keep it in sync when data handling changes.
 * Owner and contact come from PRIVACY_OWNER / PRIVACY_EMAIL.
 */
const express = require('express');
const config = require('../config');
const { langOf } = require('../i18n');

const OWNER = process.env.PRIVACY_OWNER || 'DineDesk';
const EMAIL = process.env.PRIVACY_EMAIL || 'support@example.com';
const UPDATED = '2026-11-24';

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const base = () => config.publicBaseUrl || '';
const mail = `<a href="mailto:${esc(EMAIL)}">${esc(EMAIL)}</a>`;

const content = {
  vi: {
    title: 'Chính sách quyền riêng tư DineDesk',
    updated: `Cập nhật lần cuối: ${UPDATED.split('-').reverse().join('/')}`,
    other: '<a href="?lang=en">English</a>',
    sections: [
      ['Chúng tôi là ai', [`DineDesk là ứng dụng quản lý nhà hàng dành cho chủ và quản lý quán, do <strong>${esc(OWNER)}</strong> phát triển và chịu trách nhiệm về dữ liệu. Liên hệ: ${mail}.`]],
      ['Dữ liệu chúng tôi lưu', [[
        '<strong>Tài khoản quản trị:</strong> email, họ tên, số điện thoại, ngôn ngữ, mật khẩu (chỉ lưu dạng đã băm).',
        '<strong>Dữ liệu của nhà hàng:</strong> hồ sơ nhà hàng, sơ đồ bàn, thực đơn, kho, nhập hàng, đơn hàng, thanh toán ghi nhận, ca quỹ, chi phí, nhân viên.',
        '<strong>Dữ liệu khách do nhà hàng nhập:</strong> tên, số điện thoại, ngày sinh, ghi chú dị ứng và sở thích. Ghi chú dị ứng có thể là thông tin sức khỏe: chỉ quản trị viên đăng nhập xem được và không bao giờ được ghi vào nhật ký máy chủ. Khách không có tài khoản và không dùng ứng dụng.',
        '<strong>Dữ liệu kỹ thuật:</strong> địa chỉ IP lưu tạm để chống truy cập dồn dập (tự xóa sau khoảng 2 ngày); nhật ký máy chủ chỉ ghi loại yêu cầu, đường dẫn, mã kết quả và thời gian xử lý, không ghi nội dung, mật khẩu hay mã truy cập.',
      ]]],
      ['Dữ liệu chúng tôi không thu thập', ['Không vị trí, danh bạ, micro, camera, thư viện ảnh; không quảng cáo; không bán dữ liệu. Ứng dụng không xử lý thanh toán trực tuyến: tiền mặt và chuyển khoản chỉ được ghi nhận thủ công. Nhắc việc là thông báo tạo ngay trên máy, không đẩy từ máy chủ.']],
      ['Mục đích sử dụng', [[
        'Đăng nhập, giữ phiên làm việc và quản lý các quản trị viên của nhà hàng.',
        'Vận hành nhà hàng: bàn, gọi món, bếp, kho, đặt bàn, ca quỹ và báo cáo.',
        'Email cần thiết: mã đặt lại mật khẩu và thông báo đổi mật khẩu. Không gửi email quảng cáo.',
      ]]],
      ['Ai xem được dữ liệu', [[
        'Chỉ các quản trị viên của nhà hàng.',
        'Nhà cung cấp hạ tầng xử lý thay chúng tôi: MongoDB Atlas (cơ sở dữ liệu), Vercel (máy chủ API), dịch vụ gửi email. Họ không được dùng dữ liệu cho mục đích riêng.',
        'Cơ quan nhà nước khi pháp luật yêu cầu.',
      ]]],
      ['Bảo mật', ['Mọi kết nối dùng HTTPS. Mật khẩu chỉ lưu dạng băm. Mã truy cập hết hạn sau 2 giờ và thu hồi được; máy chủ kiểm tra phiên và tài khoản ở mọi yêu cầu.']],
      ['Thời gian lưu và xóa dữ liệu', [[
        'Dữ liệu được giữ trong thời gian nhà hàng còn sử dụng dịch vụ. Mã đặt lại mật khẩu hết hạn sau 30 phút.',
        `Bạn xóa tài khoản ngay trong ứng dụng (Tài khoản &gt; Xóa tài khoản) hoặc tại <a href="${base()}/account/delete">trang xóa tài khoản</a>; việc xóa là xóa thật. Hồ sơ khách được xóa theo yêu cầu. Bản sao lưu được xóa theo chu kỳ lưu trữ của nhà cung cấp hạ tầng.`,
      ]]],
      ['Quyền của bạn', [`Bạn có quyền xem, sửa, xuất (CSV) và xóa dữ liệu theo quy định pháp luật về bảo vệ dữ liệu cá nhân. Khách có thể yêu cầu nhà hàng xóa thông tin của mình, hoặc gửi yêu cầu về ${mail}.`]],
    ],
  },
  en: {
    title: 'DineDesk privacy policy',
    updated: `Last updated: ${UPDATED}`,
    other: '<a href="?lang=vi">Tiếng Việt</a>',
    sections: [
      ['Who we are', [`DineDesk is a restaurant management app for owners and managers, developed by <strong>${esc(OWNER)}</strong>, who is responsible for the data. Contact: ${mail}.`]],
      ['Data we store', [[
        '<strong>Admin account:</strong> email, name, phone, language, password (stored only as a hash).',
        '<strong>Restaurant data:</strong> profile, floor plan, menu, stock, purchases, orders, recorded payments, cash shifts, expenses, staff.',
        '<strong>Guest data typed in by the restaurant:</strong> name, phone, birthday, allergy and preference notes. Allergy notes may be health information: only signed-in admins can see them and they are never written to server logs. Guests have no account and do not use the app.',
        '<strong>Technical data:</strong> IP addresses kept briefly to stop request floods (deleted after about 2 days); server logs record only method, path, status and timing, never bodies, passwords or tokens.',
      ]]],
      ['Data we do not collect', ['No location, contacts, microphone, camera or photo library; no ads; no selling of data. The app does not process online payments: cash and bank transfers are recorded manually. Reminders are created on the device, not pushed by the server.']],
      ['How we use it', [[
        'Sign-in, session handling and managing the restaurant admins.',
        'Running the restaurant: tables, orders, kitchen, stock, bookings, cash shifts and reports.',
        'Necessary email only: password reset code and password-changed notice. No marketing email.',
      ]]],
      ['Who can see the data', [[
        'Only the restaurant admins.',
        'Infrastructure providers process data on our behalf: MongoDB Atlas (database), Vercel (API servers), an email service. They may not use the data for their own purposes.',
        'Public authorities when the law requires it.',
      ]]],
      ['Security', ['All connections use HTTPS. Passwords are stored only as hashes. Access tokens expire after 2 hours and can be revoked; the server checks the session and the account on every request.']],
      ['Retention and deletion', [[
        'Data is kept while the restaurant uses the service. Password reset codes expire after 30 minutes.',
        `You can delete your account in the app (Account &gt; Delete account) or on the <a href="${base()}/account/delete">account deletion page</a>; deletion is real, not a flag. Guest profiles are deleted on request. Backups are removed on the infrastructure provider's retention cycle.`,
      ]]],
      ['Your rights', [`You may view, correct, export (CSV) and delete data as provided by personal-data protection law. Guests can ask the restaurant to delete their details, or write to ${mail}.`]],
    ],
  },
};

function render(lang) {
  const t = content[lang];
  const body = t.sections.map(([h, parts]) => `<h2>${h}</h2>${parts.map((p) => (Array.isArray(p) ? `<ul>${p.map((li) => `<li>${li}</li>`).join('')}</ul>` : `<p>${p}</p>`)).join('')}`).join('\n');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title}</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#5d5d58;--card:#fff;--line:#d9d9d4;--accent:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecece8;--muted:#a5a59f;--card:#20201e;--line:#3a3a37;--accent:#fdba74}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 48px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:24px;margin:0 0 4px;color:var(--accent)}h2{font-size:18px;margin:28px 0 8px}
.meta{color:var(--muted);font-size:14px;margin:0 0 8px}p,li{margin:0 0 10px}ul{padding-left:20px;margin:0}
a{color:var(--accent)}nav{margin-top:16px;font-size:14px}
</style></head><body><main><div class="card">
<h1>${t.title}</h1><p class="meta">${t.updated}</p>
${body}
</div><nav>${t.other}</nav></main></body></html>`;
}

const pickLang = (req) => (req.query.lang === 'en' || req.query.lang === 'vi' ? req.query.lang : langOf(req.get('accept-language')));

const router = express.Router();
router.get('/privacy', (req, res) => res.type('html').send(render(pickLang(req))));

module.exports = router;
