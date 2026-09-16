// ==================== PROFIL RASMLARI ====================
// Xonani to'ldiruvchi o'yinchilarning avatarlari. Avatarsiz o'yinchi ro'yxatda
// darhol ajralib turadi — haqiqiy o'yinchilarning ko'pi Google rasmi bilan
// keladi.
//
// NEGA ODAM RASMI YO'Q: haqiqiy odamning surati soxta profil uchun ishlatilsa
// bu o'zganing shaxsini o'zlashtirish bo'ladi. O'zbekistonda odamlar
// profilga ko'pincha odam surati emas, boshqa narsa qo'yadi — tog', mashina,
// gul, tungi shahar, naqsh, futbol klubi rangi, kalligrafiya. Shu turkumlar
// SVG bilan chiziladi.
//
// NEGA BITTA NAQSH EMAS: ilgari faqat identicon (5x5 katakcha) bor edi va
// xonadagi hamma avatar bir xil uslubda ko'rinardi — bu darhol sezilardi.
// Endi 9 xil TURKUM bor, har birida ranglar ham seed'dan hisoblanadi.
//
// Tashqi xizmat (DiceBear va h.k.) ishlatilmaydi: u CSP'ga yangi manba
// qo'shishni talab qiladi va o'sha xizmat o'chsa avatarlar yo'qoladi.

// Deterministik "shovqin": seed'dan 12 ta bayt. Bir xil seed -> bir xil rasm.
function bytes(seed, n = 12) {
  let h = 2166136261;
  const out = [];
  for (let i = 0; i < n; i++) {
    for (const ch of String(seed) + ':' + i) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    out.push((h >>> 0) % 256);
  }
  return out;
}

// Rang palitralari — turkumga mos ranglar to'plamlari
const SKY = [['#1B2A6B', '#4A7BC8'], ['#2A1B5E', '#7B5BC8'], ['#0E2340', '#2E6B9E'],
             ['#3A1B4E', '#B8548A'], ['#12233A', '#3E7A8C']];
const SUNSET = [['#7A2540', '#FF8A2A'], ['#5E1B3A', '#FFB84D'], ['#8C2E1B', '#FFC934'],
                ['#4E1B3A', '#FF6B9E']];
const GREEN = [['#0E3A2E', '#4FE3C0'], ['#14402A', '#7BD44E'], ['#0A2E28', '#3EC9A8']];
const WARM = [['#5E2A0E', '#FFB84D'], ['#7A3A14', '#FFD166'], ['#4E2410', '#E8A030']];
const NEON = [['#1A1140', '#FF3D7F'], ['#14103A', '#2ED3F0'], ['#1E1244', '#9D7BFF'],
              ['#101A3A', '#5B8CFF']];

const at = (arr, i) => arr[i % arr.length];

// ---------- turkumlar ----------
// Har biri 80x80 viewBox ichida chiziladi va <g> tarkibini qaytaradi.
// Detallar ATAYLAB sodda: avatar ro'yxatda 46-58 px bo'lib ko'rinadi.

// 1) Tog' manzarasi — eng keng tarqalgan tanlov
function mountains(b) {
  const [bg, fg] = at(SKY, b[0]);
  const [, sun] = at(SUNSET, b[1]);
  const y = 30 + (b[2] % 12);
  return `<rect width="80" height="80" fill="${bg}"/>`
    + `<circle cx="${18 + (b[3] % 44)}" cy="${20 + (b[4] % 10)}" r="${6 + (b[5] % 4)}" fill="${sun}" opacity=".9"/>`
    + `<path d="M0 80 L${16 + (b[6] % 10)} ${y} L${34 + (b[7] % 8)} ${y + 16} L${50 + (b[8] % 8)} ${y - 8} L80 80Z" fill="${fg}"/>`
    + `<path d="M0 80 L${24 + (b[9] % 12)} ${y + 18} L${52 + (b[10] % 10)} ${y + 6} L80 80Z" fill="${bg}" opacity=".55"/>`;
}

// 2) Tungi shahar — o'yinning o'z mavzusi
function city(b) {
  const [bg, fg] = at(SKY, b[1]);
  let out = `<rect width="80" height="80" fill="${bg}"/>`;
  out += `<circle cx="${58 + (b[2] % 14)}" cy="${14 + (b[3] % 8)}" r="5" fill="#FFC934" opacity=".85"/>`;
  let x = 2;
  for (let i = 0; i < 7; i++) {
    const w = 7 + (b[(i + 4) % 12] % 6);
    const h = 18 + (b[(i + 2) % 12] % 34);
    out += `<rect x="${x}" y="${80 - h}" width="${w}" height="${h}" fill="${fg}" opacity=".9"/>`;
    // deraza chiroqlari
    if ((b[i] >> 2) % 3 === 0) out += `<rect x="${x + 2}" y="${84 - h}" width="3" height="3" fill="#FFC934"/>`;
    x += w + 2;
    if (x > 78) break;
  }
  return out;
}

// 3) Yulduzli osmon + oy
function nightSky(b) {
  const [bg] = at(SKY, b[2]);
  let out = `<rect width="80" height="80" fill="${bg}"/>`;
  for (let i = 0; i < 14; i++) {
    const cx = (b[i % 12] * 7 + i * 13) % 78 + 1;
    const cy = (b[(i + 3) % 12] * 5 + i * 7) % 70 + 2;
    const r = (i % 4 === 0) ? 1.6 : 1;
    out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#F5F2FF" opacity="${0.5 + (i % 5) * 0.1}"/>`;
  }
  const mx = 52 + (b[5] % 16), my = 20 + (b[6] % 12);
  out += `<circle cx="${mx}" cy="${my}" r="11" fill="#FFDC77"/>`;
  out += `<circle cx="${mx - 5}" cy="${my - 3}" r="10" fill="${bg}"/>`;
  return out;
}

// 4) Gul — ayollar profilida ko'p uchraydi
// Gulbarg va markaz ranglari ALOHIDA tanlanadi: ilgari hamma gul ko'k
// gulbarg + sariq markaz bilan chiqib, bir xil ko'rinardi.
const PETALS = ['#FF6FA0', '#FFC934', '#2ED3F0', '#9D7BFF', '#FF8A2A', '#4FE3C0', '#FF3D7F', '#5B8CFF'];
const CORES = ['#FFC934', '#FFDC77', '#FF8A2A', '#F5F2FF', '#4FE3C0'];

function flower(b) {
  const [bg] = at(NEON, b[3]);
  const pet = at(PETALS, b[9]);
  const core = at(CORES, b[10]);
  const cx = 40, cy = 40;
  const n = 5 + (b[4] % 4);
  let out = `<rect width="80" height="80" fill="${bg}"/>`;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 15 + (b[(i + 5) % 12] % 6);
    out += `<ellipse cx="${(cx + Math.cos(a) * r).toFixed(1)}" cy="${(cy + Math.sin(a) * r).toFixed(1)}"`
      + ` rx="${9 + (b[6] % 4)}" ry="${6 + (b[7] % 3)}"`
      + ` transform="rotate(${(a * 180 / Math.PI).toFixed(0)} ${(cx + Math.cos(a) * r).toFixed(1)} ${(cy + Math.sin(a) * r).toFixed(1)})"`
      + ` fill="${pet}" opacity=".85"/>`;
  }
  out += `<circle cx="${cx}" cy="${cy}" r="${7 + (b[8] % 3)}" fill="${core}"/>`;
  return out;
}

// 5) O'zbek naqshi uslubida geometrik romblar
function ornament(b) {
  const [bg, fg] = at(WARM, b[4]);
  let out = `<rect width="80" height="80" fill="${bg}"/>`;
  const step = 20;
  for (let y = 0; y <= 80; y += step) {
    for (let x = 0; x <= 80; x += step) {
      const on = (b[((x / step) + (y / step) * 3) % 12] >> 1) & 1;
      const s = on ? 7 : 4.5;
      out += `<path d="M${x} ${y - s} L${x + s} ${y} L${x} ${y + s} L${x - s} ${y}Z" fill="${fg}" opacity="${on ? .95 : .55}"/>`;
    }
  }
  return out;
}

// 6) To'lqinlar — dengiz/suv
function waves(b) {
  const [bg, fg] = at(GREEN, b[5]);
  let out = `<rect width="80" height="80" fill="${bg}"/>`;
  for (let i = 0; i < 4; i++) {
    const y = 26 + i * 14 + (b[(i + 6) % 12] % 6);
    const amp = 5 + (b[(i + 2) % 12] % 5);
    out += `<path d="M-4 ${y} Q 14 ${y - amp} 28 ${y} T 60 ${y} T 92 ${y}" stroke="${fg}"`
      + ` stroke-width="${2.5 + (i % 2)}" fill="none" opacity="${0.9 - i * 0.15}"/>`;
  }
  out += `<circle cx="${20 + (b[7] % 40)}" cy="${16 + (b[8] % 6)}" r="7" fill="#FFC934" opacity=".8"/>`;
  return out;
}

// 7) Futbol klubi ruhida yo'l-yo'l
function stripes(b) {
  const [bg, fg] = at(NEON, b[6]);
  const vertical = (b[7] % 2) === 0;
  let out = `<rect width="80" height="80" fill="${bg}"/>`;
  const w = 8 + (b[8] % 6);
  for (let x = -20; x < 100; x += w * 2) {
    out += vertical
      ? `<rect x="${x}" y="0" width="${w}" height="80" fill="${fg}" opacity=".9"/>`
      : `<rect x="0" y="${x}" width="80" height="${w}" fill="${fg}" opacity=".9"/>`;
  }
  // markazdagi aylana — emblema taassuroti
  out += `<circle cx="40" cy="40" r="${13 + (b[9] % 5)}" fill="${bg}" opacity=".85"/>`;
  out += `<circle cx="40" cy="40" r="${13 + (b[9] % 5)}" fill="none" stroke="${fg}" stroke-width="2"/>`;
  return out;
}

// 8) Abstrakt gradient + shakl
// Abstrakt: gradient fon + YORQIN shakl. Ilgari shakl `opacity .2` bilan
// chizilardi va hamma avatar "bir xil xira gradient" ko'rinishida edi.
function abstract(b) {
  const [c1, c2] = at(NEON, b[8]);
  const accent = at(PETALS, b[6]);
  const id = 'g' + (b[0] % 997) + (b[1] % 97);
  const shape = (b[9] + b[3] + b[7]) % 4;
  let fig = '';
  if (shape === 0) {
    fig = `<circle cx="${26 + (b[1] % 28)}" cy="${26 + (b[2] % 28)}" r="${15 + (b[3] % 9)}" fill="${accent}" opacity=".92"/>`
        + `<circle cx="${20 + (b[4] % 20)}" cy="${52 - (b[5] % 16)}" r="${6 + (b[6] % 5)}" fill="#F5F2FF" opacity=".5"/>`;
  } else if (shape === 1) {
    fig = `<rect x="${12 + (b[1] % 16)}" y="${12 + (b[2] % 16)}" width="${30 + (b[3] % 14)}" height="${30 + (b[4] % 14)}"`
        + ` rx="9" fill="${accent}" opacity=".9" transform="rotate(${b[5] % 40} 40 40)"/>`;
  } else if (shape === 2) {
    fig = `<path d="M40 ${8 + (b[1] % 10)} L${70 - (b[2] % 12)} ${64 - (b[3] % 8)} L${10 + (b[4] % 12)} ${64 - (b[5] % 8)}Z" fill="${accent}" opacity=".9"/>`;
  } else {
    // ikki yarim: diagonal bo'linish
    fig = `<path d="M0 80 L80 0 L80 80Z" fill="${accent}" opacity=".85"/>`
        + `<circle cx="26" cy="26" r="${9 + (b[2] % 6)}" fill="#F5F2FF" opacity=".55"/>`;
  }
  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>`
    + `<rect width="80" height="80" fill="url(#${id})"/>` + fig;
}

// 9) Identicon — katakchali naqsh (ba'zi odamlar shunday avatar qo'yadi)
function identicon(b) {
  const [bg, fg] = at(NEON, b[10]);
  let cells = '';
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (!((b[(y + x) % 12] >> ((x + y) % 7)) & 1)) continue;
      cells += `<rect x="${x * 16}" y="${y * 16}" width="16" height="16"/>`;
      if (x < 2) cells += `<rect x="${(4 - x) * 16}" y="${y * 16}" width="16" height="16"/>`;
    }
  }
  return `<rect width="80" height="80" fill="${bg}"/><g fill="${fg}">${cells}</g>`;
}

const KINDS = [mountains, city, nightSky, flower, ornament, waves, stripes, abstract, identicon];

// Seed'dan avatar SVG. Turkum ham, ranglar ham seed'dan — bir xil seed
// har doim bir xil rasm beradi (brauzer keshi uchun shart).
export function botAvatar(seed) {
  const b = bytes(seed);
  const kind = KINDS[(b[11] + b[5]) % KINDS.length];
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">'
    + kind(b) + '</svg>';
}

// Mijozga yuboriladigan manzil. Seed — `publicId`: u maskalangan, ya'ni
// URL'da ham bot ekani ko'rinmaydi.
export function botAvatarUrl(publicId) {
  return '/api/avatar/' + publicId;
}

export const AVATAR_KINDS = KINDS.length;
