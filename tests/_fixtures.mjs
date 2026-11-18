// 測試共用：產生一組涵蓋各種情境的假登記（今天、出發時間在 40 分鐘後）
const tw = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
const g = t => tw.find(x => x.type === t).value;
export const date = `${g("year")}-${g("month")}-${g("day")}`;
const nowMin = Number(g("hour")) % 24 * 60 + Number(g("minute"));
const hm = m => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
export const start = hm(Math.min(23 * 60 + 59, nowMin + 40));
export const P1 = "11111111-1111-4111-8111-111111111111", P2 = "22222222-2222-4222-8222-222222222222";
const jobs = ["騎士", "巫師", "祭司", "獵人", "賢者"];
export const S1 = "測試服一", S2 = "測試服二";
const base = (i, x) => ({ uid: "u" + i, discordId: "d" + i, acct: "a" + i, charId: "c" + String(i).padStart(2, "0"), level: 115, job: jobs[i % 5], activity: "每日團", start, end: start, date, skills: ["朱諾"], removed: false, removedTs: 0, room: "", roomOpen: false, leader: false, lockKey: "", party: P1, server: S1, ts: 1000 + i, ...x });
export function makeRegs() {
  const regs = [];
  // 單 P1：c01 開單（朱諾＋研3＋大蟲），26 人 → 3 團；c05、c09 願意當隊長
  regs.push(base(1, { skills: ["朱諾", "研3", "大蟲"] }));
  for (let i = 2; i <= 26; i++) regs.push(base(i, { skills: i % 3 === 0 ? ["研3"] : i % 3 === 1 ? ["朱諾", "研3"] : ["朱諾"], leader: i === 5 || i === 9 }));
  // 單 P2：同時間另一張單（不合併）；開單者 c30 已退出、沒人願意當隊長 → 系統指派
  regs.push(base(30, { party: P2, skills: ["崑崙", "天津"], removed: true, removedTs: 2000 }));
  for (let i = 31; i <= 34; i++) regs.push(base(i, { party: P2, skills: ["崑崙"] }));
  // 舊制每日團（無單號，同目標同時間自動併團）；分伺服器前的舊登記（server 空字串）
  for (let i = 40; i <= 43; i++) regs.push(base(i, { activity: "每日團：100級", party: "", leader: true, server: "" }));
  // 副本 59~90：測試服一 3 人；測試服二同目標同時間 2 人 → 不同伺服器不併團
  for (let i = 50; i <= 52; i++) regs.push(base(i, { activity: "副本團：59~90級", party: "", skills: ["物理近傷"], job: "騎士", leader: i === 52 }));
  for (let i = 55; i <= 56; i++) regs.push(base(i, { activity: "副本團：59~90級", party: "", skills: ["物理近傷"], job: "騎士", server: S2 }));
  // 副本 115 驚駭森靈：14 人、不限職業 → 全員一團
  for (let i = 70; i <= 83; i++) regs.push(base(i, { activity: "副本團：115級驚駭森靈", party: "", skills: [], job: jobs[i % 5] }));
  // 奧丁：一團必要名額齊全＋多的打手
  const odin = (i, job, skills) => base(i, { activity: "副本團：105級奧丁", party: "", job, skills });
  [[60, "十字軍", ["犧牲坦"]], [61, "賢者", ["地領"]], [62, "鍊金", ["護貝"]], [63, "祭司", ["純讚美"]], [64, "武僧", ["阿修羅霸皇拳"]], [65, "獵人", ["銳利射擊"]], [66, "刺客", ["心靈震波"]]]
    .forEach(([i, j, s]) => regs.push(odin(i, j, s)));
  return regs;
}
export const summarize = parties => parties.map(p => ({
  act: p.activity, server: p.server, num: p.num, party: p.party, n: p.members.length, ok: p.ok, opts: p.opts, tags: p.tags,
  squads: p.squads.map(s => ({ i: s.index, m: s.members.map(m => m.charId).sort().join(","), leader: s.leader.charId, acting: !!s.acting, complete: !!s.complete })),
})).sort((a, b) => a.num.localeCompare(b.num) || a.act.localeCompare(b.act) || a.server.localeCompare(b.server));
