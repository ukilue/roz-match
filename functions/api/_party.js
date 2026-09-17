// functions/api/_party.js — 伺服器端組團演算法（留言板權限驗證用）
// 與前端 public/index.html 及 cron-worker.js 的演算法「完全一致」。
// ⚠ 若修改組團規則，三處必須同步修改。

const DUNGEONS = ["副本團：59~90級", "副本團：105級奧丁"];
const SQUAD_SIZE = 12, MIN_PARTY = 3;   // 每日團預期分團 12 人一團、滿 3 人成團（報名不設上限）
export const isDungeon = act => DUNGEONS.includes(act);
const maxOf = act => SQUAD_SIZE;   // 每個預期分團的人數上限（保留函式形式，日後若要分目標設定只改這裡）
export const ODIN = "副本團：105級奧丁";
export const isOdin = act => act === ODIN;
// 各職業可勾選的職能（登記副本團時至少勾一項，可多選；前端表單、regs.js 驗證、明細顯示、機器人私訊共用）
export const SKILLS = {
  "騎士": ["物理近傷"], "十字軍": ["犧牲坦", "加農砲", "聖十字審判"], "巫師": ["暴風雪", "怒雷強擊", "隕石術"],
  "賢者": ["地領", "魔力拳"], "鐵匠": ["物理近傷"], "鍊金": ["護貝", "強酸火煙瓶投擲"], "刺客": ["音速投擲", "心靈震波"],
  "流氓": ["背刺", "魅影唸咒(弓)"], "祭司": ["純讚美", "二道聖光", "十字驅魔"], "武僧": ["阿修羅霸皇拳", "金剛不壞"],
  "獵人": ["銳利射擊", "鳥獵普攻"], "詩人": ["奧義箭亂舞", "不萊奇"], "舞孃": ["奧義箭亂舞", "女神之吻", "為你服務"], "忍者": ["法忍", "投擲風魔飛鏢"]
};
export const skillsOf = m => Array.isArray(m.skills) ? m.skills : String(m.skills || "").split(",").filter(Boolean);
// 105 級奧丁名額（每團相同，一團 12 人＝必要名額 6 ＋ 其他最多 6）：
//   犧牲坦 1、地領 1、護貝 1、祭司（任一職能）1、打手 2（下列打手職能任一，不限阿修羅）
//   打手戰力：阿修羅霸皇拳 3 ＞ 心靈震波 2 ＞ 其餘打手職能 1；團數 ≥ 2 時把所有團的打手（含報了打手職能、佔「其他」名額的人）
//   重新分配，先讓每團湊滿 2 名打手（第 1 團優先），再讓各團總戰力平均（不偏袒第 1 團）
const ODIN_DPS = ["阿修羅霸皇拳", "銳利射擊", "奧義箭亂舞", "投擲風魔飛鏢", "心靈震波", "強酸火煙瓶投擲"];
const ODIN_POWER = { "阿修羅霸皇拳": 3, "心靈震波": 2 };
const dpsPower = m => skillsOf(m).reduce((p, s) => Math.max(p, ODIN_DPS.includes(s) ? (ODIN_POWER[s] || 1) : 0), 0);
const isDps = m => dpsPower(m) > 0;
const ODIN_SLOTS = [   // 依序嘗試填入：先必要職能、再打手、最後「其他」
  { key: "tank",   label: "犧牲坦", n: 1, fits: m => m.job === "十字軍" && skillsOf(m).includes("犧牲坦") },
  { key: "land",   label: "地領",   n: 1, fits: m => m.job === "賢者" && skillsOf(m).includes("地領") },
  { key: "coat",   label: "護貝",   n: 1, fits: m => m.job === "鍊金" && skillsOf(m).includes("護貝") },
  { key: "priest", label: "祭司",   n: 1, fits: m => m.job === "祭司" },
  { key: "dps",    label: "打手",   n: 2, fits: isDps },
  { key: "other",  label: "其他",   n: 6, fits: () => true }
];
const ODIN_NEED_DPS = 2, ODIN_OTHER_MAX = 6;
// 奧丁分團 odinTeams(members, readyMs)：
//   1. 依登記順序把成員填入各團名額（先找已有的團，都放不下時：能填新團必要名額的人另開新團、其他人進候補；第一位登記者一律開第 1 團）
//   2. 團數 ≥ 2 時做「打手重新分配」：把各團佔打手／其他名額、且在「請準備」前登記（ts < readyMs）的打手全部集中，
//      (a) 依第 1 團→第 2 團… 的順序先補滿每團 2 名打手（原則上以第 1 團能成團為主），
//      (b) 剩下的依戰力高→低發給目前總戰力最低的團（受每團 12 人／其他 ≤ 6 名額限制），
//      (c) 再做兩兩交換，只要能讓各團戰力更平均就換 → 各團戰力平均，不偏袒第 1 團。readyMs 未給時全員可移動
//   3. 「請準備」後才登記的人（ts ≥ readyMs）在分配之後才填入，不會動到已通知的名單
//   結果只跟登記資料有關，各端一致。每團：members / slot（uid → 名額標籤）/ complete / missing / power
export function odinTeams(members, readyMs) {
  const byTs = arr => arr.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || cmpStr(a.charId, b.charId));
  const keyOf = m => m.uid || m.charId;
  const teams = [], waitlist = [];
  // 依名額順序為一團的成員貼標籤，並更新 used / missing / complete / power
  const fill = t => {
    t.used = {}; t.slot = {}; ODIN_SLOTS.forEach(s => { t.used[s.key] = 0; });
    for (const m of byTs(t.members)) {
      const s = ODIN_SLOTS.find(x => t.used[x.key] < x.n && x.fits(m));
      if (s) { t.used[s.key]++; t.slot[keyOf(m)] = s.label; } else { t.used.other++; t.slot[keyOf(m)] = "其他"; }
    }
    t.missing = ODIN_SLOTS.filter(s => s.key !== "other" && t.used[s.key] < s.n).map(s => s.label + (s.n - t.used[s.key] > 1 ? "×" + (s.n - t.used[s.key]) : ""));
    t.complete = t.missing.length === 0;
    t.power = t.members.reduce((p, m) => p + dpsPower(m), 0);
    return t;
  };
  const canTake = (t, m, essentialOnly) => ODIN_SLOTS.some(s => (!essentialOnly || s.key !== "other") && t.used[s.key] < s.n && s.fits(m));
  const place = m => {
    const t = teams.find(x => canTake(x, m, false));
    if (t) { t.members.push(m); fill(t); return; }
    const first = !teams.length, nt = { index: teams.length + 1, members: [] };
    fill(nt);
    if (first || canTake(nt, m, true)) { teams.push(nt); nt.members.push(m); fill(nt); }
    else waitlist.push(m);
  };
  const late = [];
  for (const m of byTs(members)) { if (readyMs && (m.ts || 0) >= readyMs) late.push(m); else place(m); }
  // ── 打手重新分配（團數 ≥ 2）──
  if (teams.length >= 2) {
    const pool = [];
    for (const t of teams) {
      const mv = t.members.filter(m => isDps(m) && (t.slot[keyOf(m)] === "打手" || t.slot[keyOf(m)] === "其他"));
      pool.push(...mv);
      t.members = t.members.filter(m => !mv.includes(m));
      fill(t);
      t.got = [];                                                                  // 本輪分配到的打手
      t.cap = ODIN_NEED_DPS + (ODIN_OTHER_MAX - t.used.other);                     // 還能收的打手數（打手 2 ＋ 剩餘其他名額）
    }
    pool.sort((a, b) => dpsPower(b) - dpsPower(a) || (a.ts || 0) - (b.ts || 0) || cmpStr(a.charId, b.charId));
    const powerOf = t => t.power + t.got.reduce((p, m) => p + dpsPower(m), 0);
    const give = (t, m) => { t.got.push(m); t.cap--; };
    // (a) 依戰力高→低、第 1 團→第 2 團… 先補滿每團 2 名打手（原則上以第 1 團能成團為主；之後 (c) 的交換會再拉平戰力）
    for (const t of teams) { while (t.got.length < ODIN_NEED_DPS && pool.length && t.cap > 0) give(t, pool.shift()); }
    // (b) 其餘依戰力高→低發給總戰力最低、還有名額的團（同戰力 → 名額多者 → 序號大者，避免固定偏向第 1 團）
    for (const m of pool) {
      const cand = teams.filter(t => t.cap > 0).sort((x, y) => powerOf(x) - powerOf(y) || y.cap - x.cap || y.index - x.index);
      if (cand.length) give(cand[0], m); else waitlist.push(m);
    }
    // (c) 兩兩交換直到各團戰力離平均的平方和不再下降
    const score = () => { const ps = teams.map(powerOf), avg = ps.reduce((a, b) => a + b, 0) / ps.length; return ps.reduce((s, p) => s + (p - avg) * (p - avg), 0); };
    let improved = true, guard = 0;
    while (improved && guard++ < 200) {
      improved = false;
      for (let i = 0; i < teams.length && !improved; i++) for (let j = i + 1; j < teams.length && !improved; j++) {
        const A = teams[i].got, B = teams[j].got;
        for (let x = 0; x < A.length && !improved; x++) for (let y = 0; y < B.length && !improved; y++) {
          if (dpsPower(A[x]) === dpsPower(B[y])) continue;
          const before = score(); [A[x], B[y]] = [B[y], A[x]];
          if (score() < before - 1e-9) improved = true; else [A[x], B[y]] = [B[y], A[x]];
        }
      }
    }
    teams.forEach(t => { t.members.push(...t.got); delete t.got; delete t.cap; fill(t); });
  }
  late.forEach(place);
  teams.forEach(t => { t.members = byTs(t.members); fill(t); });
  return { teams: teams.map(t => ({ members: t.members, slot: t.slot, complete: t.complete, missing: t.missing, power: t.power })), waitlist };
}
// 成團條件：奧丁→第 1 團必要名額全滿；每日團、59~90 級副本→滿 3 人
const canForm = (act, ms) => {
  if (isOdin(act)) { const t = odinTeams(ms).teams; return t.length > 0 && t[0].complete; }
  return ms.length >= MIN_PARTY;
};
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
// 字串比較一律用 UTF-16 code unit 順序（cmpStr），不用 localeCompare：
// localeCompare 依執行環境的預設語系排序（玩家瀏覽器 zh-TW、Cloudflare Worker en-US、伺服器可能不同），
// 中文職業名／角色 ID 的排序結果會不一樣，導致網頁與機器人算出不同的分團。
const cmpStr = (a, b) => { a = String(a); b = String(b); return a < b ? -1 : a > b ? 1 : 0; };
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
  const sorted = g.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || cmpStr(a.charId, b.charId));
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

// ── 一個「揪團」＝同目標、同房間、時段有交集的整群人：共用一個編號、一個留言板、一份出發時程 ──
// 群內另外算出「預期分團」squads，只用於明細顯示、機器人私訊與開語音房，加人時可動態變動，不影響揪團本身：
//   每日團 → 12 人一團，同一 Discord 帳號的角色優先同團，再依職業平均
//   副本團：59~90級 → 不分團、不控制職能，全員一團
//   副本團：105級奧丁 → 依職能名額分團（見 odinTeams），未成團的團（必要名額未滿）不會收到通知
// 每團另有 complete（是否成團）與 missing（奧丁缺少的必要名額）；waitlist＝奧丁名額不足而候補的人（伺服器登記時即擋下，正常不會出現）
function buildSquads(act, members, is, ie, dateStr) {
  const byTs = arr => arr.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || cmpStr(a.charId, b.charId));
  const leaderOf = g => byTs(g)[0];   // 每個預期分團的隊長＝該團最早登記者（補人只會往後加，隊長不會因此變動）
  if (isOdin(act)) {
    // 「請準備」時刻之後登記的人不參與戰力平均分配（與已發出的通知一致）
    const whole = scheduleOf(act, members, is, ie, dateStr);
    const { teams, waitlist } = odinTeams(members, whole ? taipeiMs(dateStr, whole.readyMin) : undefined);
    return { squads: teams.map((t, i) => ({ index: i + 1, members: t.members, leader: leaderOf(t.members), complete: t.complete, missing: t.missing, slot: t.slot, power: t.power })), waitlist };
  }
  if (isDungeon(act)) {
    return { squads: [{ index: 1, members: byTs(members), leader: leaderOf(members), complete: members.length >= MIN_PARTY, missing: [], slot: {} }], waitlist: [] };
  }
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
    const max = maxOf(act);
    // 單位順序：角色多的帳號先放；接著職業人數多→少、職業名、登記順序
    const jobFreq = {};
    core.forEach(m => { jobFreq[m.job] = (jobFreq[m.job] || 0) + 1; });
    const units = unitsOf(core).sort((a, b) =>
      b.length - a.length ||
      (jobFreq[b[0].job] || 0) - (jobFreq[a[0].job] || 0) || cmpStr(a[0].job, b[0].job) ||
      (a[0].ts || 0) - (b[0].ts || 0) || cmpStr(a[0].charId, b[0].charId));
    // 分數：同帳號成員所在的團最優先 → 同職業少（職業平均）→ 人數少 → 組序
    const score = (g, unit, i) =>
      (hasMate(g, unit) ? 0 : 1) * 1e6 +
      unit.reduce((s, m) => s + jobCount(g, m.job), 0) * 1000 +
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
  return { squads: groups.filter(g => g.length).map((g, i) => ({ index: i + 1, members: g, leader: leaderOf(g), complete: true, missing: [], slot: {} })), waitlist: [] };
}

function splitCluster(act, members, is, ie, dateStr, removedRegs, room) {
  const byTs = arr => arr.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || cmpStr(a.charId, b.charId));
  const sorted = byTs(members);
  room = room || "";
  const rk = room ? "|room:" + room : "";   // 私人房間鍵（公開登記為空字串 → 既有公開揪團的 id／編號完全不受影響）
  const id = act + rk + "|" + toHM(is) + "|" + sorted.map(m => m.charId).sort().join(",");
  // 錨點：整群最早登記者（退出採軟刪除，退出者仍是錨點候選）→ 編號、留言板 key 創團後永不變動
  let anchor = sorted[0];
  for (const c of (removedRegs || []).filter(r => toMin(r.start) <= ie && is <= toMin(r.end))) {
    if ((c.ts || 0) < (anchor.ts || 0) || ((c.ts || 0) === (anchor.ts || 0) && cmpStr(c.charId, anchor.charId) < 0)) anchor = c;
  }
  const stable = act + rk + "|" + anchor.charId + "|" + (anchor.ts || 0);
  const sch = scheduleOf(act, members, is, ie, dateStr);
  const { squads, waitlist } = buildSquads(act, members, is, ie, dateStr);
  return {
    id, activity: act, room, priv: !!room, open: !!room && members.some(m => m.roomOpen), host: anchor, members: sorted, time: is, timeEnd: ie,
    ok: !!sch, readyMin: sch ? sch.readyMin : null, departMin: sch ? sch.departMin : null, buffer: sch ? sch.buffer : null,
    squads, waitlist, leader: squads[0].leader,
    num: String(hashStr(stable + "|" + dateStr + "|num") % 10000).padStart(4, "0"),
    chatKey: "c" + hashStr(stable + "|" + dateStr).toString(36) + hashStr(stable + "|chat").toString(36)
  };
}

export function buildParties(regs, dateStr) {
  const todays = regs.filter(r => r.date === dateStr);
  // 分堆鍵＝目標＋房間：私人房間（room 非空）自成一堆，同時段的公開登記絕不會被併入私人房間（只能從所有揪團輸入密碼加入）
  const keyOf = r => r.activity + "\u0001" + (r.room || "");
  const byKey = {};
  todays.filter(r => !r.removed).forEach(r => { (byKey[keyOf(r)] ||= []).push(r); });
  const removedByKey = {};
  todays.filter(r => r.removed).forEach(r => { (removedByKey[keyOf(r)] ||= []).push(r); });
  const parties = [];
  for (const key in byKey) {
    const act = byKey[key][0].activity, room = byKey[key][0].room || "";
    const list = byKey[key].slice().sort((a, b) => toMin(a.start) - toMin(b.start) || cmpStr(a.charId, b.charId));
    let cluster = [], is = 0, ie = 0;
    const flush = () => { if (cluster.length) parties.push(splitCluster(act, cluster, is, ie, dateStr, removedByKey[key] || [], room)); };
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
