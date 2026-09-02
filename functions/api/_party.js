// functions/api/_party.js — 伺服器端組團演算法（留言板權限驗證用）
// 與前端 public/index.html 及 cron-worker.js 的演算法「完全一致」。
// ⚠ 若修改組團規則，三處必須同步修改。

const DUNGEONS = ["副本4困1普", "副本3困2普"];
const MAX_PARTY = 12, MIN_PARTY = 3, MIN_FIGHTERS = 5;
const isDungeon = act => DUNGEONS.includes(act);
const fighterCount = ms => ms.filter(m => !m.bento).length;
const canForm = (act, ms) => isDungeon(act) ? fighterCount(ms) >= MIN_FIGHTERS : ms.length >= MIN_PARTY;
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
      count = Math.max(1, Math.min(count, Math.floor(fighterCount(members) / MIN_FIGHTERS)));
      for (let i = 0; i < count; i++) groups.push([]);
      const fighters = byTs(members.filter(m => !m.bento)), bentos = byTs(members.filter(m => m.bento));
      fighters.forEach((m, i) => groups[i % count].push(m));
      let gi = 0; const overflow = [];
      for (const b of bentos) {
        let tries = 0;
        while (groups[gi % count].length >= MAX_PARTY && tries < count) { gi++; tries++; }
        if (tries >= count) overflow.push(b);
        else { groups[gi % count].push(b); gi++; }
      }
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
    return {
      id, activity: act, members: g, time: is, timeEnd: ie,
      ok: canForm(act, g),
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
