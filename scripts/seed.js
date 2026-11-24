/**
 * Sample restaurant with four weeks of history, for the Google Play reviewer and for trying the app:
 * one admin, floor plan, menu with recipes, suppliers, purchases and lots, ~900 closed orders with payments,
 * cash shifts, expenses, bookings, customers, and a few live orders on the floor / in the kitchen right now.
 *
 *   npm run seed                (only into an empty database)
 *   npm run seed -- --reset     (wipes every collection first)
 * Login: SEED_EMAIL / SEED_PASSWORD (defaults below). Use a TEST or review database only.
 */
const mongoose = require('mongoose');
const config = require('../src/config');
const M = require('../src/models');
const password = require('../src/lib/password');
const T = require('../src/lib/time');
const { uuid, noAccent } = require('../src/lib/util');
const { totals } = require('../src/services/orders');

const EMAIL = process.env.SEED_EMAIL || 'quanly@bepphohue.example';
const PASSWORD = process.env.SEED_PASSWORD || 'Quanly2026';
const ADMIN = 'Nguyễn Thị Lan';
const TZ = config.timezone;
const RULES = { servicePct: 5, roundTo: 1000, seatMinutes: 90, holdMinutes: 15, longSitMinutes: 120, reminderLeadMin: 30 };

// ---------- deterministic randomness ----------
let seed = 20261124;
const rnd = () => {
  seed += 0x6d2b79f5;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[int(0, arr.length - 1)];
const chance = (p) => rnd() < p;
const weighted = (rows) => {
  let x = rnd() * rows.reduce((s, r) => s + r.w, 0);
  for (const r of rows) { x -= r.w; if (x <= 0) return r; }
  return rows[rows.length - 1];
};
const stamp = (d = new Date()) => ({ createdAt: d, updatedAt: d });
const min = (d, m) => new Date(d.getTime() + m * 60000);
const at = (date, hhmm) => T.localToUtc(date, hhmm, TZ);
const hm = (m) => T.hhmm(m);

// ---------- master data ----------
const SUPPLIERS = [
  { name: 'Chợ đầu mối Bình Điền', phone: '0283 877 1122', items: 'Rau, củ, trái cây' },
  { name: 'Thịt sạch Hai Lúa', phone: '0903 412 889', items: 'Bò, heo, gà' },
  { name: 'Hải sản Cần Giờ - Anh Tâm', phone: '0918 665 231', items: 'Tôm, cá, mực' },
  { name: 'Đại lý tạp hóa Phát Lộc', phone: '0937 120 456', items: 'Gạo, dầu ăn, gia vị, đường, sữa' },
  { name: 'Nhà phân phối nước giải khát Tân Việt', phone: '0286 270 9988', items: 'Bia, nước ngọt, nước suối, cà phê, trà' },
];

// [name, unit, minQty, supplierIndex, unitCost, shelfDays]
const INGREDIENTS = [
  ['Thịt bò', 'g', 6000, 1, 285, 5], ['Thịt ba chỉ heo', 'g', 6000, 1, 135, 5], ['Gà ta', 'g', 8000, 1, 105, 4], ['Sườn non', 'g', 4000, 1, 160, 5],
  ['Tôm sú', 'g', 4000, 2, 330, 3], ['Cá lóc', 'g', 4000, 2, 125, 3], ['Mực ống', 'g', 3000, 2, 195, 3],
  ['Gạo', 'g', 30000, 3, 22, 180], ['Bún tươi', 'g', 12000, 0, 17, 2], ['Rau muống', 'g', 5000, 0, 19, 3], ['Rau sống các loại', 'g', 4000, 0, 26, 3],
  ['Nấm các loại', 'g', 2500, 0, 72, 4], ['Xoài', 'g', 3000, 0, 42, 5], ['Chanh', 'quả', 100, 0, 2500, 10], ['Dừa tươi', 'quả', 60, 0, 12500, 10],
  ['Trứng gà', 'cái', 150, 3, 3200, 14], ['Đậu hũ', 'cái', 80, 0, 3000, 3], ['Dầu ăn', 'ml', 8000, 3, 38, 180], ['Nước mắm', 'ml', 4000, 3, 46, 365],
  ['Sả ớt tỏi', 'g', 1500, 0, 45, 6], ['Đường', 'g', 6000, 3, 21, 365], ['Sữa đặc', 'ml', 4000, 3, 41, 180], ['Đậu xanh', 'g', 2000, 3, 48, 180],
  ['Cà phê', 'g', 3000, 4, 285, 120], ['Trà', 'g', 800, 4, 150, 180], ['Bia lon', 'lon', 150, 4, 13200, 180], ['Nước ngọt lon', 'lon', 150, 4, 8600, 180], ['Nước suối', 'chai', 200, 4, 3600, 365],
];
const ING = Object.fromEntries(INGREDIENTS.map((g, i) => [g[0], i]));

const SIZE = (extra) => ({ name: 'Size', required: true, multi: false, choices: [{ name: 'Vừa', extra: 0 }, { name: 'Lớn', extra }] });
const CAY = { name: 'Độ cay', required: false, multi: false, choices: [{ name: 'Không cay', extra: 0 }, { name: 'Cay vừa', extra: 0 }, { name: 'Cay nhiều', extra: 0 }] };
const DA = { name: 'Đá', required: false, multi: false, choices: [{ name: 'Ít đá', extra: 0 }, { name: 'Nhiều đá', extra: 0 }, { name: 'Không đá', extra: 0 }] };
const NGOT = { name: 'Độ ngọt', required: false, multi: false, choices: [{ name: 'Ít ngọt', extra: 0 }, { name: 'Nhiều ngọt', extra: 0 }] };

// group, code, name, price, station, prepMin, weight (popularity), recipe, options, tags
const MENU = [
  ['Khai vị', 'K01', 'Gỏi cuốn tôm thịt', 55000, 'kitchen', 8, 7, [['Tôm sú', 60], ['Thịt ba chỉ heo', 50], ['Bún tươi', 60], ['Rau sống các loại', 70]], [], []],
  ['Khai vị', 'K02', 'Chả giò hải sản', 65000, 'kitchen', 12, 7, [['Tôm sú', 50], ['Mực ống', 40], ['Dầu ăn', 40], ['Rau sống các loại', 60]], [], []],
  ['Khai vị', 'K03', 'Nem nướng Nha Trang', 79000, 'grill', 15, 5, [['Thịt ba chỉ heo', 120], ['Rau sống các loại', 80], ['Bún tươi', 50]], [], []],
  ['Khai vị', 'K04', 'Salad rau củ trộn', 49000, 'kitchen', 6, 3, [['Rau sống các loại', 150], ['Chanh', 0.5], ['Đường', 5]], [], ['chay']],
  ['Món chính', 'M01', 'Bò lúc lắc', 139000, 'kitchen', 14, 12, [['Thịt bò', 200], ['Dầu ăn', 30], ['Rau sống các loại', 60], ['Sả ớt tỏi', 10]], [SIZE(25000)], []],
  ['Món chính', 'M02', 'Gà nướng sả mật ong', 189000, 'grill', 25, 8, [['Gà ta', 500], ['Sả ớt tỏi', 30], ['Đường', 15]], [SIZE(60000), CAY], []],
  ['Món chính', 'M03', 'Cá lóc nướng trui', 229000, 'grill', 30, 5, [['Cá lóc', 600], ['Rau sống các loại', 150], ['Nước mắm', 30], ['Sả ớt tỏi', 20]], [], []],
  ['Món chính', 'M04', 'Sườn xào chua ngọt', 149000, 'kitchen', 18, 7, [['Sườn non', 300], ['Đường', 25], ['Dầu ăn', 30]], [], []],
  ['Món chính', 'M05', 'Tôm sú rang muối ớt', 189000, 'kitchen', 15, 8, [['Tôm sú', 250], ['Sả ớt tỏi', 25], ['Dầu ăn', 25]], [SIZE(70000), CAY], []],
  ['Món chính', 'M06', 'Mực xào sa tế', 159000, 'kitchen', 12, 5, [['Mực ống', 250], ['Sả ớt tỏi', 25], ['Dầu ăn', 25]], [CAY], []],
  ['Món chính', 'M07', 'Đậu hũ sốt nấm', 79000, 'kitchen', 10, 4, [['Đậu hũ', 2], ['Nấm các loại', 100], ['Dầu ăn', 15]], [], ['chay']],
  ['Món chính', 'M08', 'Rau muống xào tỏi', 55000, 'kitchen', 7, 8, [['Rau muống', 250], ['Sả ớt tỏi', 15], ['Dầu ăn', 20]], [], ['chay']],
  ['Cơm & Bún', 'C01', 'Cơm chiên hải sản', 89000, 'kitchen', 10, 11, [['Gạo', 200], ['Tôm sú', 60], ['Mực ống', 50], ['Trứng gà', 1], ['Dầu ăn', 20]], [SIZE(20000)], []],
  ['Cơm & Bún', 'C02', 'Cơm tấm sườn bì chả', 69000, 'grill', 12, 10, [['Gạo', 200], ['Sườn non', 150], ['Trứng gà', 0.5], ['Nước mắm', 15]], [], []],
  ['Cơm & Bún', 'C03', 'Bún bò Huế', 69000, 'kitchen', 8, 12, [['Bún tươi', 250], ['Thịt bò', 90], ['Thịt ba chỉ heo', 50], ['Sả ớt tỏi', 15], ['Rau sống các loại', 60]], [SIZE(15000), CAY], []],
  ['Cơm & Bún', 'C04', 'Bún thịt nướng chả giò', 65000, 'grill', 10, 8, [['Bún tươi', 220], ['Thịt ba chỉ heo', 120], ['Rau sống các loại', 70], ['Nước mắm', 20]], [], []],
  ['Lẩu & Nướng', 'L01', 'Lẩu thái hải sản (2-3 người)', 359000, 'kitchen', 20, 5, [['Tôm sú', 200], ['Mực ống', 150], ['Cá lóc', 200], ['Nấm các loại', 150], ['Rau muống', 200], ['Chanh', 2], ['Sả ớt tỏi', 40]], [CAY], []],
  ['Lẩu & Nướng', 'L02', 'Lẩu bò nhúng dấm', 329000, 'kitchen', 18, 4, [['Thịt bò', 400], ['Rau sống các loại', 300], ['Bún tươi', 200], ['Sả ớt tỏi', 30]], [], []],
  ['Lẩu & Nướng', 'L03', 'Combo nướng (4 người)', 689000, 'grill', 30, 3, [['Thịt bò', 300], ['Thịt ba chỉ heo', 300], ['Gà ta', 300], ['Tôm sú', 200], ['Rau sống các loại', 300]], [], []],
  ['Tráng miệng', 'T01', 'Bánh flan caramel', 29000, 'kitchen', 3, 5, [['Trứng gà', 1], ['Sữa đặc', 40], ['Đường', 20]], [], []],
  ['Tráng miệng', 'T02', 'Chè đậu xanh nước cốt dừa', 32000, 'kitchen', 4, 4, [['Đậu xanh', 60], ['Đường', 30], ['Dừa tươi', 0.1]], [], []],
  ['Tráng miệng', 'T03', 'Xoài lắc', 39000, 'kitchen', 5, 3, [['Xoài', 250], ['Đường', 10]], [], []],
  ['Đồ uống', 'D01', 'Cà phê sữa đá', 35000, 'bar', 4, 14, [['Cà phê', 20], ['Sữa đặc', 30]], [DA, NGOT], []],
  ['Đồ uống', 'D02', 'Trà đá', 5000, 'bar', 1, 9, [['Trà', 3]], [], []],
  ['Đồ uống', 'D03', 'Nước chanh tươi', 29000, 'bar', 3, 8, [['Chanh', 1], ['Đường', 25]], [DA, NGOT], []],
  ['Đồ uống', 'D04', 'Nước dừa tươi', 39000, 'bar', 2, 7, [['Dừa tươi', 1]], [], []],
  ['Đồ uống', 'D05', 'Bia Tiger lon', 25000, 'bar', 1, 13, [['Bia lon', 1]], [], []],
  ['Đồ uống', 'D06', 'Nước ngọt lon', 20000, 'bar', 1, 8, [['Nước ngọt lon', 1]], [], []],
  ['Đồ uống', 'D07', 'Nước suối', 12000, 'bar', 1, 6, [['Nước suối', 1]], [], []],
];

const AREAS = [
  ['Tầng 1', [['A1', 4], ['A2', 4], ['A3', 2], ['A4', 2], ['A5', 6], ['A6', 6], ['A7', 4], ['A8', 8]]],
  ['Tầng 2', [['B1', 4], ['B2', 4], ['B3', 6], ['B4', 6], ['B5', 10], ['B6', 12]]],
  ['Sân vườn', [['C1', 4], ['C2', 4], ['C3', 6], ['C4', 8]]],
];

const FIRST = ['Hương', 'Lan', 'Mai', 'Thảo', 'Linh', 'Hà', 'Trang', 'Ngọc', 'Phương', 'Yến', 'Hùng', 'Dũng', 'Tuấn', 'Minh', 'Khoa', 'Việt', 'Nam', 'Long', 'Phúc', 'Bình'];
const LAST = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Vũ', 'Đặng', 'Bùi', 'Đỗ', 'Võ'];
const STREETS = ['45 Lê Lợi, Q.1', '12 Nguyễn Huệ, Q.1', '230 Điện Biên Phủ, Q.3', '88 Cách Mạng Tháng 8, Q.10', '17 Phan Xích Long, Phú Nhuận', '5 Hoàng Văn Thụ, Tân Bình', '66 Nguyễn Văn Linh, Q.7', '301 Võ Văn Tần, Q.3'];

const usedPhones = new Set();
const phone = () => {
  for (;;) {
    const p = `09${int(0, 9)}${String(int(0, 9999999)).padStart(7, '0')}`;
    if (!usedPhones.has(p)) { usedPhones.add(p); return p; }
  }
};

async function main() {
  await mongoose.connect(config.mongoUri);
  if (process.argv.includes('--reset')) for (const c of await mongoose.connection.db.collections()) await c.deleteMany({});
  else if (await M.Account.countDocuments({})) {
    console.log('database is not empty: use -- --reset to rebuild it');
    await mongoose.disconnect();
    return;
  }
  for (const name of mongoose.modelNames()) await mongoose.model(name).syncIndexes();

  const now = new Date();
  const today = T.today(TZ);
  const startDay = T.addDays(today, -27);
  const nowMin = T.minutesOf(T.toLocal(now, TZ).time);
  const month = today.slice(0, 7);

  // ----- account, shop, rules
  await M.Account.create({ _id: uuid(), email: EMAIL, passwordHash: await password.hash(PASSWORD), name: ADMIN, phone: '0903 555 018', language: 'vi', mustChangePassword: false, passwordChangedAt: now, ...stamp(T.localToUtc(startDay, '08:00', TZ)) });
  await M.Setting.create([
    { _id: 'shop', value: { name: 'Bếp Phố Huế', description: 'Món Huế và món Việt gia đình, có sân vườn và phòng tầng 2 cho nhóm đông.', phone: '0283 822 4466', address: '28 Nguyễn Trãi, Phường Bến Thành, Quận 1, TP.HCM', openText: '10:00 – 22:00 hằng ngày', representative: ADMIN, businessRegText: 'Hộ kinh doanh Bếp Phố Huế – MST 0312345678', timezone: TZ } },
    { _id: 'rules', value: RULES },
  ]);

  // ----- floor
  const areaDocs = [];
  const tables = [];
  AREAS.forEach(([name, list], i) => {
    const a = { _id: uuid(), name, sort: i + 1, ...stamp(now) };
    areaDocs.push(a);
    for (const [label, seats] of list) tables.push({ _id: uuid(), areaId: a._id, label, seats, canMerge: true, status: 'free', currentOrderId: null, ...stamp(now) });
  });
  await M.Area.create(areaDocs);
  const tableBy = Object.fromEntries(tables.map((t) => [t.label, t]));

  // ----- suppliers, ingredients, menu
  const suppliers = SUPPLIERS.map((s) => ({ _id: uuid(), ...s, note: '', ...stamp(now) }));
  await M.Supplier.create(suppliers);
  const ings = INGREDIENTS.map(([name, unit, minQty, sup]) => ({ _id: uuid(), name, unit, group: '', minQty, supplierId: suppliers[sup]._id, search: noAccent(name), ...stamp(now) }));
  await M.Ingredient.create(ings);

  const groupNames = [...new Set(MENU.map((m) => m[0]))];
  const groups = groupNames.map((name, i) => ({ _id: uuid(), name, sort: i + 1, ...stamp(now) }));
  await M.MenuGroup.create(groups);
  const items = MENU.map(([g, code, name, price, station, prepMin, w, recipe, options, tags]) => ({
    _id: uuid(), groupId: groups[groupNames.indexOf(g)]._id, code, name, desc: '', unit: '', price, prepMin, station, status: 'on', tags,
    options, recipe: recipe.map(([n, qty]) => ({ ingredientId: ings[ING[n]]._id, qty })), search: noAccent(`${name} ${code}`), w, ...stamp(now),
  }));
  items.find((i) => i.code === 'M03').status = 'out'; // sold out today
  await M.MenuItem.create(items.map(({ w, ...rest }) => rest));

  // ----- staff, customers, promotions
  const STAFF = [['Lê Văn Hải', 'waiter', '2024-03-04'], ['Phạm Thu Hà', 'waiter', '2024-06-17'], ['Đặng Quốc Bảo', 'waiter', '2025-01-10'], ['Võ Mỹ Duyên', 'waiter', '2025-08-01'], ['Nguyễn Văn Sơn', 'kitchen', '2023-11-20'],
    ['Trần Thị Cúc', 'kitchen', '2024-02-12'], ['Hoàng Anh Tú', 'bar', '2024-09-09'], ['Bùi Thanh Tâm', 'cashier', '2023-11-20'], ['Lý Văn Tài', 'delivery', '2025-02-03'], ['Mai Quốc Việt', 'delivery', '2025-10-15']];
  const staff = STAFF.map(([name, role, joined]) => ({ _id: uuid(), name, phone: phone(), role, joined, active: true, note: '', ...stamp(now) }));
  await M.Staff.create(staff);
  const deliverers = staff.filter((s) => s.role === 'delivery');

  const customers = [];
  const plusDays = (n) => T.addDays(today, n).slice(5);
  for (let i = 0; i < 28; i += 1) {
    const name = `${pick(LAST)} ${pick(['Thị', 'Văn', 'Minh', 'Ngọc', 'Quốc'])} ${pick(FIRST)}`;
    const p = phone();
    customers.push({
      _id: uuid(), name, phone: p, phoneKey: p, allergy: i % 7 === 0 ? pick(['Dị ứng hải sản vỏ cứng', 'Không ăn được đậu phộng', 'Dị ứng sữa']) : '',
      pref: i % 5 === 0 ? pick(['Hay ngồi sân vườn', 'Thích bàn gần cửa sổ', 'Ăn ít cay']) : '', attention: i === 3 ? 'Khách VIP, luôn tặng khai vị' : '',
      birthday: i === 1 ? `1990-${plusDays(3)}` : i === 4 ? `1985-${plusDays(6)}` : chance(0.5) ? `${int(1975, 2002)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}` : null,
      points: 0, search: noAccent(`${name} ${p}`), ...stamp(T.localToUtc(T.addDays(startDay, -int(5, 200)), '10:00', TZ)),
    });
  }

  const promos = [
    { _id: uuid(), code: 'CHAOHE15', kind: 'percent', value: 15, minAmount: 300000, limit: 300, used: 0, end: T.addDays(today, 45) },
    { _id: uuid(), code: 'GIAM50K', kind: 'amount', value: 50000, minAmount: 400000, limit: 0, used: 0, end: null },
    { _id: uuid(), code: 'KHACHMOI10', kind: 'percent', value: 10, minAmount: 150000, limit: 100, used: 0, end: T.addDays(today, 20) },
  ].map((p) => ({ ...p, ...stamp(now) }));

  // ----- simulate the last 28 days of closed orders
  const orders = [];
  const saleMoves = [];
  const consumed = {};
  const shiftsCash = {}; // date -> { cash, entries }
  const actions = [];
  const dayCounts = {};
  const reasons = ['Khách đổi món', 'Lên nhầm món', 'Hết nguyên liệu'];

  const makeLine = (item, qty, opts, base, status = 'served') => {
    const names = [];
    let extra = 0;
    for (const g of item.options) {
      if (g.required) {
        const c = chance(0.7) ? g.choices[0] : g.choices[1];
        names.push(c.name);
        extra += c.extra;
      } else if (chance(g.name === 'Đá' ? 0.5 : 0.3)) names.push(pick(g.choices).name);
    }
    const fired = min(base, int(2, 6));
    return {
      id: uuid(), itemId: item._id, name: item.name, qty, unitPrice: item.price + extra, options: names, note: chance(0.06) ? pick(['ít mỡ', 'không hành', 'mang ra trước', 'ít cay']) : '', station: item.station,
      status, comp: false, cancelReason: '', firedAt: status === 'draft' ? null : fired, doneAt: ['done', 'served'].includes(status) ? min(fired, item.prepMin + int(-2, 4)) : null, ...opts,
    };
  };
  const pickItems = (n) => {
    const chosen = [];
    while (chosen.length < n) {
      const it = weighted(items.map((i) => ({ w: i.w, i })));
      if (!chosen.includes(it.i)) chosen.push(it.i);
    }
    return chosen;
  };

  for (let d = startDay, di = 0; d <= today; d = T.addDays(d, 1), di += 1) {
    const wd = T.weekday(d);
    const base = [42, 24, 22, 25, 27, 36, 47][wd] * (0.88 + (0.14 * di) / 27);
    const count = Math.round(base * (0.9 + rnd() * 0.2));
    const list = [];
    for (let k = 0; k < count; k += 1) {
      const dinner = chance(0.62);
      const closeMin = dinner ? int(18 * 60 + 20, 21 * 60 + 50) : int(11 * 60 + 20, 13 * 60 + 40);
      if (d === today && closeMin > nowMin - 5) continue;
      const kind = weighted([{ w: 72, k: 'dine' }, { w: 18, k: 'take' }, { w: 10, k: 'delivery' }]).k;
      const closedAt = at(d, hm(closeMin));
      const openedAt = min(closedAt, -(kind === 'dine' ? int(35, 85) : int(12, 35)));
      const party = kind === 'dine' ? weighted([{ w: 3, n: 1 }, { w: 9, n: 2 }, { w: 5, n: 3 }, { w: 6, n: 4 }, { w: 3, n: 6 }, { w: 1, n: 8 }]).n : 1;
      list.push({ kind, closedAt, openedAt, party });
    }
    list.sort((a, b) => a.openedAt - b.openedAt);
    dayCounts[d] = list.length;
    list.forEach((o, idx) => {
      const number = idx + 1;
      const kind = o.kind;
      const lines = pickItems(kind === 'dine' ? Math.min(int(2, 4) + Math.floor(o.party / 3), 7) : int(1, 4)).map((it) => makeLine(it, kind === 'dine' ? Math.max(1, Math.round(o.party * (it.station === 'bar' ? 1 : 0.5) * (0.6 + rnd() * 0.8))) : int(1, 2), {}, o.openedAt));
      if (chance(0.04)) { const l = pick(lines); if (lines.length > 1) { l.status = 'cancelled'; l.cancelReason = pick(reasons); l.doneAt = null; } }
      const cust = chance(0.35) ? pick(customers) : null;
      const table = kind === 'dine' ? pick(tables.filter((t) => t.seats >= Math.min(o.party, 6))) : null;
      const doc = {
        _id: uuid(), code: `${{ dine: 'B', take: 'M', delivery: 'G' }[kind]}${String(number).padStart(3, '0')}`, number, day: d, kind, status: 'closed', version: 5 + lines.length,
        tableId: table?._id || null, tableLabel: table?.label || '', customerId: cust?._id || null, customerName: cust?.name || (kind === 'dine' ? '' : `${pick(LAST)} ${pick(FIRST)}`), phone: cust?.phone || (kind === 'dine' ? '' : phone()),
        party: o.party, note: '', allergy: cust?.allergy || '', address: kind === 'delivery' ? pick(STREETS) : '', deliveryFee: kind === 'delivery' ? pick([15000, 20000, 25000, 30000]) : 0,
        deliveryStatus: kind === 'delivery' ? 'delivered' : null, delivererId: kind === 'delivery' ? pick(deliverers)._id : null, dueAt: null,
        serviceOn: kind === 'dine' && !chance(0.05), surcharge: 0, openedAt: o.openedAt, closedAt: o.closedAt, openedBy: ADMIN, cancelReason: '',
        lines, discounts: [], payments: [], ...stamp(o.closedAt),
      };
      const sub = lines.reduce((s, l) => s + (l.status === 'cancelled' ? 0 : l.qty * l.unitPrice), 0);
      const promo = weighted([{ w: 8, p: null }, { w: 0.5, p: promos[0] }, { w: 0.3, p: promos[1] }, { w: 0.4, p: promos[2] }]).p;
      if (promo && sub >= promo.minAmount && (promo.limit === 0 || promo.used < promo.limit)) {
        promo.used += 1;
        doc.discounts.push({ id: uuid(), label: `Mã ${promo.code}`, amount: promo.kind === 'percent' ? Math.round((sub * promo.value) / 100) : promo.value, reason: '', promoId: promo._id });
      } else if (chance(0.03)) doc.discounts.push({ id: uuid(), label: 'Khách quen giảm 10%', amount: Math.round(sub * 0.1), reason: '' });
      const t = totals(doc, RULES);
      doc.rulesSnap = { servicePct: RULES.servicePct, roundTo: RULES.roundTo };
      doc.roundAdjust = t.roundAdjust;
      doc.finalTotal = t.total;
      doc.pointsAwarded = cust ? Math.floor(t.total / 10000) : 0;
      if (cust) cust.points += doc.pointsAwarded;
      // payments
      const payAt = min(o.closedAt, -1);
      const free = chance(0.012);
      if (free) doc.payments.push({ id: uuid(), kind: 'pay', method: 'free', amount: t.total, note: 'Tiếp khách của chủ quán', by: ADMIN, at: payAt });
      else if (chance(0.12)) {
        const a = Math.round((t.total * pick([0.4, 0.5, 0.6])) / 1000) * 1000;
        doc.payments.push({ id: uuid(), kind: 'pay', method: 'cash', amount: a, note: '', by: ADMIN, at: min(payAt, -2) }, { id: uuid(), kind: 'pay', method: 'transfer', amount: t.total - a, note: '', by: ADMIN, at: payAt });
      } else doc.payments.push({ id: uuid(), kind: 'pay', method: chance(0.46) ? 'cash' : 'transfer', amount: t.total, note: '', by: ADMIN, at: payAt });
      if (kind === 'dine' && chance(0.1)) doc.payments.push({ id: uuid(), kind: 'tip', method: 'cash', amount: pick([10000, 20000, 50000]), note: '', by: ADMIN, at: payAt });
      if (d !== today && !free && chance(0.015)) {
        const amount = pick([29000, 55000, 65000, 89000]);
        doc.payments.push({ id: uuid(), kind: 'refund', method: 'cash', amount, note: pick(['Món lên chậm', 'Món không đúng yêu cầu', 'Khách phàn nàn món nguội']), by: ADMIN, at: min(o.closedAt, 18) });
        actions.push({ adminName: ADMIN, action: 'refund', targetType: 'order', targetId: doc._id, note: `${amount}: món lên chậm`, at: min(o.closedAt, 18) });
      }
      doc.search = noAccent(`${doc.code} ${doc.customerName} ${doc.phone}`);
      for (const l of lines) {
        if (l.status === 'cancelled') continue;
        const it = items.find((x) => x._id === l.itemId);
        for (const r of it.recipe) {
          const q = Math.round(r.qty * l.qty * 1000) / 1000;
          consumed[r.ingredientId] = (consumed[r.ingredientId] || 0) + q;
          saleMoves.push({ _id: uuid(), ingredientId: r.ingredientId, qty: -q, kind: 'sale', note: `Đơn ${doc.code}`, orderId: doc._id, lots: [], reversed: false, at: o.closedAt });
        }
      }
      for (const p of doc.payments) {
        if (p.method !== 'cash') continue;
        const s = (shiftsCash[d] ||= { cash: 0 });
        s.cash += p.kind === 'refund' ? -p.amount : p.amount;
      }
      orders.push(doc);
    });
  }

  // ----- live orders: kitchen, floor and billing right now
  const todayNumber = () => (dayCounts[today] = (dayCounts[today] || 0) + 1);
  const item = (code) => items.find((i) => i.code === code);
  const live = [];
  const liveOrder = (kind, table, party, openedMinAgo, lineSpecs, extra = {}) => {
    const openedAt = min(now, -openedMinAgo);
    const number = todayNumber();
    const lines = lineSpecs.map(([code, qty, status, firedAgo, opt]) => {
      const it = item(code);
      const l = makeLine(it, qty, {}, openedAt, status);
      if (opt) { l.options = opt; l.unitPrice = it.price + (opt.includes('Lớn') ? it.options[0].choices[1].extra : 0); }
      if (status !== 'draft') { l.firedAt = min(now, -firedAgo); l.doneAt = ['done', 'served'].includes(status) ? min(l.firedAt, it.prepMin) : null; }
      return l;
    });
    const doc = {
      _id: uuid(), code: `${{ dine: 'B', take: 'M', delivery: 'G' }[kind]}${String(number).padStart(3, '0')}`, number, day: today, kind, status: 'open', version: 3 + lines.length,
      tableId: table?._id || null, tableLabel: table?.label || '', customerId: null, customerName: '', phone: '', party, note: '', allergy: '', address: '', deliveryFee: 0, deliveryStatus: null, delivererId: null, dueAt: null,
      serviceOn: kind === 'dine', surcharge: 0, openedAt, closedAt: null, openedBy: ADMIN, cancelReason: '', lines, discounts: [], payments: [], ...stamp(openedAt), ...extra,
    };
    doc.search = noAccent(`${doc.code} ${doc.customerName} ${doc.phone}`);
    live.push(doc);
    if (table) { table.currentOrderId = doc._id; table.status = 'busy'; }
    return doc;
  };
  liveOrder('dine', tableBy.A2, 2, 25, [['K01', 1, 'served', 22], ['M01', 1, 'cooking', 12, ['Vừa']], ['C01', 1, 'sent', 6, ['Vừa']], ['D01', 2, 'done', 14]]);
  liveOrder('dine', tableBy.A5, 4, 55, [['L01', 1, 'served', 48], ['M08', 1, 'served', 40], ['D05', 4, 'served', 50], ['T01', 2, 'draft', 0]], { allergy: 'Dị ứng hải sản vỏ cứng', note: 'Sinh nhật, thêm nến' });
  liveOrder('dine', tableBy.C1, 4, 130, [['M02', 1, 'served', 118, ['Lớn']], ['M05', 1, 'served', 118, ['Vừa']], ['D05', 6, 'served', 120]]);
  const billing = liveOrder('dine', tableBy.B3, 6, 75, [['L03', 1, 'served', 65], ['D05', 6, 'served', 64], ['D06', 2, 'served', 64]]);
  billing.payments.push({ id: uuid(), kind: 'pay', method: 'transfer', amount: totals(billing, RULES).total, note: '', by: ADMIN, at: min(now, -2) });
  tableBy.B3.status = 'billing';
  liveOrder('take', null, 1, 8, [['C03', 2, 'cooking', 5, ['Vừa']], ['D01', 2, 'sent', 5]], { customerName: 'Chị Thảo', phone: '0965 221 478' });
  liveOrder('delivery', null, 1, 24, [['C02', 2, 'cooking', 15], ['M08', 1, 'done', 15], ['D03', 2, 'done', 15]], { customerName: 'Anh Khánh', phone: '0977 303 612', address: '45 Lê Lợi, Q.1', deliveryFee: 20000, deliveryStatus: 'cooking', delivererId: deliverers[0]._id });
  tableBy.A7.status = 'cleaning';
  // numbering of today: live orders took the numbers after the closed ones
  const counters = Object.entries(dayCounts).map(([day, seq]) => ({ _id: `order|${day}`, seq }));

  // ----- purchases / lots / receive moves (sized from what was sold, so stock is consistent)
  const purchases = [];
  const lots = [];
  const moves = [...saleMoves];
  const buy = [[-27, 0.46], [-13, 0.42], [-2, 0.12]];
  const endStock = (g, idx) => (['Tôm sú', 'Mực ống', 'Rau muống'].includes(g.name) ? Math.round(g.minQty * 0.45) : Math.round(g.minQty * (1.3 + (idx % 4) * 0.35)));
    buy.forEach(([offset, share], bi) => {
    const date = T.addDays(today, offset);
    const when = at(date, '08:40');
    const bySupplier = {};
    ings.forEach((g, idx) => {
      const [, , , , cost, shelf] = INGREDIENTS[idx];
      const need = consumed[g._id] || 0;
      let qty = need * share + (bi === 2 ? endStock(g, idx) : 0) + (bi === 1 ? need * 0.02 : 0);
      if (bi === 2 && g.name === 'Bia lon') qty = Math.max(qty, 72);
      qty = INGREDIENTS[idx][1] === 'g' || INGREDIENTS[idx][1] === 'ml' ? Math.ceil(qty / 100) * 100 : Math.ceil(qty);
      if (qty <= 0) return;
      const expiry = bi === 2 && g.name === 'Tôm sú' ? T.addDays(today, 2) : bi === 2 && g.name === 'Rau sống các loại' ? T.addDays(today, 1) : T.addDays(date, shelf + (bi === 2 ? 6 : 0));
      (bySupplier[g.supplierId] ||= []).push({ ingredientId: g._id, qty, unitCost: cost, expiry });
    });
    for (const [supplierId, lines] of Object.entries(bySupplier)) {
      const pid = uuid();
      purchases.push({ _id: pid, supplierId, date: when, method: chance(0.5) ? 'cash' : 'transfer', note: '', total: lines.reduce((s, l) => s + Math.round(l.qty * l.unitCost), 0), lines, ...stamp(when) });
      for (const l of lines) {
        lots.push({ _id: uuid(), ingredientId: l.ingredientId, purchaseId: pid, received: l.qty, remaining: l.qty, unitCost: l.unitCost, expiry: l.expiry, receivedAt: when, ...stamp(when) });
        moves.push({ _id: uuid(), ingredientId: l.ingredientId, qty: l.qty, kind: 'receive', note: 'Phiếu nhập', orderId: null, lots: [], reversed: false, at: when });
      }
    }
  });
  // consume lots oldest-expiry first, as the app does on close
  for (const g of ings) {
    let need = consumed[g._id] || 0;
    for (const lot of lots.filter((l) => l.ingredientId === g._id).sort((a, b) => (a.expiry < b.expiry ? -1 : 1))) {
      const take = Math.min(need, lot.remaining);
      lot.remaining = Math.round((lot.remaining - take) * 1000) / 1000;
      need -= take;
    }
  }
  // two small waste entries and a stocktake correction, as a real week would have
  const wasteOf = (name, qty, note, daysAgo) => {
    const g = ings[ING[name]];
    const lot = lots.filter((l) => l.ingredientId === g._id && l.remaining >= qty).pop();
    if (lot) lot.remaining -= qty;
    moves.push({ _id: uuid(), ingredientId: g._id, qty: -qty, kind: 'waste', note, orderId: null, lots: [], reversed: false, at: at(T.addDays(today, -daysAgo), '15:10') });
    actions.push({ adminName: ADMIN, action: 'waste', targetType: 'ingredient', targetId: g._id, note: `${qty} ${g.unit}: ${note}`, at: at(T.addDays(today, -daysAgo), '15:10') });
  };
  wasteOf('Rau sống các loại', 400, 'Héo, bỏ', 5);
  wasteOf('Cá lóc', 600, 'Hỏng do mất điện', 9);
  const riceLot = lots.filter((l) => l.ingredientId === ings[ING['Gạo']]._id && l.remaining >= 1200).pop();
  if (riceLot) riceLot.remaining -= 1200;
  moves.push({ _id: uuid(), ingredientId: ings[ING['Gạo']]._id, qty: -1200, kind: 'count', note: 'Kiểm kho cuối tuần', orderId: null, lots: [], reversed: false, at: at(T.addDays(today, -7), '22:30') });

  // ----- shifts (a closed one per past day + today's open one) and cash entries
  const shifts = [];
  const entries = [];
  const entryPool = [['Mua đá', -350000], ['Mua rau củ buổi sáng', -620000], ['Mua gas', -480000], ['Sửa bóng đèn', -150000], ['Bù quỹ lẻ', 200000]];
  for (let d = startDay; d <= today; d = T.addDays(d, 1)) {
    const isToday = d === today;
    const openedAt = isToday ? min(now, -Math.max(20, Math.min(nowMin - 9 * 60 - 30, 600))) : at(d, '09:30');
    const sh = { _id: uuid(), openedBy: ADMIN, openedAt, closedAt: null, startCash: 2000000, countedCash: null, expectedCash: null, difference: null, ...stamp(openedAt) };
    const list = [];
    for (let k = 0; k < (isToday ? 2 : int(0, 2)); k += 1) {
      const [reason, amount] = entryPool[(k + int(0, 3)) % entryPool.length];
      list.push({ _id: uuid(), shiftId: sh._id, amount, reason, at: min(openedAt, int(30, 240)), ...stamp(openedAt) });
    }
    entries.push(...list);
    if (!isToday) {
      const expected = sh.startCash + (shiftsCash[d]?.cash || 0) + list.reduce((s, e) => s + e.amount, 0);
      const diff = chance(0.7) ? 0 : pick([-20000, -10000, 5000, 15000]);
      sh.closedAt = at(d, '22:30');
      sh.expectedCash = expected;
      sh.countedCash = expected + diff;
      sh.difference = diff;
      sh.updatedAt = sh.closedAt;
      if (diff) actions.push({ adminName: ADMIN, action: 'shift_closed', targetType: 'shift', targetId: sh._id, note: `difference ${diff}`, at: sh.closedAt });
    }
    shifts.push(sh);
  }

  // ----- expenses and targets
  const prevMonth = T.addDays(`${month}-01`, -1).slice(0, 7);
  const expenses = [];
  for (const m of [prevMonth, month]) {
    for (const [category, amount, day, recurring, note] of [['Mặt bằng', 25000000, '01', true, 'Thuê mặt bằng'], ['Lương nhân viên', 52000000, '05', true, ''], ['Điện', int(6800, 8200) * 1000, '06', false, ''], ['Nước', int(1500, 2100) * 1000, '06', false, ''],
      ['Internet & phần mềm', 700000, '03', true, ''], ['Marketing', int(2, 4) * 1000000, '12', false, 'Quảng cáo Facebook, in menu'], ['Bảo trì thiết bị', int(8, 18) * 100000, '15', false, 'Vệ sinh máy lạnh, sửa tủ đông']]) {
      const date = `${m}-${day}`;
      if (date <= today) expenses.push({ _id: uuid(), category, amount, date, recurring, note, ...stamp(at(date, '09:00')) });
    }
  }
  const targets = [{ _id: prevMonth, targetRevenue: 560000000, ...stamp(now) }, { _id: month, targetRevenue: 620000000, ...stamp(now) }];

  // ----- bookings
  const bookings = [];
  const book = (date, startMin, party, name, tableLabels, status, note = '', deposit = 0) => {
    const startAt = at(date, hm(startMin));
    bookings.push({
      _id: uuid(), name, phone: phone(), party, date, startMin, durationMin: 90, note, areaPref: '', deposit, status, tableIds: tableLabels.map((l) => tableBy[l]._id), startAt, endAt: min(startAt, 100),
      search: noAccent(name), ...stamp(min(startAt, -60 * 24)),
    });
  };
  const tmr = T.addDays(today, 1);
  book(today, 18 * 60 + 30, 4, 'Chị Hương', ['A1'], 'booked');
  book(today, 19 * 60, 6, 'Anh Việt (sinh nhật con)', ['A6'], 'booked', 'Sinh nhật, cần bánh kem để sẵn', 300000);
  book(today, 19 * 60 + 30, 2, 'Anh Khoa', ['A3'], 'booked');
  book(today, 20 * 60, 12, 'Công ty Hoàng Long (tiệc cuối năm)', ['B6'], 'booked', 'Cần máy chiếu', 1000000);
  book(tmr, 12 * 60, 8, 'Chị Mai', ['A8'], 'booked');
  book(tmr, 18 * 60 + 30, 4, 'Anh Dũng', ['C1'], 'booked', 'Ngồi sân vườn');
  book(tmr, 19 * 60, 10, 'Gia đình bà Tư', ['B5'], 'booked', 'Có người lớn tuổi, bàn gần cầu thang');
  book(tmr, 19 * 60 + 30, 4, 'Chị Linh', ['B1'], 'booked');
  book(T.addDays(today, 2), 19 * 60, 6, 'Anh Hùng', ['B3'], 'booked');
  book(T.addDays(today, -1), 19 * 60, 4, 'Chị Trang', ['A2'], 'arrived');
  book(T.addDays(today, -1), 19 * 60 + 30, 2, 'Anh Nam', ['A4'], 'noshow');
  book(T.addDays(today, -2), 18 * 60, 6, 'Chị Yến', ['A5'], 'cancelled', 'Khách báo hủy');
  const waits = [{ _id: uuid(), name: 'Anh Long', phone: phone(), party: 3, joinedAt: min(now, -8), ...stamp(now) }, { _id: uuid(), name: 'Chị Phương', phone: '', party: 5, joinedAt: min(now, -3), ...stamp(now) }];

  // a few journal entries that are not derived above
  actions.push({ adminName: ADMIN, action: 'bulk_price', targetType: 'menu', targetId: null, note: '5% on 29 items', at: at(T.addDays(today, -15), '09:00') });
  actions.push({ adminName: ADMIN, action: 'admin_added', targetType: 'account', targetId: null, note: 'thu ngân', at: at(T.addDays(today, -20), '10:00') });
  const cancelled = orders.flatMap((o) => o.lines.filter((l) => l.status === 'cancelled').map((l) => ({ o, l })));
  for (const { o, l } of cancelled.slice(-10)) actions.push({ adminName: ADMIN, action: 'line_cancelled', targetType: 'order', targetId: o._id, note: `${l.name} x${l.qty}: ${l.cancelReason}`, at: o.closedAt });

  // ----- write
  const all = [...orders, ...live];
  const ins = async (Model, docs) => { for (let i = 0; i < docs.length; i += 500) await Model.insertMany(docs.slice(i, i + 500)); };
  await ins(M.Customer, customers);
  await ins(M.Promotion, promos);
  await ins(M.Table, tables);
  await ins(M.Order, all);
  await ins(M.Purchase, purchases);
  await ins(M.StockLot, lots);
  await ins(M.StockMove, moves);
  await ins(M.Shift, shifts);
  await ins(M.CashEntry, entries);
  await ins(M.Expense, expenses);
  await ins(M.SalesTarget, targets);
  await ins(M.Booking, bookings);
  await ins(M.WaitEntry, waits);
  await ins(M.Counter, counters);
  await ins(M.AdminAction, actions.map((a) => ({ _id: uuid(), adminId: null, targetId: null, ...a })));

  const closed = orders.length;
  console.log(`seeded "${(await M.Setting.findById('shop').lean()).value.name}": ${closed} closed orders over 28 days, ${live.length} live orders, ${items.length} dishes, ${customers.length} customers`);
  console.log(`login: ${EMAIL} / ${PASSWORD}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
