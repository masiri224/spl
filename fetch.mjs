// يسحب بيانات دوري الفانتزي ويبني data.json — بلا مكتبات خارجية
// التشغيل: node fetch.mjs

import { writeFileSync } from 'node:fs';

const LEAGUE_ID = process.env.LEAGUE_ID || '1393';
const BASE = 'https://fantasy.spl.com.sa/api';
const UA = 'Mozilla/5.0 (compatible; fantasy-dashboard/1.0)';

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

const [league, boot] = await Promise.all([
  api(`/leagues-classic/${LEAGUE_ID}/standings/?page_new_entries=1&page_standings=1&phase=1`),
  api('/bootstrap-static/')
]);

// ── خرائط مساعدة ─────────────────────────────────────────────
// يحذف الإيموجي المكسور (نصف زوج بديل) ورمز الاستبدال
const clean = v => String(v ?? '')
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\uFFFD/g, '')
  .replace(/\s{2,}/g, ' ')
  .trim();
const teamById = Object.fromEntries(boot.teams.map(t => [t.id, clean(t.name)]));
const posById  = Object.fromEntries(boot.element_types.map(t => [t.id, clean(t.singular_name)]));
const playerById = Object.fromEntries(boot.elements.map(e => [e.id, clean(e.web_name)]));

const currentEvent = boot.events.find(e => e.is_current) || boot.events.filter(e => e.finished).pop();
const nextEvent    = boot.events.find(e => e.is_next);

const P = e => ({
  name: clean(e.web_name),
  club: teamById[e.team] || '',
  pos: posById[e.element_type] || '',
  price: (e.now_cost / 10).toFixed(1),
  pts: e.total_points,
  own: `${e.selected_by_percent}%`,
  goals: e.goals_scored,
  assists: e.assists
});

const topBy = (key, n) => boot.elements
  .filter(e => e[key] > 0)
  .sort((a, b) => b[key] - a[key] || b.total_points - a.total_points)
  .slice(0, n).map(P);

// ── تصنيف حالة اللاعب من حقل news ───────────────────────────
function classify(e) {
  const t = (e.news || '').toLowerCase();
  if (!t) return null;
  if (/loan|move|free agent|إعارة|انتقال|إنتقال|لاعب حر/.test(t)) return 'gone';
  if (/suspend|موقوف/.test(t)) return 'ban';
  if (/doubt|مشكوك/.test(t)) return 'doubt';
  if (e.status === 'i' || e.status === 'u' || /injur|إصابة/.test(t)) return 'out';
  return 'doubt';
}
// يأخذ الجزء العربي من النص ثنائي اللغة، وإلا يُبقيه كما هو
const arabicPart = s => {
  const m = String(s ?? '').match(/[\u0600-\u06FF][\s\S]*$/);
  return (m ? m[0] : String(s ?? '')).replace(/\s*[-–]\s*$/, '').trim();
};

const ORDER = { out: 0, ban: 1, doubt: 2, gone: 3 };
const injuries = boot.elements
  .map(e => ({ e, status: classify(e) }))
  .filter(x => x.status)
  .map(({ e, status }) => ({
    name: clean(e.web_name),
    club: teamById[e.team] || '',
    status,
    detail: arabicPart(e.news),
    back: e.chance_of_playing_next_round === null ? '—' : `${e.chance_of_playing_next_round}% جاهزية`
  }))
  .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.club.localeCompare(b.club, 'ar'));

// ── أخبار تُبنى تلقائياً من أرقام الجولة ─────────────────────
const news = [];
if (nextEvent) {
  const d = new Date(nextEvent.deadline_time)
    .toLocaleString('ar-SA-u-nu-latn', { timeZone: 'Asia/Riyadh', dateStyle: 'full', timeStyle: 'short' });
  news.push({
    date: clean(nextEvent.name),
    title: `الموعد النهائي: ${d}`,
    body: 'آخر فرصة للانتقالات وتغيير القائد قبل انطلاق الجولة.'
  });
}
if (currentEvent) {
  news.push({
    date: clean(currentEvent.name),
    title: `متوسط النقاط ${currentEvent.average_entry_score} وأعلى نتيجة ${currentEvent.highest_score ?? '—'}`,
    body: `تصدّر دورينا «${clean(league.standings.results[0]?.entry_name)}» بـ ${league.standings.results[0]?.total} نقطة.`
  });
  if (currentEvent.most_captained) news.push({
    date: clean(currentEvent.name),
    title: `${playerById[currentEvent.most_captained]} الأكثر اختياراً كقائد`,
    body: 'شارة القيادة ذهبت إليه أكثر من أي لاعب آخر هذه الجولة.'
  });
  if (currentEvent.most_transferred_in) news.push({
    date: 'سوق الانتقالات',
    title: `${playerById[currentEvent.most_transferred_in]} الأكثر شراءً`,
    body: 'أكثر لاعب دخل فرق المشاركين هذه الجولة.'
  });
}
const longOut = injuries.filter(p => p.status === 'out').slice(0, 6);
if (longOut.length) news.push({
  date: 'إصابات',
  title: `${injuries.filter(p => p.status === 'out').length} لاعباً خارج الحسابات بالإصابة`,
  body: longOut.map(p => `${p.name} (${p.club})`).join('، ') + '.'
});
const bans = injuries.filter(p => p.status === 'ban');
if (bans.length) news.push({
  date: 'إيقافات',
  title: `${bans.length} لاعبين موقوفين`,
  body: bans.map(p => `${p.name} (${p.club})`).join('، ') + '.'
});

// ── الإخراج ──────────────────────────────────────────────────
const data = {
  league: clean(league.league.name),
  gameweek: currentEvent ? currentEvent.id : null,
  updated: new Date().toLocaleString('ar-SA-u-nu-latn', { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' }),
  sourceUrl: `https://fantasy.spl.com.sa/leagues/${LEAGUE_ID}/standings/c`,

  standings: league.standings.results.map(r => ({
    rank: r.rank,
    lastRank: r.last_rank,
    team: clean(r.entry_name) || clean(r.player_name) || 'بلا اسم',
    manager: clean(r.player_name),
    gw: r.event_total,
    total: r.total
  })),

  newEntries: (league.new_entries?.results || []).map(r => ({
    team: clean(r.entry_name),
    manager: clean(`${r.player_first_name} ${r.player_last_name}`)
  })),

  scorers:   topBy('goals_scored', 25),
  assisters: topBy('assists', 20),
  topPoints: boot.elements.slice().sort((a, b) => b.total_points - a.total_points).slice(0, 20).map(P),
  injuries,
  news
};

writeFileSync('data.json', JSON.stringify(data, null, 1));
console.log(`✓ الجولة ${data.gameweek} — ${data.standings.length} فريقاً، ${injuries.length} حالة، ${news.length} خبراً`);
