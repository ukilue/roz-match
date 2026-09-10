// functions/api/_party.js — 伺服器端組團演算法（留言板權限驗證用）
// 與前端 public/index.html 及 cron-worker.js 的演算法「完全一致」。
// ⚠ 若修改組團規則，三處必須同步修改。

const DUNGEONS = ["90級↑副本4困1普", "90級↑副本3困2普", "80級↑副本3困1普", "105級副本"];
const SQUAD_SIZE = 12, MIN_PARTY = 3;   // 預期分團人數：每日與副本一律 12 人一團（報名不設上限）
export const isDungeon = act => DUNGEONS.includes(act);
const maxOf = act => SQUAD_SIZE;   // 每個預期分團的人數上限（保留函式形式，日後若要分目標設定只改這裡）
const ROLES = ["大腿", "坦", "補", "打", "便當"];
const roleOf = m => m.role || (m.bento ? "便當" : "打");
const roleCount = (ms, r) => ms.filter(m => roleOf(m) === r).length;
// 副本→有「大腿」直接成團；沒大腿則需「坦」「打」各 1；每日→滿 3 人
// 緩衝分鐘數：一律 10 分鐘（成團「請準備」通知後 10 分鐘出發）
const BUFFER_MIN = 10;
const bufferOf = () => BUFFER_MIN;
// 台北時區某日某分鐘 → 絕對時間戳(ms)（台北固定 UTC+8）
function taipeiMs(dateStr, min){
  const [y,mo,d] = dateStr.split("-").map(Number);
  return Date.UTC(y, mo-1, d, 0, 0) + min*60000 - 8*3600000;
}
// 將絕對時間戳(ms)換算為「dateStr 這一天」的台北分鐘數；落在前一天 → 0、落在隔天 → 1439（不會跨日誤判）
function taipeiMinOfTs(ts, dateStr){
  return Math.max(0, Math.min(1439, Math.floor((ts - taipeiMs(dateStr, 0)) / 60000)));
}
const canForm = (act, ms) => {
  if (!isDungeon(act)) return ms.length >= MIN_PARTY;
  return roleCount(ms, "大腿") >= 1 || (roleCount(ms, "坦") >= 1 && roleCount(ms, "打") >= 1);
};
const pad = n => String(n).padStart(2, "0");
const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const toHM = m => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
const hashStr = s => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };

// yyyy-mm-dd 加減天數（台北日期字串運算，不受時區影響）
export function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

export function taipeiNow() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, min: (Number(g("hour")) % 24) * 60 + Number(g("minute")) };
}

// 成團後的兩階段時程（成團的團才有；未成團回傳 null）：
//   readyMin  = max(時段起點 − 10 分, 成團時刻)＝發「請準備」通知、開語音房的時刻（10:00 出團 → 09:50 提醒）
//               成團時刻由成員登記時間戳依序推算；成團太晚（不足 10 分）則以成團當下為 ready
//   departMin = readyMin + 10 分鐘緩衝（壓縮不超過時段終點）＝關團、發「出發」通知
function scheduleOf(act, g, is, ie, dateStr) {
  if (!canForm(act, g)) return null;
  const sorted = g.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.charId.localeCompare(b.charId));
  let formedTs = sorted[sorted.length - 1].ts || 0;
  for (let i = 0; i < sorted.length; i++) {
    if (canForm(act, sorted.slice(0, i + 1))) { formedTs = sorted[i].ts || 0; break; }
  }
  const readyMin = Math.max(is - BUFFER_MIN, taipeiMinOfTs(formedTs, dateStr));
  const buffer = bufferOf(sorted.length);
  const departMin = Math.min(readyMin + buffer, Math.max(ie, readyMin), 1439);
  return { readyMin, departMin, buffer };
}
// 一筆登記能否併入目前這群人（以登記時間戳判斷，結果與「現在幾點」無關 → 各端一致）：
//   1. 這群人已出發（登記時間 ≥ 出發時刻）→ 不收人，另起新團（避免已出發的團被後來的登記「復活」）
//   2. 「請準備」已發出（登記時間 ≥ ready）→ 只接受同時段加入，不接受會把出發時間往後推的登記
function canJoinCluster(act, members, is, ie, dateStr, r) {
  const sch = scheduleOf(act, members, is, ie, dateStr);
  if (!sch) return true;
  const ts = r.ts || 0;
  if (ts >= taipeiMs(dateStr, sch.departMin)) return false;
  if (ts >= taipeiMs(dateStr, sch.readyMin) && toMin(r.start) > is) return false;
  return true;
}

// ── 一個「揪團」＝同目標、時段有交集的整群人：共用一個編號、一個留言板、一份出發時程 ──
// 群內另外算出「預期分團」squads（一律 12 人一團；同一 Discord 帳號的角色優先同團；再依職業平均；副本再依便當平均；可由玩家 ↑↓ 手動微調），
// 只用於明細顯示與開語音房（揪團-編號-目標-1、-2…），加人時可動態變動，不影響揪團本身。
function buildSquads(act, members, is, ie, dateStr) {
  const byTs = arr => arr.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.charId.localeCompare(b.charId));
  // 帳號鍵：前端拿到的是伺服器給的匿名 acct、後端／Worker 是 discordId；只要「同帳號 → 同鍵」分團結果就一致
  const acctOf = m => m.acct || m.discordId || m.uid || m.charId;
  // 「請準備」通知（ready 時刻）之後才加入的人＝緩衝期補人：不重新分團、不重新平均職業，
  // 直接補進「已有同帳號成員的團」，否則補進人數最少的團，讓已通知的分團名單不再變動
  let core = members, late = [];
  const whole = scheduleOf(act, members, is, ie, dateStr);
  if (whole) {
    const readyMs = taipeiMs(dateStr, whole.readyMin);
    const c = members.filter(m => (m.ts || 0) < readyMs);
    if (c.length && canForm(act, c)) { core = c; late = byTs(members.filter(m => (m.ts || 0) >= readyMs)); }
  }
  const groups = [];
  const jobCount = (g, j) => g.filter(x => x.job === j).length;
  const hasMate = (g, unit) => g.some(x => unit.some(y => acctOf(x) === acctOf(y)));
  // 同一 Discord 帳號登記的多個角色綁成一個「單位」，一起放進同一團
  const unitsOf = arr => { const map = {}; byTs(arr).forEach(m => { (map[acctOf(m)] ||= []).push(m); }); return Object.values(map); };
  // 放置單位：在還放得下的團中挑分數最低者；全都放不下 → 另開候補團
  const place = (unit, max, score) => {
    let best = -1, bestScore = null;
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].length + unit.length > max) continue;
      const sc = score(groups[i], unit, i);
      if (best < 0 || sc < bestScore) { best = i; bestScore = sc; }
    }
    if (best < 0) { groups.push([]); best = groups.length - 1; }
    groups[best].push(...unit);
  };
  if (canForm(act, core)) {
    const max = maxOf(act), dg = isDungeon(act);
    const isBento = m => roleOf(m) === "便當";
    const bentoCount = g => g.filter(isBento).length;
    // 單位順序：角色多的帳號先放；接著職業人數多→少、職業名、登記順序
    const jobFreq = {};
    core.forEach(m => { jobFreq[m.job] = (jobFreq[m.job] || 0) + 1; });
    const units = unitsOf(core).sort((a, b) =>
      b.length - a.length ||
      (jobFreq[b[0].job] || 0) - (jobFreq[a[0].job] || 0) || String(a[0].job).localeCompare(String(b[0].job)) ||
      (a[0].ts || 0) - (b[0].ts || 0) || a[0].charId.localeCompare(b[0].charId));
    // 分數：同帳號成員所在的團最優先 → 同職業少（職業平均）→（副本）便當少（便當平均）→ 人數少 → 組序
    // 每日與副本用同一套；副本各團是否湊得出核心不在此保證，玩家可在明細用 ↑↓ 手動微調
    const score = (g, unit, i) =>
      (hasMate(g, unit) ? 0 : 1) * 1e6 +
      unit.reduce((s, m) => s + jobCount(g, m.job), 0) * 1000 +
      (dg ? unit.filter(isBento).length * bentoCount(g) * 100 : 0) +
      g.length * 10 + i;
    const count = Math.ceil(core.length / max);
    for (let i = 0; i < count; i++) groups.push([]);
    units.forEach(u => place(u, max, score));
  } else groups.push(byTs(core));
  late.forEach(m => {
    let bi = -1;
    groups.forEach((g, i) => { if (bi < 0 && hasMate(g, [m])) bi = i; });
    if (bi < 0) { bi = 0; groups.forEach((g, i) => { if (g.length < groups[bi].length) bi = i; }); }
    groups[bi].push(m);
  });
  // 手動微調：登記上有 squad（玩家在明細按 ↑↓ 設定的目標團序）的人，從系統分配的團移到指定團（超出範圍取最後一團）
  const manual = members.filter(m => Number.isInteger(m.squad) && m.squad >= 1);
  if (manual.length && groups.length > 1) {
    byTs(manual).forEach(m => {
      const target = Math.min(m.squad, groups.length) - 1;
      const from = groups.findIndex(g => g.includes(m));
      if (from < 0 || from === target) return;
      groups[from].splice(groups[from].indexOf(m), 1);
      groups[target].push(m);
    });
  }
  // 每個預期分團的隊長＝該團最早登記者（補人只會往後加，隊長不會因此變動）
  return groups.filter(g => g.length).map((g, i) => ({ index: i + 1, members: g, leader: byTs(g)[0] }));
}

function splitCluster(act, members, is, ie, dateStr, removedRegs) {
  const byTs = arr => arr.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.charId.localeCompare(b.charId));
  const sorted = byTs(members);
  const id = act + "|" + toHM(is) + "|" + sorted.map(m => m.charId).sort().join(",");
  // 錨點：整群最早登記者（退出採軟刪除，退出者仍是錨點候選）→ 編號、留言板 key 創團後永不變動
  let anchor = sorted[0];
  for (const c of (removedRegs || []).filter(r => toMin(r.start) <= ie && is <= toMin(r.end))) {
    if ((c.ts || 0) < (anchor.ts || 0) || ((c.ts || 0) === (anchor.ts || 0) && c.charId.localeCompare(anchor.charId) < 0)) anchor = c;
  }
  const stable = act + "|" + anchor.charId + "|" + (anchor.ts || 0);
  const sch = scheduleOf(act, members, is, ie, dateStr);
  const squads = buildSquads(act, members, is, ie, dateStr);
  return {
    id, activity: act, members: sorted, time: is, timeEnd: ie,
    ok: !!sch, readyMin: sch ? sch.readyMin : null, departMin: sch ? sch.departMin : null, buffer: sch ? sch.buffer : null,
    squads, leader: squads[0].leader,
    num: String(hashStr(stable + "|" + dateStr + "|num") % 10000).padStart(4, "0"),
    chatKey: "c" + hashStr(stable + "|" + dateStr).toString(36) + hashStr(stable + "|chat").toString(36)
  };
}

export function buildParties(regs, dateStr) {
  const todays = regs.filter(r => r.date === dateStr);
  const byAct = {};
  todays.filter(r => !r.removed).forEach(r => { (byAct[r.activity] ||= []).push(r); });
  const removedByAct = {};
  todays.filter(r => r.removed).forEach(r => { (removedByAct[r.activity] ||= []).push(r); });
  const parties = [];
  for (const act in byAct) {
    const list = byAct[act].slice().sort((a, b) => toMin(a.start) - toMin(b.start) || a.charId.localeCompare(b.charId));
    let cluster = [], is = 0, ie = 0;
    const flush = () => { if (cluster.length) parties.push(splitCluster(act, cluster, is, ie, dateStr, removedByAct[act] || [])); };
    for (const r of list) {
      const s = toMin(r.start), e = toMin(r.end);
      if (!cluster.length) { cluster = [r]; is = s; ie = e; continue; }
      if (s <= ie && canJoinCluster(act, cluster, is, ie, dateStr, r)) { cluster.push(r); is = Math.max(is, s); ie = Math.min(ie, e); }
      else { flush(); cluster = [r]; is = s; ie = e; }
    }
    flush();
  }
  return parties;
}
