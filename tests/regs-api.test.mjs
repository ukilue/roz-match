// 登記 API 測試：用 Node 內建的 node:sqlite 執行 schema.sql，包成 D1 介面後直接呼叫 functions/api/regs.js
// 執行：node tests/regs-api.test.mjs   （需 Node 22 以上）
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL, fileURLToPath } from "node:url";
import { date, start } from "./_fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(fs.readFileSync(path.join(root, "schema.sql"), "utf8"));
// 伺服器存在與否以 broadcasts 為準：放兩個伺服器的廣播
const SRV = "測試服", SRV2 = "另一服";
sqlite.exec(`INSERT INTO broadcasts (id, ts, type, message, server) VALUES ('b1', 1, '喇叭', 'x', '${SRV}'), ('b2', 1, '喇叭', 'y', '${SRV2}')`);
// D1 介面的最小包裝
const DB = { prepare(sql) { let args = []; const st = () => sqlite.prepare(sql); return {
  bind(...a) { args = a.map(v => v === undefined ? null : (typeof v === "boolean" ? (v ? 1 : 0) : v)); return this; },
  async all() { return { results: st().all(...args) }; },
  async first() { return st().get(...args) ?? null; },
  async run() { st().run(...args); return { success: true }; },
}; } };
const env = { DB };
const { createSession } = await import(pathToFileURL(path.join(root, "functions/api/_auth.js")).href);
const { onRequestPost, onRequestGet } = await import(pathToFileURL(path.join(root, "functions/api/regs.js")).href);
const cookieOf = async (id, member = true) => "ro_sess=" + await createSession(env, { id, name: "測試" + id, member });
const post = async (cookie, body) => {
  const r = await onRequestPost({ env, request: new Request("https://x/api/regs", { method: "POST", headers: cookie ? { Cookie: cookie } : {}, body: JSON.stringify({ level: 115, job: "騎士", activity: "每日團", start, date, server: SRV, ...body }) }) });
  return { status: r.status, ...(await r.json()) };
};

const A = await cookieOf("userA"), B = await cookieOf("userB"), N = await cookieOf("userN", false);
// 未登入／非成員
assert.equal((await post(null, { charId: "x", skills: ["朱諾"] })).status, 401);
assert.equal((await post(N, { charId: "x", skills: ["朱諾"] })).status, 403);
// 開新單
const open = await post(A, { charId: "隊長", skills: ["朱諾", "研3"], leader: false });
assert.equal(open.status, 200); assert.match(open.party, /^[0-9a-f-]{36}$/, "開單會產生單號");
// 同時間再開一張 → 不同單號（不合併）
const open2 = await post(B, { charId: "另一隊長", skills: ["崑崙"] });
assert.equal(open2.status, 200); assert.notEqual(open2.party, open.party);
// 加入：只能勾隊長開放的項目
assert.equal((await post(B, { charId: "隊員1", skills: ["研3"], party: open.party })).status, 200);
const notOpen = await post(B, { charId: "隊員2", skills: ["崑崙"], party: open.party });
assert.equal(notOpen.status, 400); assert.match(notOpen.error, /沒有開/);
// 等級不足
const low = await post(B, { charId: "低等", level: 105, skills: ["研3"], party: open.party });
assert.equal(low.status, 400); assert.match(low.error, /等級不足/);
// 至少一項、不存在的單、同帳號同角色重複
assert.equal((await post(B, { charId: "隊員3", skills: [], party: open.party })).status, 400);
assert.equal((await post(B, { charId: "隊員3", skills: ["朱諾"], party: "00000000-0000-4000-8000-000000000000" })).status, 404);
assert.equal((await post(B, { charId: "隊員1", skills: ["朱諾"], party: open.party })).status, 400, "同帳號同角色不可重複加入同一張單");
// 自動加入：從登記表單送出（不帶單號），同伺服器同時間已有「開放項目包含所勾全部項目」的單 → 直接加入
const auto1 = await post(B, { charId: "自動甲", skills: ["朱諾"] });
assert.equal(auto1.status, 200); assert.equal(auto1.party, open.party, "勾的項目都在既有單內 → 自動加入"); assert.ok(auto1.joined, "回傳自動加入的單編號");
const mixed = await post(B, { charId: "自動乙", skills: ["朱諾", "崑崙"] });
assert.equal(mixed.status, 200); assert.ok(mixed.party !== open.party && mixed.party !== open2.party && !mixed.joined, "沒有一張單包含全部項目 → 開新單");
const forced = await post(B, { charId: "自動丙", skills: ["朱諾"], newParty: true });
assert.equal(forced.status, 200); assert.ok(forced.party !== open.party && !forced.joined, "勾「另開新單」→ 開新單");
const otherSrv = await post(B, { charId: "自動丁", skills: ["朱諾"], server: SRV2 });
assert.equal(otherSrv.status, 200); assert.ok(otherSrv.party !== open.party && !otherSrv.joined, "不同伺服器不自動加入");
// 多張符合（open：3 人；forced：1 人、只開朱諾）→ 加入人數最多的那張
const auto2 = await post(A, { charId: "自動戊", skills: ["朱諾"] });
assert.equal(auto2.party, open.party, "多張符合時加入人數最多的單");
// 副本團：同目標同時間自動併團，不帶單號
assert.equal((await post(A, { charId: "騎士甲", activity: "副本團：59~90級", skills: ["物理近傷"] })).status, 200);
assert.equal((await post(B, { charId: "騎士乙", activity: "副本團：59~90級", skills: ["物理近傷"] })).status, 200);
assert.equal((await post(B, { charId: "騎士丙", activity: "副本團：59~90級", skills: ["暴風雪"] })).status, 400, "職能需符合職業");
// 伺服器：必須選、必須存在；不能跨伺服器加入；不同伺服器同目標同時間不併團
assert.match((await post(A, { charId: "無服", skills: ["朱諾"], server: "" })).error, /選擇伺服器/, "開新揪團一定要選伺服器");
assert.match((await post(A, { charId: "怪服", skills: ["朱諾"], server: "不存在的服" })).error, /找不到這個伺服器/);
assert.match((await post(B, { charId: "跨服", skills: ["研3"], party: open.party, server: SRV2 })).error, /伺服器與揪團不符/);
assert.equal((await post(B, { charId: "騎士丁", activity: "副本團：59~90級", skills: ["物理近傷"], server: SRV2 })).status, 200);
// 驚駭森靈：115 級以上、不限職業、需勾職能
assert.match((await post(A, { charId: "森靈低", level: 114, activity: "副本團：115級驚駭森靈", skills: ["物理近傷"] })).error, /115/);
assert.equal((await post(A, { charId: "森靈甲", activity: "副本團：115級驚駭森靈", skills: [] })).status, 400, "驚駭森靈需勾職能");
assert.equal((await post(A, { charId: "森靈甲", activity: "副本團：115級驚駭森靈", skills: ["物理近傷"] })).status, 200);
assert.equal((await post(B, { charId: "森靈乙", job: "祭司", activity: "副本團：115級驚駭森靈", skills: ["純讚美"] })).status, 200, "不限職業");
// 分伺服器前的舊登記（server 空字串）：可照常加入（沿用空字串），但不能用空字串開新揪團
sqlite.prepare("INSERT INTO regs (uid, discordId, charId, level, job, activity, startHM, endHM, date, skills, party, server, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("old1", "userOld", "舊騎士", 100, "騎士", "副本團：59~90級", start, start, date, "物理近傷", "", "", 1);
assert.equal((await post(B, { charId: "加舊團", activity: "副本團：59~90級", skills: ["物理近傷"], server: "" })).status, 200, "舊登記的團可照常加入");
assert.match((await post(B, { charId: "開舊團", activity: "副本團：105級奧丁", job: "十字軍", skills: ["犧牲坦"], server: "" })).error, /選擇伺服器/);
// GET：不外洩 discordId／pwHash，帶 party 與 mine
const list = await (await onRequestGet({ env, request: new Request("https://x/api/regs?date=" + date, { headers: { Cookie: A } }) })).json();
assert.ok(list.length >= 4);
assert.ok(list.every(r => !("discordId" in r) && !("pwHash" in r)), "查詢不可回傳 discordId／pwHash");
assert.equal(list.find(r => r.charId === "隊長").mine, true);
assert.equal(list.find(r => r.charId === "隊員1").party, open.party);
assert.equal(list.filter(r => r.activity === "副本團：59~90級").every(r => r.party === ""), true);
assert.equal(list.find(r => r.charId === "騎士丁").server, SRV2);
// GET 帶伺服器：只回傳該伺服器＋舊登記
const s1 = await (await onRequestGet({ env, request: new Request("https://x/api/regs?date=" + date + "&server=" + encodeURIComponent(SRV), { headers: { Cookie: A } }) })).json();
assert.ok(s1.every(r => r.server === SRV || r.server === ""), "帶伺服器只回傳該伺服器＋舊登記");
assert.ok(s1.some(r => r.charId === "舊騎士") && !s1.some(r => r.charId === "騎士丁"));
console.log("✔ 登記 API 測試通過");
