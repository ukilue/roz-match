// functions/api/_party.js — 伺服器端組團演算法（留言板權限驗證用）
// 與前端 public/index.html 及 cron-worker.js 的演算法「完全一致」。
// ⚠ 若修改組團規則，三處必須同步修改。

const DUNGEONS = ["副本4困1普", "副本3困2普"];
const MAX_PARTY = 12, MIN_PARTY = 3;
const isDungeon = act => DUNGEONS.includes(act);
const ROLES = ["大腿", "坦", "補", "打", "便當"];
const roleOf = m => m.role || (m.bento ? "便當" : "打");
const roleCount = (ms, r) => ms.filter(m => roleOf(m) === r).length;
// 副本→有「大腿」直接成團；沒大腿則需「坦」「打」各 1；每日→滿 3 人
// 緩衝分鐘數：以「準備通知當下」的人數決定，之後加人不改變出發時間
const bufferOf = n => n <= 3 ? 30 : n <= 5 ? 20 : n <= 7 ? 15 : 10;
// 將絕對時間戳(ms)換算為台北時區的當日分鐘數
function taipeiMinOfTs(ts){
  const p = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(new Date(ts));
  const g = t => Number(p.find(x=>x.type===t).value);
  return (g("hour")%24)*60 + g("minute");
}
// 台北時區某日某分鐘 → 絕對時間戳(ms)（台北固定 UTC+8）
function taipeiMs(dateStr, min){
  const [y,mo,d] = dateStr.split("-").map(Number);
  return Date.UTC(y, mo-1, d, 0, 0) + min*60000 - 8*3600000;
}
const canForm = (act, ms) => {
  if (!isDungeon(act)) return ms.length >= MIN_PARTY;
  return roleCount(ms, "大腿") >= 1 || (roleCount(ms, "坦") >= 1 && roleCount(ms, "打") >= 1);
};
const pad = n => String(n).padStart(2, "0");
const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const toHM = m => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
const hashStr = s => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };

export function taipeiNow() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, min: (Number(g("hour")) % 24) * 60 + Number(g("minute")) };
}

function splitCluster(act, members, is, ie, dateStr, removedRegs) {
  const groups = [];
  const byTs = arr => arr.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.charId.localeCompare(b.charId));
  if (canForm(act, members)) {
    let count = Math.ceil(members.length / MAX_PARTY);
    if (isDungeon(act)) {
      // 每個拆出的團都要有核心：一隻大腿、或一組坦＋打
      const pool = r => byTs(members.filter(m => roleOf(m) === r));
      const legs = pool("大腿"), tanks = pool("坦"), dps = pool("打"), heals = pool("補"), bens = pool("便當");
      const maxCore = legs.length + Math.min(tanks.length, dps.length);
      count = Math.max(1, Math.min(count, Math.max(1, maxCore)));
      for (let i = 0; i < count; i++) groups.push([]);
      let gi = 0; const overflow = [];
      legs.forEach(l => { groups[gi % count].push(l); gi++; });
      for (let i = legs.length; i < count; i++) { groups[i].push(tanks.shift()); groups[i].push(dps.shift()); }
      const place = m => {
        let tries = 0;
        while (groups[gi % count].length >= MAX_PARTY && tries < count) { gi++; tries++; }
        if (tries >= count) overflow.push(m);
        else { groups[gi % count].push(m); gi++; }
      };
      byTs([...tanks, ...dps, ...heals]).forEach(place);
      bens.forEach(place);
      if (overflow.length) groups.push(overflow);
    } else {
      for (let i = 0; i < count; i++) groups.push([]);
      byTs(members).forEach((m, i) => groups[i % count].push(m));
    }
  } else groups.push(byTs(members));
  // 錨點：退出採軟刪除，退出者仍是錨點候選 → 編號創團後永不變動
  const founderOf = g => g.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.charId.localeCompare(b.charId))[0];
  const owns = groups.map(founderOf);
  let primaryIdx = 0;
  owns.forEach((f, i) => { const p0 = owns[primaryIdx];
    if ((f.ts || 0) < (p0.ts || 0) || ((f.ts || 0) === (p0.ts || 0) && f.charId.localeCompare(p0.charId) < 0)) primaryIdx = i; });
  const cands = (removedRegs || []).filter(r => toMin(r.start) <= ie && is <= toMin(r.end));
  return groups.map((g, gi) => {
    const id = act + "|" + toHM(is) + "|" + g.map(m => m.charId).sort().join(",");
    let anchor = owns[gi];
    if (gi === primaryIdx) {
      for (const c of cands) {
        if ((c.ts || 0) < (anchor.ts || 0) || ((c.ts || 0) === (anchor.ts || 0) && c.charId.localeCompare(anchor.charId) < 0)) anchor = c;
      }
    }
    const stable = act + "|" + anchor.charId + "|" + (anchor.ts || 0);
    // 兩階段出發時程：ready = max(時段起點, 成團時刻)；depart = ready + 依人數緩衝（不超過時段終點）
    const okNow = canForm(act, g);
    let readyMin = null, departMin = null, buffer = null;
    if (okNow) {
      const sorted = g.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.charId.localeCompare(b.charId));
      let formedTs = sorted[sorted.length - 1].ts || 0;
      for (let i = 0; i < sorted.length; i++) {
        if (canForm(act, sorted.slice(0, i + 1))) { formedTs = sorted[i].ts || 0; break; }
      }
      readyMin = Math.max(is, taipeiMinOfTs(formedTs));
      const readyMs = taipeiMs(dateStr, readyMin);
      const nReady = sorted.filter(m => (m.ts || 0) <= readyMs).length;
      buffer = bufferOf(nReady);
      departMin = Math.min(readyMin + buffer, Math.max(ie, readyMin), 1439);
    }
    return {
      id, activity: act, members: g, time: is, timeEnd: ie,
      ok: okNow, readyMin, departMin, buffer,
      leader: g[hashStr(id + "L") % g.length],
      num: String(hashStr(stable + "|" + dateStr + "|num") % 10000).padStart(4, "0"),
      chatKey: "c" + hashStr(stable + "|" + dateStr).toString(36) + hashStr(stable + "|chat").toString(36)
    };
  });
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
    const flush = () => { if (cluster.length) parties.push(...splitCluster(act, cluster, is, ie, dateStr, removedByAct[act] || [])); };
    for (const r of list) {
      const s = toMin(r.start), e = toMin(r.end);
      if (!cluster.length) { cluster = [r]; is = s; ie = e; continue; }
      if (s <= ie) { cluster.push(r); is = Math.max(is, s); ie = Math.min(ie, e); }
      else { flush(); cluster = [r]; is = s; ie = e; }
    }
    flush();
  }
  return parties;
}
