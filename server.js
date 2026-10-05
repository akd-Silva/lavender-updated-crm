const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const db = new sqlite3.Database(path.join(__dirname, "lavender.db"));

app.use(cors());
app.use(bodyParser.json({ limit: "3mb" }));
app.use(express.static(path.join(__dirname, "public")));

const run = (sql, p = []) => new Promise((resolve, reject) => db.run(sql, p, function (err) {
  if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes });
}));
const get = (sql, p = []) => new Promise((resolve, reject) => db.get(sql, p, (err, row) => err ? reject(err) : resolve(row)));
const all = (sql, p = []) => new Promise((resolve, reject) => db.all(sql, p, (err, rows) => err ? reject(err) : resolve(rows)));

const allowedStatuses = ["pending", "processing", "completed", "cancelled", "refunded", "failed", "on-hold"];

function cleanCustomer(b = {}) {
  return {
    first_name: String(b.first_name || "").trim(),
    last_name: String(b.last_name || "").trim(),
    email: String(b.email || "").trim().toLowerCase(),
    phone: String(b.phone || "").trim(),
    city: String(b.city || "").trim(),
    country: String(b.country || "IN").trim().toUpperCase()
  };
}
function scoreCustomer(c) {
  const spend = Number(c.total_spend || 0);
  const orders = Number(c.order_count || 0);
  const days = c.last_purchase ? Math.max(0, (Date.now() - new Date(c.last_purchase).getTime()) / 86400000) : 9999;
  let score = Math.min(100, spend / 100 + orders * 6);
  if (days <= 30) score += 10;
  else if (days > 180) score -= 20;
  score = Math.max(0, Math.round(score));
  let tier = score >= 80 ? "Diamond" : score >= 55 ? "Gold" : score >= 30 ? "Silver" : "Bronze";
  let segment = orders === 0 ? "New" : orders === 1 ? "One-Time" : days > 180 ? "Inactive" : days > 90 ? "At-Risk" : spend >= 10000 || orders >= 5 ? "VIP" : "Repeat Buyer";
  return { score, tier, segment, daysSincePurchase: Math.round(days) };
}
function csvEscape(v) { return `"${String(v ?? "").replace(/"/g, '""')}"`; }
async function recalc(id) {
  const s = await get(`SELECT COALESCE(SUM(total),0) spend, COUNT(*) cnt, MAX(created_at) last_purchase FROM orders WHERE customer_id=? AND status NOT IN ('cancelled','refunded')`, [id]);
  await run("UPDATE customers SET total_spend=?,order_count=?,last_purchase=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", [s.spend, s.cnt, s.last_purchase, id]);
}
async function activity(action, entityType, entityId, message) {
  await run("INSERT INTO activity_logs(action,entity_type,entity_id,message) VALUES(?,?,?,?)", [action, entityType, entityId || null, message]);
}

async function init() {
  await run("PRAGMA foreign_keys = ON");
  await run(`CREATE TABLE IF NOT EXISTS customers(
    id INTEGER PRIMARY KEY AUTOINCREMENT, woo_customer_id INTEGER,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    phone TEXT, city TEXT, country TEXT, total_spend REAL DEFAULT 0,
    order_count INTEGER DEFAULT 0, last_purchase TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS orders(
    id INTEGER PRIMARY KEY AUTOINCREMENT, woo_order_id INTEGER UNIQUE,
    customer_id INTEGER NOT NULL, order_number TEXT, status TEXT DEFAULT 'pending',
    total REAL DEFAULT 0, currency TEXT DEFAULT 'INR', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    raw_json TEXT, FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS webhook_logs(
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, woo_order_id INTEGER,
    status TEXT, message TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS customer_notes(
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, note TEXT NOT NULL,
    author TEXT DEFAULT 'Admin', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE)`);
  await run(`CREATE TABLE IF NOT EXISTS activity_logs(
    id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, entity_type TEXT, entity_id INTEGER,
    message TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS order_items(
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, product_id INTEGER,
    product_name TEXT, sku TEXT, quantity INTEGER DEFAULT 1, total REAL DEFAULT 0,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE)`);
  // Safe migrations for databases created by older Lavender versions.
  const cols = await all("PRAGMA table_info(customers)");
  if (!cols.some(c => c.name === "last_purchase")) await run("ALTER TABLE customers ADD COLUMN last_purchase TEXT");
}

app.get("/api/health", (req, res) => res.json({ ok: true, service: "Lavender CRM" }));

app.get("/api/dashboard", async (req, res) => {
  try {
    const c = await get("SELECT COUNT(*) n FROM customers");
    const o = await get("SELECT COUNT(*) n FROM orders");
    const r = await get("SELECT COALESCE(SUM(total),0) n FROM orders WHERE status NOT IN ('cancelled','refunded')");
    const a = await get("SELECT COALESCE(AVG(total_spend),0) n FROM customers");
    const recent = await all(`SELECT o.*,c.first_name,c.last_name,c.email FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC LIMIT 8`);
    const byStatus = await all("SELECT status,COUNT(*) count,COALESCE(SUM(total),0) revenue FROM orders GROUP BY status ORDER BY count DESC");
    res.json({ stats: { customers: c.n, orders: o.n, revenue: r.n, avgCustomer: a.n }, recent, byStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/customers", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const rows = await all(`SELECT * FROM customers WHERE first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ? OR city LIKE ? ORDER BY updated_at DESC`, [`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`]);
    res.json(rows.map(c => ({ ...c, ...scoreCustomer(c) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/customers/:id", async (req, res) => {
  try {
    const c = await get("SELECT * FROM customers WHERE id=?", [req.params.id]);
    if (!c) return res.status(404).json({ error: "Customer not found" });
    c.orders = await all("SELECT * FROM orders WHERE customer_id=? ORDER BY created_at DESC", [req.params.id]);
    c.notes = await all("SELECT * FROM customer_notes WHERE customer_id=? ORDER BY created_at DESC", [req.params.id]);
    c.activities = await all("SELECT * FROM activity_logs WHERE entity_type='customer' AND entity_id=? ORDER BY created_at DESC LIMIT 100", [req.params.id]);
    c.products = await all(`SELECT oi.product_name, SUM(oi.quantity) quantity, SUM(oi.total) spend FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.customer_id=? GROUP BY oi.product_name ORDER BY quantity DESC LIMIT 8`, [req.params.id]);
    Object.assign(c, scoreCustomer(c));
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/customers", async (req, res) => {
  try {
    const c = cleanCustomer(req.body);
    if (!c.first_name || !c.last_name || !c.email) return res.status(400).json({ error: "First name, last name and email are required" });
    const r = await run(`INSERT INTO customers(first_name,last_name,email,phone,city,country) VALUES(?,?,?,?,?,?)`, [c.first_name,c.last_name,c.email,c.phone,c.city,c.country]);
    await activity("created", "customer", r.id, `Admin created customer ${c.first_name} ${c.last_name}`);
    res.status(201).json(await get("SELECT * FROM customers WHERE id=?", [r.id]));
  } catch (e) { res.status(400).json({ error: e.message.includes("UNIQUE") ? "Email already exists" : e.message }); }
});
app.put("/api/customers/:id", async (req, res) => {
  try {
    const c = cleanCustomer(req.body);
    if (!c.first_name || !c.last_name || !c.email) return res.status(400).json({ error: "First name, last name and email are required" });
    await run(`UPDATE customers SET first_name=?,last_name=?,email=?,phone=?,city=?,country=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`, [c.first_name,c.last_name,c.email,c.phone,c.city,c.country,req.params.id]);
    const out = await get("SELECT * FROM customers WHERE id=?", [req.params.id]);
    if (!out) return res.status(404).json({ error: "Customer not found" });
    await activity("updated", "customer", req.params.id, `Admin updated customer ${c.first_name} ${c.last_name}`);
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message.includes("UNIQUE") ? "Email already exists" : e.message }); }
});
app.delete("/api/customers/:id", async (req, res) => {
  try { const c=await get("SELECT first_name,last_name FROM customers WHERE id=?",[req.params.id]); if(!c)return res.status(404).json({error:"Customer not found"}); await run("DELETE FROM customers WHERE id=?",[req.params.id]); await activity("deleted","customer",req.params.id,`Admin deleted customer ${c.first_name} ${c.last_name}`); res.json({ok:true}); }
  catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/customers/:id/notes", async (req,res)=>{ try{res.json(await all("SELECT * FROM customer_notes WHERE customer_id=? ORDER BY created_at DESC",[req.params.id]));}catch(e){res.status(500).json({error:e.message});} });
app.post("/api/customers/:id/notes", async (req,res)=>{ try{const note=String(req.body.note||"").trim(); const author=String(req.body.author||"Admin").trim()||"Admin"; if(!note)return res.status(400).json({error:"Note cannot be empty"}); const r=await run("INSERT INTO customer_notes(customer_id,note,author) VALUES(?,?,?)",[req.params.id,note,author]); await activity("note_added","customer",req.params.id,`${author} added a customer note`); res.status(201).json(await get("SELECT * FROM customer_notes WHERE id=?",[r.id]));}catch(e){res.status(400).json({error:e.message});} });

app.get("/api/orders", async (req,res)=>{
  try{
    const status=String(req.query.status||""); const q=String(req.query.q||"").trim();
    let sql=`SELECT o.*,c.first_name,c.last_name,c.email FROM orders o JOIN customers c ON c.id=o.customer_id WHERE 1=1`; const p=[];
    if(status){sql+=" AND o.status=?";p.push(status);} if(q){sql+=" AND (o.order_number LIKE ? OR o.woo_order_id LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ?)";p.push(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`);} sql+=" ORDER BY o.created_at DESC";
    res.json(await all(sql,p));
  }catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/orders/:id", async(req,res)=>{try{const order=await get(`SELECT o.*,c.first_name,c.last_name,c.email,c.phone,c.city,c.country,c.total_spend,c.order_count FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?`,[req.params.id]);if(!order)return res.status(404).json({error:"Order not found"});order.items=await all("SELECT * FROM order_items WHERE order_id=? ORDER BY id",[order.id]);if(order.raw_json){try{order.raw_payload=JSON.parse(order.raw_json)}catch{order.raw_payload=null}}res.json(order);}catch(e){res.status(500).json({error:e.message});}});
async function saveItems(orderId, items=[]){await run("DELETE FROM order_items WHERE order_id=?",[orderId]);for(const item of Array.isArray(items)?items:[]){await run("INSERT INTO order_items(order_id,product_id,product_name,sku,quantity,total) VALUES(?,?,?,?,?,?)",[orderId,item.product_id||null,String(item.name||item.product_name||"Product"),String(item.sku||""),Number(item.quantity||1),Number(item.total||((Number(item.price)||0)*Number(item.quantity||1)))]);}}
app.post("/api/orders", async(req,res)=>{try{const b=req.body;const c=await get("SELECT id FROM customers WHERE id=?",[b.customer_id]);if(!c)return res.status(400).json({error:"Customer not found"});const status=allowedStatuses.includes(String(b.status))?String(b.status):"pending";const r=await run(`INSERT INTO orders(woo_order_id,customer_id,order_number,status,total,currency,created_at,raw_json) VALUES(?,?,?,?,?,?,?,?)`,[b.woo_order_id||null,c.id,b.order_number||"",status,Number(b.total||0),b.currency||"INR",b.created_at||new Date().toISOString(),b.raw_json||null]);await saveItems(r.id,b.items);await recalc(c.id);await activity("created","order",r.id,`Admin created order #${b.order_number||r.id}`);res.status(201).json(await get("SELECT * FROM orders WHERE id=?",[r.id]));}catch(e){res.status(400).json({error:e.message});}});
app.put("/api/orders/:id", async(req,res)=>{try{const old=await get("SELECT * FROM orders WHERE id=?",[req.params.id]);if(!old)return res.status(404).json({error:"Order not found"});const b=req.body;const customerId=Number(b.customer_id||old.customer_id);const status=allowedStatuses.includes(String(b.status||old.status))?String(b.status||old.status):old.status;await run(`UPDATE orders SET order_number=?,status=?,total=?,currency=?,customer_id=? WHERE id=?`,[b.order_number??old.order_number,status,Number(b.total??old.total),b.currency??old.currency,customerId,req.params.id]);if(Array.isArray(b.items))await saveItems(req.params.id,b.items);await recalc(old.customer_id);if(customerId!==old.customer_id)await recalc(customerId);await activity("updated","order",req.params.id,`Admin updated order #${b.order_number||old.order_number||req.params.id} status to ${status}`);res.json(await get("SELECT * FROM orders WHERE id=?",[req.params.id]));}catch(e){res.status(400).json({error:e.message});}});
app.delete("/api/orders/:id", async(req,res)=>{try{const o=await get("SELECT * FROM orders WHERE id=?",[req.params.id]);if(!o)return res.status(404).json({error:"Order not found"});await run("DELETE FROM orders WHERE id=?",[req.params.id]);await recalc(o.customer_id);await activity("deleted","order",req.params.id,`Admin deleted order #${o.order_number||o.id}`);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

app.get("/api/segments", async(req,res)=>{try{const rows=await all("SELECT * FROM customers ORDER BY total_spend DESC");const groups={"VIP":[],"Repeat Buyer":[],"One-Time":[],"At-Risk":[],"Inactive":[],"New":[]};rows.forEach(c=>groups[scoreCustomer(c).segment]?.push({...c,...scoreCustomer(c)}));res.json(groups);}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/products", async(req,res)=>{try{res.json(await all("SELECT product_name,COALESCE(SUM(quantity),0) quantity,COALESCE(SUM(total),0) revenue,COUNT(DISTINCT order_id) orders FROM order_items GROUP BY product_name ORDER BY quantity DESC LIMIT 30"));}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/activity", async(req,res)=>{try{res.json(await all("SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 150"));}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/webhooks", async(req,res)=>{try{res.json(await all("SELECT * FROM webhook_logs ORDER BY created_at DESC LIMIT 100"));}catch(e){res.status(500).json({error:e.message});}});

app.get("/api/export/customers", async(req,res)=>{try{const rows=await all("SELECT * FROM customers ORDER BY total_spend DESC");const lines=[["Name","Email","Phone","City","Country","Orders","Total Spend","Segment","Tier","Score","Last Purchase"],...rows.map(c=>{const s=scoreCustomer(c);return [`${c.first_name} ${c.last_name}`,c.email,c.phone,c.city,c.country,c.order_count,c.total_spend,s.segment,s.tier,s.score,c.last_purchase]})].map(r=>r.map(csvEscape).join(","));res.setHeader("Content-Type","text/csv");res.setHeader("Content-Disposition","attachment; filename=lavender-customers.csv");res.send(lines.join("\n"));}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/export/orders", async(req,res)=>{try{const rows=await all(`SELECT o.*,c.first_name,c.last_name,c.email FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC`);const lines=[["Order","Customer","Email","Status","Total","Currency","Created"],...rows.map(o=>[o.order_number||o.woo_order_id||o.id,`${o.first_name} ${o.last_name}`,o.email,o.status,o.total,o.currency,o.created_at])].map(r=>r.map(csvEscape).join(","));res.setHeader("Content-Type","text/csv");res.setHeader("Content-Disposition","attachment; filename=lavender-orders.csv");res.send(lines.join("\n"));}catch(e){res.status(500).json({error:e.message});}});

app.post("/api/webhook/woocommerce", async(req,res)=>{
  const payload=req.body||{}; const event=req.get("x-wc-webhook-topic")||"order";
  try{
    const b=payload.billing||{};const email=String(b.email||"").trim().toLowerCase();if(!email)throw new Error("Webhook order has no billing email");
    let c=await get("SELECT * FROM customers WHERE email=?",[email]);const data=cleanCustomer({first_name:b.first_name,last_name:b.last_name,email,phone:b.phone,city:b.city,country:b.country});
    if(!c){const r=await run(`INSERT INTO customers(woo_customer_id,first_name,last_name,email,phone,city,country) VALUES(?,?,?,?,?,?,?)`,[payload.customer_id||null,data.first_name||"Customer",data.last_name||"",data.email,data.phone,data.city,data.country]);c=await get("SELECT * FROM customers WHERE id=?",[r.id]);await activity("webhook_customer_created","customer",c.id,`WooCommerce webhook created customer ${data.email}`);}
    else await run(`UPDATE customers SET woo_customer_id=COALESCE(?,woo_customer_id),first_name=?,last_name=?,phone=?,city=?,country=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,[payload.customer_id||null,data.first_name||c.first_name,data.last_name||c.last_name,data.phone,data.city,data.country,c.id]);
    const wooId=payload.id||null;let existing=wooId?await get("SELECT * FROM orders WHERE woo_order_id=?",[wooId]):null;let orderId;
    if(existing){await run(`UPDATE orders SET customer_id=?,order_number=?,status=?,total=?,currency=?,created_at=?,raw_json=? WHERE id=?`,[c.id,payload.number||String(wooId||""),payload.status||"pending",Number(payload.total||0),payload.currency||"INR",payload.date_created||new Date().toISOString(),JSON.stringify(payload),existing.id]);orderId=existing.id;}
    else{const r=await run(`INSERT INTO orders(woo_order_id,customer_id,order_number,status,total,currency,created_at,raw_json) VALUES(?,?,?,?,?,?,?,?)`,[wooId,c.id,payload.number||String(wooId||""),payload.status||"pending",Number(payload.total||0),payload.currency||"INR",payload.date_created||new Date().toISOString(),JSON.stringify(payload)]);orderId=r.id;}
    await saveItems(orderId,payload.line_items||[]);await recalc(c.id);await activity("webhook_received","order",orderId,`WooCommerce webhook received for order #${payload.number||wooId||orderId}`);await run("INSERT INTO webhook_logs(event_type,woo_order_id,status,message) VALUES(?,?,?,?)",[event,wooId,"success","Order synced successfully"]);res.json({ok:true,message:"WooCommerce order synced",order_id:orderId});
  }catch(e){await run("INSERT INTO webhook_logs(event_type,woo_order_id,status,message) VALUES(?,?,?,?)",[event,payload.id||null,"error",e.message]).catch(()=>{});res.status(400).json({error:e.message});}
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

init().then(()=>{console.log("Lavender SQLite database is ready.");app.listen(PORT,()=>console.log(`Lavender is running at http://localhost:${PORT}`));}).catch(err=>{console.error("Database initialization failed:",err);process.exit(1);});
