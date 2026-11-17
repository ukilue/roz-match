// /api/regs — GET 查詢當日登記、POST 新增登記（需 Discord 登入＋公會伺服器成員）
// 所有遊戲規則在伺服器端再驗證一次，前端無法繞過；
// 登記會綁定 Discord 帳號，退團只有本人帳號可操作。同一角色可登記多個時段／目標（不檢查時段重疊）。
// 揪團分遊戲伺服器（regs.server）：只有同伺服器的登記會併成同一個揪團；server 空字串＝分伺服器前的舊登記，
// 舊登記在每個伺服器都看得到、可以照常加入（加入者沿用空字串），但不能再用空字串開新揪團。
import { getSession, needLogin, needMember } from "./_auth.js";
import { buildParties, addDays, isOdin, odinTeams, SKILLS, DAILY_TAGS, DAILY, dailyLevelOf } from "./_party.js";
import { findRoom, checkRoomPw, roomPwHash, ROOM_ID, PW } from "./_room.js";

const ACTS = [DAILY, "每日團：90級","每日團：100級","每日團：105級","每日團：110級","副本團：59~90級","副本團：105級奧丁","副本團：115級驚駭森靈"];
const JOBS = ["騎士","十字軍","巫師","賢者","鐵匠","鍊金","刺客","流氓","祭司","武僧","獵人","詩人","舞孃","忍者"];
const LEVEL_REQ = { [DAILY]:90, "每日團：90級":90, "每日團：100級":100, "每日團：105級":105, "每日團：110級":110, "副本團：59~90級":59, "副本團：105級奧丁":105, "副本團：115級驚駭森靈":115 };
const DUNGEONS = ["副本團：59~90級","副本團：105級奧丁","副本團：115級驚駭森靈"];
const isDungeon = a => DUNGEONS.includes(a);
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const CLOSE_BEFORE_MIN = 30;   // 出發前 30 分鐘內，各團已滿就不再開放報名
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const bad = (msg, status = 400) => json({ error: msg }, status);

// 以台灣時區判斷「今天」與現在時間；查詢絕不回傳 discordId（防對照身分）
function taipeiNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    min: Number(get("hour")) % 24 * 60 + Number(get("minute"))
  };
}
const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

export async function onRequestGet({ request, env }) {
  const params = new URL(request.url).searchParams;
  const date = params.get("date") || "";
  const server = String(params.get("server") || "").trim().slice(0, 40);
  if (!DATE.test(date)) return bad("date 格式錯誤");
  const user = await getSession(request, env);   // 有登入的話，標記哪些登記是本人的
  // 帶 server：只回傳該伺服器＋舊登記（server 空字串）；不帶：全部。揪團不會跨伺服器，篩選不影響各揪團的分團結果
  const stmt = env.DB
    .prepare(`SELECT uid, discordId, charId, level, job, activity, startHM AS start, endHM AS "end", date, skills, removed, removedTs, room, roomOpen, leader, lockKey, party, server, pwHash, ts
              FROM regs WHERE date = ?` + (server ? ` AND (server = ? OR server = '')` : ""));
  const { results } = await (server ? stmt.bind(date, server) : stmt.bind(date)).all();
  // acct：同一 Discord 帳號在同一天會拿到相同的匿名鍵（雜湊，每日不同、無法反推 discordId），
  // 讓前端的預期分團能把同帳號的角色放在同一團，與伺服器／Worker 的結果一致
  const hashStr = s => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
  const acctOf = id => "a" + hashStr(id + "|" + date + "|acct").toString(36) + hashStr(date + "|" + id).toString(36);
  // pwHash（私人房間密碼雜湊）與 discordId 一樣絕不回傳；room 只是不透明的房間 ID，前端用它分堆與呼叫驗證 API
  return json(results.map(({ discordId, pwHash, ...r }) =>
    ({ ...r, skills: String(r.skills || "").split(",").filter(Boolean), removed: !!r.removed, room: r.room || "", roomOpen: !!r.roomOpen, leader: !!r.leader, lockKey: r.lockKey || "", party: r.party || "", server: r.server || "", acct: acctOf(discordId), mine: !!(user && discordId === user.id) })));
}

export async function onRequestPost({ request, env }) {
  const user = await getSession(request, env);
  if (!user) return needLogin();
  if (!user.member) return needMember();

  let b;
  try { b = await request.json(); } catch { return bad("JSON 格式錯誤"); }

  const charId = String(b.charId || "").trim().slice(0, 24);
  const level = Number(b.level);
  const job = String(b.job || "").trim().slice(0, 20);
  const activity = String(b.activity || "");
  const start = String(b.start || "");   // 出發時間（HH:MM，30 分為單位）
  const end = start;                      // 已改為單一出發時間；endHM 欄位保留、與 startHM 相同
  const date = String(b.date || "");
  const joinRoom = String(b.room || "");      // 加入既有私人房間：房間 ID（需附密碼 pw，除非本帳號已是房內成員）
  const priv = !!b.priv;                      // 建立新的私人房間（需附 4 位數密碼 pw）
  const pw = String(b.pw || "");
  const leader = b.leader ? 1 : 0;            // 願意當隊長（預設不願意，必須明確勾選）
  const joinParty = String(b.party || "");    // 新制每日團：加入既有的單（單號）；空字串＝開新單
  const server = String(b.server || "").trim().slice(0, 40);   // 遊戲伺服器；空字串只能用來加入分伺服器前的舊登記（下方檢查）
  if (joinParty && !ROOM_ID.test(joinParty)) return bad("揪團參數錯誤");
  if (joinRoom && !ROOM_ID.test(joinRoom)) return bad("房間參數錯誤");
  if (!joinRoom && priv && !PW.test(pw)) return bad("私人房間密碼須為 4 位數字");
  if (!charId || !job) return bad("資料不完整");
  if (!ACTS.includes(activity)) return bad("目標不存在");
  if (!JOBS.includes(job)) return bad("職業選項錯誤");
  // 副本團：依職業從固定清單多選職能，至少一項；每日團：個人「想打的細項」（多選、至少一項；加入既有揪團時預設勾該團全部細項）；兩者都存在 skills 欄位
  let skills = [];
  if (isDungeon(activity)) {
    const allowed = SKILLS[job] || [];
    skills = [...new Set((Array.isArray(b.skills) ? b.skills : []).map(String))];
    if (!skills.length) return bad("副本團需至少勾選一項職能");
    if (skills.some(s => !allowed.includes(s))) return bad("職能選項與職業不符");
  } else if (DAILY_TAGS[activity]) {
    skills = [...new Set((Array.isArray(b.skills) ? b.skills : []).map(String))];
    if (!skills.length) return bad("每日團需至少勾選一項想打的細項");
    if (skills.some(s => !DAILY_TAGS[activity].includes(s))) return bad("細項選項不正確");
  }
  if (!Number.isInteger(level) || level < 1 || level > 120) return bad("角色等級須為 1～120");
  // 新制每日團：角色等級要達到每個所勾細項所屬大項的等級（例：勾了研3 需 110 級）
  if (activity === DAILY) {
    const tooHigh = skills.filter(k => level < dailyLevelOf(k));
    if (tooHigh.length) return bad(`等級不足：「${tooHigh.join("、")}」需 ${Math.max(...tooHigh.map(dailyLevelOf))} 級以上`);
  }
  const needLv = LEVEL_REQ[activity];
  if (needLv && level < needLv) return bad(`此活動需 ${needLv} 級以上`);
  if (!HM.test(start)) return bad("出發時間格式錯誤");
  if (!DATE.test(date)) return bad("日期格式錯誤");

  const tw = taipeiNow();
  const tomorrow = addDays(tw.date, 1);
  if (date !== tw.date && date !== tomorrow) return bad("只能登記今天或明天的揪團");
  const isToday = date === tw.date;
  if (isToday && toMin(start) < tw.min) return bad("這個出發時間已經過了，請選擇之後的時間");
  // 伺服器必須真的存在（broadcasts 內有該伺服器的資料，與關鍵字通知、角色綁定相同的判斷）
  if (server) {
    const exists = await env.DB.prepare("SELECT 1 AS ok FROM broadcasts WHERE server = ? LIMIT 1").bind(server).first();
    if (!exists) return bad("找不到這個伺服器");
  }

  // 以當日全部登記重算分團（下方「私人房間」「重複登記」「奧丁名額」檢查共用）
  const { results: all } = await env.DB
    .prepare(`SELECT uid, discordId, charId, level, job, activity, startHM AS start, endHM AS "end", date, skills, removed, removedTs, room, roomOpen, leader, lockKey, party, server, ts
              FROM regs WHERE date = ?`)
    .bind(date).all();
  const rows = all.map(r => ({ ...r, skills: String(r.skills || "").split(",").filter(Boolean), removed: !!r.removed, room: r.room || "", roomOpen: !!r.roomOpen, leader: !!r.leader, lockKey: r.lockKey || "", party: r.party || "", server: r.server || "" }));
  const parties = buildParties(rows, date);

  // ── 私人房間 ──
  //   加入既有房間：房間必須存在且與這筆登記同一天；本帳號若已是房內成員（用其他角色再加入）免密碼，否則必須通過密碼驗證
  //   建立新房間：產生房間 ID，密碼只以 SHA-256(房間ID:密碼) 雜湊保存
  let room = "", pwHash = "", roomOpen = 0;
  if (joinRoom) {
    const roomRow = await findRoom(env, joinRoom);
    if (!roomRow || roomRow.date !== date) return bad("找不到這個私人房間", 404);
    if (roomRow.activity !== activity) return bad("目標與私人房間不符");
    if ((roomRow.server || "") !== server) return bad("伺服器與私人房間不符，請先在左側切換到該房間的伺服器");
    const already = all.some(r => r.room === joinRoom && !r.removed && r.discordId === user.id);
    // 房主已「開放」的房間不需密碼（roomOpen 房間內每筆登記同步更新）
    const isOpen = !!roomRow.roomOpen;
    if (!already && !isOpen) { const err = await checkRoomPw(env, user.id, joinRoom, roomRow.pwHash, pw); if (err) return err; }
    room = joinRoom; pwHash = roomRow.pwHash; roomOpen = isOpen ? 1 : 0;
  } else if (priv) {
    room = crypto.randomUUID();
    pwHash = await roomPwHash(room, pw);
  }

  // ── 新制每日團的單號 ──
  //   開新單：產生單號，這位登記者就是開單者（隊長），他勾的細項＝這張單的可選項目
  //   加入既有的單：單必須存在且同一天、同出發時間、同房間；細項只能從開單者的可選項目裡勾
  let party = "";
  if (activity === DAILY) {
    if (joinParty) {
      const target = parties.find(p => p.party === joinParty && p.activity === DAILY);
      if (!target) return bad("找不到這個揪團，可能已被取消", 404);
      if ((target.server || "") !== server) return bad("伺服器與揪團不符，請先在左側切換到該揪團的伺服器");
      if (toMin(start) !== target.time) return bad("出發時間與揪團不符");
      if ((target.room || "") !== room) return bad("房間與揪團不符");
      const notIn = skills.filter(k => !target.opts.includes(k));
      if (notIn.length) return bad(`這個揪團沒有開「${notIn.join("、")}」，請從隊長開的項目中勾選`);
      party = joinParty;
    } else {
      if (joinRoom) return bad("加入私人房間的每日團需指定揪團");
      party = crypto.randomUUID();
    }
  } else if (joinParty) return bad("揪團參數錯誤");

  // 這筆登記會落入的揪團（同伺服器、同目標、同房間、同單號、同出發時間）
  const sameParty = p => p.activity === activity && (p.server || "") === server && (p.room || "") === room && (p.party || "") === party && p.time === toMin(start);
  // 沒有伺服器（空字串）只能加入分伺服器前就存在的舊登記揪團；開新揪團一定要選伺服器
  if (!server && !parties.some(sameParty)) return bad("請先在左側選擇伺服器");

  // 同一個 Discord 帳號可以登記多個角色 ID；同一角色 ID 也可登記多個出發時間／目標。
  // 僅擋「同一角色重複登記到同一個揪團」（同伺服器、同目標、同房間、同出發時間）。
  const dup = parties.find(p => sameParty(p) && p.members.some(m => m.charId === charId && m.discordId === user.id));
  if (dup) return bad(`角色「${charId}」已在 ${start} 出發的「${activity}」揪團 #${dup.num} 內，不需重複登記`);

  const uid = crypto.randomUUID();
  const newReg = { uid, discordId: user.id, charId, level, job, activity, start, end, date, skills, removed: false, room, roomOpen: !!roomOpen, leader: !!leader, lockKey: "", party, server, ts: Date.now() };

  // 出發前 30 分鐘內「各團已滿」就不再開放報名：若這筆登記會讓既有揪團多開一團（24→25 人變 3 團、
  // 奧丁要另開新團或進候補、未鎖定的團都滿 12 人），就擋下，避免最後一刻多出一個人數不足的團
  if (isToday && toMin(start) - tw.min <= CLOSE_BEFORE_MIN) {
    const before = parties.find(sameParty);
    if (before) {
      const after = buildParties([...rows, newReg], date).find(p => p.members.some(m => m.uid === uid));
      const grew = after && (after.squads.length > before.squads.length || after.waitlist.some(m => m.uid === uid));
      if (grew) return bad(`揪團 #${before.num} 出發前 ${CLOSE_BEFORE_MIN} 分鐘內各團已滿，不再開放報名（再加入會多開一團、導致戰力不足）`);
    }
  }

  // 105 級奧丁：名額檢查——把這筆登記放進會併入的揪團重算分團，若落到候補（各團「其他」名額已滿、且本身不是必要職能）就擋下
  if (isOdin(activity)) {
    const after = buildParties([...rows, newReg], date).find(p => p.members.some(m => m.uid === uid));
    if (after && after.waitlist.some(m => m.uid === uid)) {
      return bad(`揪團 #${after.num} 的非必要職能名額已滿（每團最多 6 名）。需有必要職能（犧牲坦、地領、護貝、祭司或指定打手）的成員加入開出下一團後才能再加入`);
    }
  }

  await env.DB
    .prepare(`INSERT INTO regs (uid, discordId, charId, level, job, activity, startHM, endHM, date, skills, room, pwHash, roomOpen, leader, lockKey, party, server, ts)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(uid, user.id, charId, level, job, activity, start, end, date, skills.join(","), room, pwHash, roomOpen, leader, "", party, server, newReg.ts)
    .run();
  return json({ uid, room, party, server });
}
