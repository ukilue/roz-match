// functions/api/_party.js — 伺服器端組團演算法（留言板權限驗證用）
// 與前端 public/index.html 及 cron-worker.js 的演算法「完全一致」。
// ⚠ 若修改組團規則，三處必須同步修改。

const DUNGEONS = ["90級↑副本4困1普", "90級↑副本3困2普", "80級↑副本3困1普"];
const MAX_PARTY = 12, MIN_PARTY = 3;
const isDungeon = act => DUNGEONS.includes(act);
const ROLES = ["大腿", "坦", "補", "打", "便當"];
const roleOf = m => m.role || (m.bento ? "便當" : "打");
const roleCount = (ms, r) => ms.filter(m => roleOf(m) === r).length;
// 副本→有「大腿」直接成團；沒大腿則需「坦」「打」各 1；每日→滿 3 人
// 緩衝分鐘數：一律 10 分鐘（成團「請準備」通知後 10 分鐘出發）
const BUFFER_MIN = 10;
const bufferOf = () => BUFFER_MIN;
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

// 成團後的兩階段時程（成團的團才有；未成團回傳 null）：
//   readyMin  = max(時段起點, 成團時刻)＝發「請準備」通知的時刻；成團時刻由成員登記時間戳依序推算
//   departMin = readyMin + 10 分鐘緩衝（壓縮不超過時段終點）＝關團、開語音、發「出發」通知
function scheduleOf(act, g, is, ie, dateStr) {
  if (!canForm(act, g)) return null;
  const sorted = g.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.charId.localeCompare(b.charId));
  let formedTs = sorted[sorted.length - 1].ts || 0;
  for (let i = 0; i < sorted.length; i++) {
    if (canForm(act, sorted.slice(0, i + 1))) { formedTs = sorted[i].ts || 0; break; }
  }
  const readyMin = Math.max(is, taipeiMinOfTs(formedTs));
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
    const sch = scheduleOf(act, g, is, ie, dateStr);
    const okNow = !!sch;
    const readyMin = sch ? sch.readyMin : null, departMin = sch ? sch.departMin : null, buffer = sch ? sch.buffer : null;
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
      if (s <= ie && canJoinCluster(act, cluster, is, ie, dateStr, r)) { cluster.push(r); is = Math.max(is, s); ie = Math.min(ie, e); }
      else { flush(); cluster = [r]; is = s; ie = e; }
    }
    flush();
  }
  return parties;
}
