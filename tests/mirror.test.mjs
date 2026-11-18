// 組團演算法三份鏡像一致性測試：functions/api/_party.js、cron-worker/worker.js、public/index.html
// 同一組登記丟進三份 buildParties，分團、隊長、編號、可選項目必須完全相同。
// 執行：node tests/mirror.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL, fileURLToPath } from "node:url";
import { makeRegs, date, summarize, P1, P2, S1, S2 } from "./_fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roparty-"));
const importSrc = async (name, src) => { const f = path.join(tmp, name); fs.writeFileSync(f, src); return import(pathToFileURL(f).href); };

// 1. 伺服器
const server = await importSrc("party.mjs", read("functions/api/_party.js"));
// 2. Worker（buildParties 沒有 export，測試時補上）
const worker = await importSrc("worker.mjs", read("cron-worker/worker.js") + "\nexport { buildParties as __buildParties };\n");
// 3. 前端：從最後一個 <script> 抽出「常數～登入狀態之前」與「組團演算法～畫面之前」兩段，用 vm 執行
const html = read("public/index.html");
const js = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
const cut = (a, b) => { const i = js.indexOf(a), j = js.indexOf(b, i); assert.ok(i >= 0 && j > i, `找不到前端區塊標記：${a} ～ ${b}`); return js.slice(i, j); };
const frontSrc = cut("const DUNGEONS", "/* ─── Discord 登入狀態") + "\n" + cut("/* ─── 組團演算法", "/* ─── 畫面") + "\n;globalThis.__buildParties = buildParties;";
const ctx = vm.createContext({ console, Intl, Date, Math, JSON, document: { getElementById: () => null }, localStorage: { getItem: () => null, setItem() {} } });
vm.runInContext(frontSrc, ctx);

const regs = makeRegs();
const norm = x => JSON.parse(JSON.stringify(x));
const a = summarize(server.buildParties(norm(regs), date));
const b = summarize(worker.__buildParties(norm(regs), date));
const c = summarize(norm(ctx.__buildParties(norm(regs), date)));
assert.deepEqual(b, a, "Worker 與伺服器的分團結果不同");
assert.deepEqual(c, a, "前端與伺服器的分團結果不同");

// 規則檢查
const byParty = id => a.find(p => p.party === id);
const p1 = byParty(P1), p2 = byParty(P2);
assert.equal(p1.n, 26); assert.equal(p1.squads.length, 3, "26 人應分 3 團");
assert.deepEqual(p1.opts, ["朱諾", "研3", "大蟲"], "可選項目＝開單者勾的項目");
assert.equal(p1.squads.find(s => s.m.includes("c01")).leader, "c01", "開單者固定是他那一團的隊長");
assert.ok(p1.squads.some(s => s.acting), "沒人願意的團由系統指派");
assert.ok(p1.squads.filter(s => !s.acting && s.leader !== "c01").every(s => ["c05", "c09"].includes(s.leader)), "其他團取勾願意的人");
assert.notEqual(p1.num, p2.num, "同時間的兩張每日團單不合併");
assert.equal(p2.squads[0].acting, true, "開單者退出且無人願意 → 系統指派");
assert.equal(a.find(p => p.act === "副本團：59~90級" && p.server === S1).squads[0].leader, "c50", "副本團第一位登記者是隊長");
assert.equal(a.find(p => p.act === "副本團：105級奧丁").squads[0].complete, true, "奧丁必要名額齊全應成團");
// 伺服器：同目標、同出發時間但不同伺服器 → 不併團；舊登記（無伺服器）自成一團
const dg59 = a.filter(p => p.act === "副本團：59~90級");
assert.equal(dg59.length, 2, "不同伺服器的副本團不可併團");
assert.equal(dg59.find(p => p.server === S1).n, 3); assert.equal(dg59.find(p => p.server === S2).n, 2);
assert.equal(dg59.find(p => p.server === S2).ok, false, "2 人未滿 3 人不成團");
assert.notEqual(dg59[0].num, dg59[1].num, "不同伺服器的揪團編號不同");
assert.equal(a.find(p => p.act === "每日團：100級").server, "", "舊登記沒有伺服器");
// 驚駭森靈：不限職業、全員一團、滿 3 人成團
const forest = a.find(p => p.act === "副本團：115級驚駭森靈");
assert.equal(forest.n, 14); assert.equal(forest.squads.length, 1, "驚駭森靈全員一團不分團"); assert.equal(forest.ok, true);
// 穩定性：同樣的輸入再算一次結果相同（隨機指派是固定的）
assert.deepEqual(summarize(server.buildParties(norm(regs), date)), a);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`✔ 三份鏡像一致（${a.length} 個揪團、${a.reduce((n, p) => n + p.squads.length, 0)} 個分團）`);
