import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dir = process.env.LUMI_DATA_DIR || join(process.cwd(), "data");
const file = join(dir, "food.json");
const empty = () => ({ shops: [], branches: [], meals: [], dishes: [], logs: [], taste: [], here: { city: "", spot: "", today: today() } });
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: process.env.TZ || "Asia/Shanghai" });
const id = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);
const norm = (s) => String(s || "").trim().toLocaleLowerCase();
async function load() { await mkdir(dir, { recursive: true }); try { return { ...empty(), ...JSON.parse(await readFile(file, "utf8")) }; } catch { return empty(); } }
async function save(d) { d.here.today = today(); await writeFile(file, JSON.stringify(d, null, 2)); return d; }
const verdict = (v) => ({ good: "good", meh: "meh", bad: "bad", 好吃: "good", 一般: "meh", 踩雷: "bad", "爱吃": "good", "不爱吃": "bad" }[v] || v || "");
function book(d) { return { ...d, here: { ...d.here, today: today() } }; }

export async function getFoodBook() { return book(await load()); }

export async function mutateFood(path, input = {}) {
  const d = await load(); const now = new Date().toISOString();
  if (path === "/api/settings") { d.here.city = String(input.city || "").trim(); d.here.spot = String(input.spot || "").trim(); await save(d); return { ok: true }; }
  if (path === "/api/food/log") {
    const shopData = typeof input.shop === "object" && input.shop ? input.shop : { name: input.shop };
    const branchData = typeof input.branch === "object" && input.branch ? input.branch : { label: input.branch || "" };
    const shopName = String(shopData.name || "").trim(); const meal = input.meal || {}; const dishes = Array.isArray(input.dishes) ? input.dishes : [];
    let shop = null, branch = null;
    if (shopName) {
      shop = d.shops.find(x => norm(x.name) === norm(shopName));
      if (!shop) { shop = { id: id(), name: shopName, cuisine: shopData.cuisine || "", note: "", verdict: "", created_at: now, updated_at: now }; d.shops.push(shop); }
      const city = String(branchData.city || meal.city || d.here.city || "").trim();
      branch = d.branches.find(x => x.shop_id === shop.id && norm(x.city) === norm(city) && norm(x.area) === norm(branchData.area) && norm(x.label) === norm(branchData.label));
      if (!branch) { branch = { id: id(), shop_id: shop.id, city, area: branchData.area || "", label: branchData.label || "", address: branchData.address || "", platform: branchData.platform || "", note: "" }; d.branches.push(branch); }
    }
    if (!shopName && !dishes.length && !meal.note && !meal.photo) throw new Error("至少记下店名、菜名或备注");
    const m = { id: id(), branch_id: branch?.id || null, eaten_on: meal.date || meal.eaten_on || today(), slot: meal.slot || "", place: meal.place || "", city: meal.city || branchData.city || d.here.city || "", photo: meal.photo || "", src: meal.src || "app", how: meal.how || "", total: Number(meal.total) || null, currency: meal.currency || "CNY", verdict: verdict(meal.verdict), note: meal.note || "", created_at: now };
    d.meals.push(m);
    for (const item of dishes) addDishLog(d, m, shop, item);
    if (branch?.city) d.here.city = branch.city;
    await save(d); return { ok: true, meal_id: m.id };
  }
  if (path === "/api/food/addlog") {
    const m = d.meals.find(x => x.id == input.meal_id); if (!m) throw new Error("没找到这顿记录");
    const shop = d.shops.find(x => x.id === d.branches.find(b => b.id === m.branch_id)?.shop_id); addDishLog(d, m, shop, input.dish || {}); await save(d); return { ok: true };
  }
  if (path === "/api/food/taste") {
    const items = input.items || [input.item];
    let moved = false;
    for (const raw of items) { const item = String(raw || "").trim(); if (!item) continue;
      const kind = ({ love: "love", hate: "hate", never: "never", "爱吃": "love", "不爱吃": "hate", "不能吃": "never", "拿掉": "remove" })[input.kind] || input.kind;
      const old = d.taste.find(t => norm(t.item) === norm(item) && (t.scope || "") === (input.scope || ""));
      if (kind === "remove" || input.remove) { if (old) d.taste = d.taste.filter(t => t !== old); continue; }
      if (old && old.kind !== kind) moved = true;
      const row = { id: old?.id || id(), item, kind, scope: input.scope || "", note: input.note || "", away: input.away || "", src: input.src || "app", updated_at: now };
      if (old) Object.assign(old, row); else d.taste.push(row);
    }
    await save(d); return { ok: true, moved, text: moved ? "口味偏好更新好了。" : "口味记好了。" };
  }
  if (path === "/api/food/edit") {
    const maps = { shop: d.shops, branch: d.branches, meal: d.meals, dish: d.dishes, log: d.logs, taste: d.taste };
    const row = (maps[input.kind] || []).find(x => x.id == input.id); if (!row) throw new Error("记录不存在");
    const allowed = { shop: ["name","cuisine","note","verdict"], branch: ["city","area","label","address","platform","note"], meal: ["eaten_on","slot","place","city","photo","how","total","currency","verdict","note"], dish: ["name","note"], log: ["name","verdict","price","note"], taste: ["item","kind","note","away","scope"] }[input.kind] || [];
    for (const key of allowed) if (key in (input.fields || {})) row[key] = key === "verdict" ? verdict(input.fields[key]) : input.fields[key];
    row.updated_at = now; await save(d); return { ok: true };
  }
  if (path === "/api/food/del") {
    const id0 = input.id; const kind = input.kind;
    if (kind === "shop") { const branchIds = d.branches.filter(x => x.shop_id == id0).map(x => x.id), mealIds = d.meals.filter(x => branchIds.includes(x.branch_id)).map(x => x.id), dishIds = d.dishes.filter(x => x.shop_id == id0).map(x => x.id); d.shops = d.shops.filter(x => x.id != id0); d.branches = d.branches.filter(x => x.shop_id != id0); d.meals = d.meals.filter(x => !mealIds.includes(x.id)); d.dishes = d.dishes.filter(x => x.shop_id != id0); d.logs = d.logs.filter(x => !mealIds.includes(x.meal_id) && !dishIds.includes(x.dish_id)); }
    else if (kind === "branch") { const meals = d.meals.filter(x => x.branch_id == id0).map(x => x.id); d.branches = d.branches.filter(x => x.id != id0); d.meals = d.meals.filter(x => x.branch_id != id0); d.logs = d.logs.filter(x => !meals.includes(x.meal_id)); }
    else if (kind === "meal") { d.meals = d.meals.filter(x => x.id != id0); d.logs = d.logs.filter(x => x.meal_id != id0); }
    else if (kind === "dish") { d.dishes = d.dishes.filter(x => x.id != id0); d.logs = d.logs.filter(x => x.dish_id != id0); }
    else if (kind === "taste") d.taste = d.taste.filter(x => x.id != id0);
    else if (kind === "log") d.logs = d.logs.filter(x => x.id != id0);
    await save(d); return { ok: true };
  }
  if (path === "/api/food/dice") return roll(d, input);
  if (path === "/api/upload") { const data = String(input.dataURL || ""); if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(data) || data.length > 8_000_000) throw new Error("图片格式不支持或太大"); return { ok: true, url: data }; }
  throw new Error("不支持的饮食操作");
}

function addDishLog(d, meal, shop, item) { const name = String(item.name || "").trim(); if (!name) return; let dish = shop && d.dishes.find(x => x.shop_id === shop.id && norm(x.name) === norm(name)); if (shop && !dish) { dish = { id: id(), shop_id: shop.id, name, note: "" }; d.dishes.push(dish); } d.logs.push({ id: id(), meal_id: meal.id, dish_id: dish?.id || null, name, verdict: verdict(item.verdict), price: Number(item.price) || null, note: item.note || "" }); }

async function roll(d, input) {
  const tastes = d.taste || [];
  const hated = tastes.filter(x => ["hate", "never"].includes(x.kind)).map(x => norm(x.item));
  const loved = tastes.filter(x => x.kind === "love").map(x => norm(x.item));
  let menu = [];
  try {
    menu = (await readFile(join(process.cwd(), "public/food/dishes.txt"), "utf8"))
      .split(/\r?\n/).filter(x => x && !x.startsWith("#"))
      .map(line => { const [name, cuisine, dish_kind, ingredients = ""] = line.split("|"); return { name, cuisine, dish_kind, ingredients: ingredients.split(","), menu: true }; });
  } catch {}
  const custom = d.dishes.map(x => ({ ...x, cuisine: d.shops.find(s => s.id === x.shop_id)?.cuisine || "家常", ingredients: [], menu: false }));
  const source = [...custom, ...menu];
  const safe = x => !hated.some(h => norm(x.name).includes(h) || x.ingredients.some(i => norm(i) === h));
  const cuisineList = [...new Set(source.filter(safe).map(x => x.cuisine).filter(Boolean))];
  if (input.mode === "way") {
    if (!cuisineList.length) return { ok: true, mode: "way", empty: true, cuisine: "", examples: [], cuisines: 0, removed: source.length, notes: [] };
    const cuisine = cuisineList[Math.floor(Math.random() * cuisineList.length)];
    const examples = source.filter(x => x.cuisine === cuisine && safe(x)).slice(0, 3).map(x => x.name);
    return { ok: true, mode: "way", empty: false, cuisine, examples, cuisines: cuisineList.length, removed: Math.max(0, source.length - source.filter(safe).length), notes: [] };
  }
  let candidates = source.filter(x => safe(x) && (!input.want || norm(x.name).includes(norm(input.want))) && (!input.only || x.cuisine === input.only) && (!input.kind || x.dish_kind === input.kind));
  const byDish = new Map();
  for (const l of d.logs) { const key = norm(l.name); const arr = byDish.get(key) || []; arr.push(l); byDish.set(key, arr); }
  candidates = candidates.map(x => ({ ...x, score: loved.some(t => norm(x.name).includes(t) || x.ingredients.some(i => norm(i) === t)) ? 3 : 0, logs: byDish.get(norm(x.name)) || [] })).sort((a, b) => b.score - a.score);
  if (!candidates.length) return { ok: true, mode: "dish", empty: true, text: "照你的口味没有合适的菜，试试放宽筛选或调整忌口。", item: null, name: "", cuisine: "", count: 0, removed: source.length, notes: [] };
  const selected = candidates[Math.floor(Math.random() * Math.min(candidates.length, 8))];
  const shop = d.shops.find(x => x.id === selected.shop_id);
  const notes = selected.ingredients.filter(i => hated.some(h => norm(i) === h)).map(i => `忌口提醒：这道菜可能含${i}`);
  return { ok: true, mode: "dish", empty: false, item: { name: selected.name, shop: shop?.name || "", verdict: selected.logs.at(-1)?.verdict || "", note: selected.logs.at(-1)?.note || "" }, name: selected.name, cuisine: selected.cuisine || shop?.cuisine || "家常", dish_kind: selected.dish_kind || "", count: candidates.length, removed: Math.max(0, source.length - candidates.length), only: input.only || "", notes, text: `${shop ? `${shop.name} · ` : ""}${selected.name}` };
}

export const foodTools = [
  { type:"function", function:{ name:"food_note", description:"把用户刚吃的东西记录到饮食本。只有用户明确说吃过/正在吃时使用；不要编造没提到的店、菜、价格或评价。", parameters:{ type:"object", properties:{ shop:{type:"string"}, cuisine:{type:"string"}, city:{type:"string"}, area:{type:"string"}, branch:{type:"string"}, platform:{type:"string"}, how:{type:"string",enum:["外卖","堂食","自取","自制"]}, place:{type:"string"}, slot:{type:"string",enum:["早饭","午饭","晚饭","夜宵","纯记录"]}, date:{type:"string"}, verdict:{type:"string",enum:["good","meh","bad"]}, total:{type:"number"}, currency:{type:"string"}, note:{type:"string"}, dishes:{type:"array",items:{type:"object",properties:{name:{type:"string"},verdict:{type:"string",enum:["good","meh","bad"]},price:{type:"number"},note:{type:"string"}},required:["name"]}}} } } },
  { type:"function", function:{ name:"food_taste", description:"记住或更新用户明确表达的饮食口味、过敏、忌口。", parameters:{type:"object",properties:{item:{type:"string"},items:{type:"array",items:{type:"string"}},kind:{type:"string",enum:["love","hate","never","remove"]},note:{type:"string"},scope:{type:"string"},away:{type:"string"}},required:["kind"]} } },
  { type:"function", function:{ name:"food_book", description:"查询饮食本中的近期记录、常吃的菜、踩雷记录或店铺。", parameters:{type:"object",properties:{view:{type:"string",enum:["recent","often","bad","shop"]},city:{type:"string"},q:{type:"string"},days:{type:"integer"}}} } },
  { type:"function", function:{ name:"food_dice", description:"用户问吃什么时，从饮食本里推荐一道菜或菜系方向，并考虑爱吃、忌口和历史评价。", parameters:{type:"object",properties:{mode:{type:"string",enum:["dish","way"]},kind:{type:"string",enum:["饭","面粉","菜","汤粥","小吃","锅"]},want:{type:"string"}}} } },
  { type:"function", function:{ name:"food_rate", description:"用户明确评价以前吃过的菜时，更新最近匹配的那条评价。", parameters:{type:"object",properties:{dish:{type:"string"},verdict:{type:"string",enum:["good","meh","bad"]},note:{type:"string"},shop:{type:"string"},date:{type:"string"}},required:["dish","verdict"]} } },
  { type:"function", function:{ name:"food_page", description:"用户要打开饮食本、查看饮食记录或记一笔时，提供饮食本页面。", parameters:{type:"object",properties:{}}} }
];

export async function foodContext() { const d = await load(); const taste = d.taste.map(x => `${x.kind}: ${x.item}${x.note ? `（${x.note}）` : ""}`).join("\n"); const meals = [...d.meals].sort((a,b) => b.eaten_on.localeCompare(a.eaten_on)).slice(0,20).map(m => { const logs = d.logs.filter(x => x.meal_id === m.id).map(x => `${x.name}${x.verdict ? `(${x.verdict})` : ""}`).join("、"); const b = d.branches.find(x => x.id === m.branch_id), s = d.shops.find(x => x.id === b?.shop_id); return `${m.eaten_on} ${m.slot || ""} ${s?.name || m.place || ""}: ${logs || m.note || "记录"}`; }).join("\n"); return `当前城市：${d.here.city || "未设置"}\n口味偏好：\n${taste || "暂无"}\n近期饮食：\n${meals || "暂无记录"}`; }

export async function executeFoodTool(name, args = {}) {
  if (name === "food_note") { await mutateFood("/api/food/log", { shop: args.shop, meal: { ...args, date: args.date, src: "chat" }, dishes: args.dishes || [] }); return "已记入饮食本。"; }
  if (name === "food_taste") return (await mutateFood("/api/food/taste", { ...args, src: "chat" })).text;
  if (name === "food_book") {
    const d = await load(), view = args.view || "recent", q = norm(args.q), city = norm(args.city);
    const mealName = meal => { const b=d.branches.find(x=>x.id===meal.branch_id), s=d.shops.find(x=>x.id===b?.shop_id); return s?.name || meal.place || "自制"; };
    if (view === "shop") return d.shops.filter(s => (!q || norm(s.name).includes(q) || norm(s.cuisine).includes(q)) && (!city || d.branches.some(b=>b.shop_id===s.id && norm(b.city)===city))).map(s=>`${s.name}（${s.cuisine || "菜系未记"}）${s.verdict ? ` · ${s.verdict}` : ""}`).join("\n") || "没有找到这家店。";
    if (view === "bad") { const lines=d.logs.filter(x=>x.verdict==="bad" && (!q || norm(x.name).includes(q))).map(x=>`${x.name}：踩雷`); d.meals.filter(m=>m.verdict==="bad" && (!q || norm(mealName(m)).includes(q))).forEach(m=>lines.push(`${mealName(m)}（${m.eaten_on}）：这一顿踩雷`)); return lines.slice(-30).join("\n") || "还没有踩雷记录。"; }
    if (view === "often") { const counts={}; d.logs.filter(x=>!q || norm(x.name).includes(q)).forEach(x=>counts[x.name]=(counts[x.name]||0)+1); return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([n,c])=>`${n}：${c}次`).join("\n") || "还没有菜品记录。"; }
    const days=Math.max(1,Math.min(3650,Number(args.days)||30)), after=new Date(Date.now()-days*86400000).toLocaleDateString("sv-SE",{timeZone:"Asia/Shanghai"});
    return d.meals.filter(m=>m.eaten_on>=after && (!city || norm(m.city)===city) && (!q || norm(mealName(m)).includes(q) || d.logs.some(x=>x.meal_id===m.id && norm(x.name).includes(q)))).sort((a,b)=>b.eaten_on.localeCompare(a.eaten_on)).slice(0,30).map(m=>`${m.eaten_on} ${m.slot || ""} ${mealName(m)}：${d.logs.filter(x=>x.meal_id===m.id).map(x=>`${x.name}${x.verdict ? `（${x.verdict}）` : ""}`).join("、") || m.note || "记录"}`).join("\n") || "这段时间还没有饮食记录。";
  }
  if (name === "food_dice") { const result = await mutateFood("/api/food/dice", args); return result.text || (result.mode === "way" ? `推荐${result.cuisine}，可以考虑${result.examples.join("、")}` : result.empty ? result.text : `推荐${result.name}（${result.cuisine}）`); }
  if (name === "food_rate") { const d = await load(); const target = norm(args.dish); const logs = d.logs.filter(x => norm(x.name).includes(target) || target.includes(norm(x.name))).sort((a,b)=>{ const ma=d.meals.find(x=>x.id===a.meal_id), mb=d.meals.find(x=>x.id===b.meal_id); return (mb?.eaten_on||"").localeCompare(ma?.eaten_on||""); }); if (!logs.length) return "没找到这道菜的旧记录；告诉我店名或直接重新记一笔吧。"; await mutateFood("/api/food/edit", {kind:"log",id:logs[0].id,fields:{verdict:args.verdict,note:args.note || logs[0].note}}); return `已把最近一次${args.dish}评价更新为${args.verdict}。`; }
  if (name === "food_page") return "饮食本已集成在 Lumi 首页。打开「吃了么」即可使用，也可以访问 https://lumi-tokyo-api.zeabur.app/v1/food/index.html。";
  throw new Error("未知的饮食工具");
}
