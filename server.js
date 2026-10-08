// Albake Bytes Cafe backend
// Customer app at "/", cafe app at "/cafe". Stores the menu and orders in SQLite,
// takes Razorpay payments, and streams every new order live to the cafe app.
const express = require("express");
const { DatabaseSync } = require("node:sqlite"); // built into Node 22.13+, nothing to compile
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { parseCsv, toCsv } = require("./csv");

// ---------- Settings (environment variables) ----------
const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
const PORT = env("PORT", 3000);
const STAFF_PIN = String(env("STAFF_PIN", "1234"));
const DATA_DIR = env("DATA_DIR", path.join(__dirname, "data"));
const CAFE_NAME = env("CAFE_NAME", "Albake Bytes Cafe");
const DELIVERY_FEE = Number(env("DELIVERY_FEE", 20));
const GST_RATE = Number(env("GST_RATE", 0.05));
const RZP_KEY_ID = env("RAZORPAY_KEY_ID", "");
const RZP_KEY_SECRET = env("RAZORPAY_KEY_SECRET", "");
const RZP_WEBHOOK_SECRET = env("RAZORPAY_WEBHOOK_SECRET", "");
const RZP_API = env("RAZORPAY_API_BASE", "https://api.razorpay.com/v1");
const ONLINE = !!(RZP_KEY_ID && RZP_KEY_SECRET);
const PAY_AT_SEAT = env("PAY_AT_SEAT", "on") !== "off";
const PAYMENTS = [...(ONLINE ? ["Online"] : []), ...(PAY_AT_SEAT || !ONLINE ? ["UPI", "Card", "Cash"] : [])];
const STATUSES = ["Preparing", "On the way", "Delivered", "Cancelled"];
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

// ---------- Database ----------
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "albake.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
// Runs fn inside one database transaction (all-or-nothing)
db.transaction = fn => (...args) => {
  db.exec("BEGIN");
  try { const r = fn(...args); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
};
db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, emoji TEXT, name TEXT NOT NULL,
  description TEXT, price INTEGER NOT NULL, veg INTEGER DEFAULT 1,
  available INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, screen TEXT, row TEXT, seat TEXT, items TEXT NOT NULL,
  subtotal INTEGER, fee INTEGER, gst INTEGER, total INTEGER, payment TEXT, note TEXT,
  status TEXT DEFAULT 'Preparing', created_at INTEGER, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);
`);
const addCol = (table, col, type) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
};
addCol("orders", "payment_status", "TEXT DEFAULT 'Pay at seat'");
addCol("orders", "rzp_order_id", "TEXT");
addCol("orders", "rzp_payment_id", "TEXT");
addCol("items", "photo", "TEXT");

// ---------- Menu helpers ----------
const newItemId = () => "it_" + crypto.randomBytes(5).toString("hex");
const toBool = v => (typeof v === "boolean" ? v : !/^(0|no|n|false|non-?veg|off|out)$/i.test(String(v ?? "").trim()));
const itemOut = i => ({ ...i, veg: !!i.veg, available: !!i.available, photo: i.photo ? `/uploads/${i.photo}` : null });
const allItems = () => db.prepare("SELECT * FROM items ORDER BY sort, rowid").all().map(itemOut);

// Checks one menu row (from the cafe app or a CSV line). Returns {item} or {error}.
function cleanItem(raw, { partial = false } = {}) {
  const out = {};
  const str = (v, max) => String(v ?? "").trim().slice(0, max);
  if (!partial || raw.name !== undefined) { out.name = str(raw.name, 80); if (!out.name) return { error: "Name is required" }; }
  if (!partial || raw.category !== undefined) { out.category = str(raw.category, 40); if (!out.category) return { error: `Category is required for "${out.name || raw.name}"` }; }
  if (!partial || raw.price !== undefined) {
    const p = Math.round(Number(String(raw.price ?? "").replace(/[₹,\s]/g, "")));
    if (!(p > 0 && p < 100000)) return { error: `Price for "${out.name || raw.name}" must be a number above 0` };
    out.price = p;
  }
  if (!partial || raw.description !== undefined) out.description = str(raw.description, 160);
  if (!partial || raw.emoji !== undefined) out.emoji = str(raw.emoji, 8);
  if (!partial || raw.veg !== undefined) out.veg = raw.veg === undefined || raw.veg === "" ? 1 : toBool(raw.veg) ? 1 : 0;
  if (!partial || raw.available !== undefined) out.available = raw.available === undefined || raw.available === "" ? 1 : toBool(raw.available) ? 1 : 0;
  return { item: out };
}

function insertItems(rows, { replace = false } = {}) {
  const cleaned = [];
  for (const [n, r] of rows.entries()) {
    const { item, error } = cleanItem(r);
    if (error) return { error: `Row ${n + 2}: ${error}` };
    cleaned.push(item);
  }
  let added = 0, updated = 0;
  db.transaction(() => {
    if (replace) db.prepare("DELETE FROM items").run();
    let sort = db.prepare("SELECT COALESCE(MAX(sort),0) m FROM items").get().m;
    const find = db.prepare("SELECT id FROM items WHERE lower(name)=lower(?) AND lower(category)=lower(?)");
    const upd = db.prepare("UPDATE items SET description=?, emoji=?, price=?, veg=?, available=COALESCE(?, available) WHERE id=?");
    const ins = db.prepare("INSERT INTO items (id,category,emoji,name,description,price,veg,available,sort) VALUES (?,?,?,?,?,?,?,?,?)");
    for (const [n, i] of cleaned.entries()) {
      const hit = find.get(i.name, i.category);
      const hasAvail = String(rows[n].available ?? "").trim() !== "";
      if (hit) { upd.run(i.description, i.emoji, i.price, i.veg, hasAvail ? i.available : null, hit.id); updated++; }
      else { ins.run(newItemId(), i.category, i.emoji, i.name, i.description, i.price, i.veg, i.available, ++sort); added++; }
    }
  })();
  return { added, updated };
}

// First start: load your menu from menu.csv (later changes are made in the cafe app)
if (db.prepare("SELECT COUNT(*) n FROM items").get().n === 0) {
  const csvPath = path.join(__dirname, "menu.csv");
  if (fs.existsSync(csvPath)) {
    const r = insertItems(parseCsv(fs.readFileSync(csvPath, "utf8")));
    console.log(r.error ? `menu.csv problem, menu not loaded. ${r.error}` : `Loaded ${r.added} menu items from menu.csv.`);
  } else console.log("No menu.csv found. Add items in the cafe app (Menu tab).");
}

// ---------- Small safety helpers ----------
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
// Simple in-memory rate limiter: max `limit` hits per `windowMs` per key
const hits = new Map();
function limited(key, limit, windowMs) {
  const now = Date.now(), h = (hits.get(key) || []).filter(t => now - t < windowMs);
  h.push(now); hits.set(key, h);
  return h.length > limit;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();
const ipOf = req => req.ip || req.socket.remoteAddress || "?";

const rowToOrder = r => ({
  id: r.id, seat: { screen: r.screen, row: r.row, num: r.seat }, items: JSON.parse(r.items),
  subtotal: r.subtotal, fee: r.fee, gst: r.gst, total: r.total, payment: r.payment, note: r.note,
  status: r.status, paymentStatus: r.payment_status, paymentId: r.rzp_payment_id || null,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const getOrder = id => { const r = db.prepare("SELECT * FROM orders WHERE id=?").get(id); return r ? rowToOrder(r) : null; };

// ---------- Live updates to the cafe app (Server-Sent Events) ----------
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => res.write(msg));
}

// Moves a paid order into the cafe queue. Safe to call twice (checkout + webhook).
function markPaid(rzpOrderId, paymentId) {
  const r = db.prepare("SELECT * FROM orders WHERE rzp_order_id=?").get(rzpOrderId);
  if (!r) return null;
  if (r.payment_status !== "Paid") {
    db.prepare("UPDATE orders SET payment_status='Paid', rzp_payment_id=?, status='Preparing', updated_at=? WHERE id=?")
      .run(paymentId, Date.now(), r.id);
    const order = getOrder(r.id);
    broadcast("order", order);
    return order;
  }
  return rowToOrder(r);
}

async function razorpay(pathname, body) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(RZP_API + pathname, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64") },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error?.description || `Razorpay error ${res.status}`);
    return j;
  } finally { clearTimeout(t); }
}

// Orders left unpaid for 2 hours are closed so they don't pile up
setInterval(() => {
  db.prepare("UPDATE orders SET status='Cancelled', payment_status='Not paid', updated_at=? WHERE status='Awaiting payment' AND created_at < ?")
    .run(Date.now(), Date.now() - 2 * 3600e3);
}, 600e3).unref();

// ---------- App ----------
const app = express();
app.set("trust proxy", 1); // correct visitor IPs behind Render/Railway/Nginx
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "SAMEORIGIN" });
  next();
});

// Razorpay webhook needs the raw body for its signature, so it comes before the JSON parser
app.post("/api/razorpay/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
  if (!RZP_WEBHOOK_SECRET) return res.status(404).end();
  const expected = crypto.createHmac("sha256", RZP_WEBHOOK_SECRET).update(req.body).digest("hex");
  if (!safeEqual(expected, req.get("x-razorpay-signature") || "")) return res.status(400).end();
  try {
    const ev = JSON.parse(req.body.toString("utf8"));
    if (ev.event === "payment.captured" || ev.event === "order.paid") {
      const p = ev.payload?.payment?.entity;
      if (p?.order_id) markPaid(p.order_id, p.id);
    }
  } catch (e) { /* ignore malformed body */ }
  res.json({ ok: true });
});

app.use(express.json({ limit: "300kb" }));
app.get("/style.css", (req, res) => res.sendFile(path.join(__dirname, "style.css"), { maxAge: "1h" }));
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d", fallthrough: false }));

app.get("/healthz", (req, res) => res.json({ ok: true }));

// ---------- Customer API ----------
app.get("/api/menu", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ cafeName: CAFE_NAME, fee: DELIVERY_FEE, gstRate: GST_RATE, payments: PAYMENTS,
    razorpayKey: ONLINE ? RZP_KEY_ID : null, items: allItems() });
});

app.post("/api/orders", async (req, res) => {
  if (limited("order:" + ipOf(req), 15, 10 * 60e3)) return res.status(429).json({ error: "Too many orders from this phone. Please wait a few minutes or ask staff." });
  const { seat = {}, items = {}, payment, note = "" } = req.body || {};
  const screen = String(seat.screen || "").trim(), row = String(seat.row || "").trim().toUpperCase(), num = String(seat.num || "").trim();
  if (!/^\d{1,2}$/.test(screen) || !/^[A-Z]{1,2}$/.test(row) || !/^\d{1,3}$/.test(num))
    return res.status(400).json({ error: "Enter a valid screen, row and seat number." });
  if (!PAYMENTS.includes(payment)) return res.status(400).json({ error: "Choose a payment method." });
  if (typeof items !== "object" || Array.isArray(items)) return res.status(400).json({ error: "Your basket is empty." });

  // Prices always come from the database, never from the phone
  const getItem = db.prepare("SELECT * FROM items WHERE id = ?");
  const lines = []; let subtotal = 0;
  for (const [id, qtyRaw] of Object.entries(items).slice(0, 60)) {
    const qty = Math.floor(Number(qtyRaw));
    if (!qty || qty < 1 || qty > 20) continue;
    const it = getItem.get(id);
    if (!it) return res.status(400).json({ error: "An item in your basket is no longer on the menu. Refresh and try again." });
    if (!it.available) return res.status(409).json({ error: `${it.name} just sold out. Remove it and try again.` });
    lines.push({ id, name: it.name, emoji: it.emoji, qty, price: it.price });
    subtotal += qty * it.price;
  }
  if (!lines.length) return res.status(400).json({ error: "Your basket is empty." });

  const fee = DELIVERY_FEE, gst = Math.round(subtotal * GST_RATE), total = subtotal + fee + gst, now = Date.now();
  const idTaken = db.prepare("SELECT 1 FROM orders WHERE id=?");
  let id; do { id = "AB" + crypto.randomInt(1000, 100000); } while (idTaken.get(id));
  const online = payment === "Online";
  let rzpOrder = null;
  if (online) {
    try {
      rzpOrder = await razorpay("/orders", { amount: total * 100, currency: "INR", receipt: id,
        notes: { seat: `Screen ${screen} ${row}${num}`, cafe_order: id } });
    } catch (e) {
      console.error("Razorpay order failed:", e.message);
      return res.status(502).json({ error: "Online payment is unavailable right now. Choose pay at seat or try again." });
    }
  }
  db.prepare(`INSERT INTO orders (id,screen,row,seat,items,subtotal,fee,gst,total,payment,note,status,payment_status,rzp_order_id,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, screen, row, num, JSON.stringify(lines), subtotal, fee, gst, total, payment, String(note).slice(0, 200),
      online ? "Awaiting payment" : "Preparing", online ? "Pending" : "Pay at seat", rzpOrder?.id || null, now, now);
  const order = getOrder(id);
  if (!online) broadcast("order", order); // online orders reach the cafe app only after payment
  res.status(201).json(online ? { ...order, razorpay: { key: RZP_KEY_ID, orderId: rzpOrder.id, amount: rzpOrder.amount, currency: "INR", name: CAFE_NAME } } : order);
});

// Called by the phone after Razorpay Checkout succeeds
app.post("/api/orders/:id/verify", (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  const r = db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if (!ONLINE || !r || !r.rzp_order_id || r.rzp_order_id !== razorpay_order_id) return res.status(404).json({ error: "Order not found" });
  const expected = crypto.createHmac("sha256", RZP_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
  if (!safeEqual(expected, razorpay_signature || "")) return res.status(400).json({ error: "We couldn't confirm this payment. If money was taken, show this screen to staff." });
  res.json(markPaid(razorpay_order_id, razorpay_payment_id));
});

// Customer closed the payment window and wants to pay at the seat instead
app.post("/api/orders/:id/pay-at-seat", (req, res) => {
  const { payment } = req.body || {};
  if (!PAY_AT_SEAT || !["UPI", "Card", "Cash"].includes(payment)) return res.status(400).json({ error: "Pay at seat isn't available." });
  const r = db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if (!r || r.payment_status !== "Pending") return res.status(404).json({ error: "Order not found" });
  db.prepare("UPDATE orders SET payment=?, payment_status='Pay at seat', status='Preparing', updated_at=? WHERE id=?").run(payment, Date.now(), r.id);
  const order = getOrder(r.id);
  broadcast("order", order);
  res.json(order);
});

app.get("/api/orders/:id", (req, res) => {
  const o = getOrder(req.params.id);
  o ? res.json(o) : res.status(404).json({ error: "Order not found" });
});

// ---------- Cafe (staff) API ----------
function staffOnly(req, res, next) {
  const key = "pin:" + ipOf(req);
  const blocked = (hits.get(key) || []).filter(t => Date.now() - t < 15 * 60e3).length >= 10;
  if (blocked) return res.status(429).json({ error: "Too many wrong PINs. Wait 15 minutes and try again." });
  if (safeEqual(req.get("x-staff-pin") || req.query.pin || "", STAFF_PIN)) return next();
  limited(key, 1e9, 15 * 60e3); // record the failed try
  res.status(401).json({ error: "Wrong cafe PIN" });
}
const staff = express.Router();
staff.use(staffOnly);

staff.get("/check", (req, res) => res.json({ ok: true, cafeName: CAFE_NAME }));

staff.get("/orders", (req, res) => {
  const since = Date.now() - 18 * 3600e3;
  res.json(db.prepare("SELECT * FROM orders WHERE created_at > ? AND status != 'Awaiting payment' ORDER BY created_at DESC").all(since).map(rowToOrder));
});

staff.patch("/orders/:id", (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: "Unknown status" });
  const r = db.prepare("UPDATE orders SET status=?, updated_at=? WHERE id=? AND status != 'Awaiting payment'").run(status, Date.now(), req.params.id);
  if (!r.changes) return res.status(404).json({ error: "Order not found" });
  const order = getOrder(req.params.id);
  broadcast("order", order);
  res.json(order);
});

// Sales report as a spreadsheet file (opens in Excel / Google Sheets)
staff.get("/report.csv", (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const start = Date.parse(day + "T00:00:00+05:30"), end = start + 24 * 3600e3;
  const rows = db.prepare("SELECT * FROM orders WHERE created_at >= ? AND created_at < ? AND status != 'Awaiting payment' ORDER BY created_at").all(start, end).map(rowToOrder);
  const csv = toCsv([
    ["Order", "Time", "Screen", "Seat", "Items", "Subtotal", "Delivery", "GST", "Total", "Payment", "Payment status", "Razorpay ID", "Order status", "Note"],
    ...rows.map(o => [o.id, new Date(o.createdAt + 5.5 * 3600e3).toISOString().slice(11, 16), o.seat.screen, o.seat.row + o.seat.num,
      o.items.map(i => `${i.qty}x ${i.name}`).join("; "), o.subtotal, o.fee, o.gst, o.total, o.payment, o.paymentStatus, o.paymentId || "", o.status, o.note || ""]),
  ]);
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="albake-orders-${day}.csv"` });
  res.send("﻿" + csv);
});

// --- Menu management ---
staff.get("/items", (req, res) => res.json(allItems()));

staff.post("/items", (req, res) => {
  const { item, error } = cleanItem(req.body || {});
  if (error) return res.status(400).json({ error });
  const id = newItemId();
  const sort = db.prepare("SELECT COALESCE(MAX(sort),0)+1 s FROM items").get().s;
  db.prepare("INSERT INTO items (id,category,emoji,name,description,price,veg,available,sort) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, item.category, item.emoji, item.name, item.description, item.price, item.veg, item.available, sort);
  broadcast("menu", {});
  res.status(201).json(itemOut(db.prepare("SELECT * FROM items WHERE id=?").get(id)));
});

staff.patch("/items/:id", (req, res) => {
  const it = db.prepare("SELECT * FROM items WHERE id=?").get(req.params.id);
  if (!it) return res.status(404).json({ error: "Item not found" });
  const { item, error } = cleanItem(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ error });
  const keys = Object.keys(item);
  if (keys.length) db.prepare(`UPDATE items SET ${keys.map(k => k + "=?").join(",")} WHERE id=?`).run(...keys.map(k => item[k]), it.id);
  broadcast("menu", {});
  res.json(itemOut(db.prepare("SELECT * FROM items WHERE id=?").get(it.id)));
});

staff.delete("/items/:id", (req, res) => {
  const it = db.prepare("SELECT * FROM items WHERE id=?").get(req.params.id);
  if (!it) return res.status(404).json({ error: "Item not found" });
  db.prepare("DELETE FROM items WHERE id=?").run(it.id);
  if (it.photo) fs.rm(path.join(UPLOAD_DIR, it.photo), { force: true }, () => {});
  broadcast("menu", {});
  res.json({ ok: true });
});

// Move an item up or down, or move a whole category
staff.post("/items/:id/move", (req, res) => {
  const items = db.prepare("SELECT id, category FROM items ORDER BY sort, rowid").all();
  const idx = items.findIndex(i => i.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "Item not found" });
  const dir = req.body?.dir === "up" ? -1 : 1;
  let order;
  if (req.body?.whole === "category") {
    const cats = [...new Set(items.map(i => i.category))];
    const ci = cats.indexOf(items[idx].category), cj = ci + dir;
    if (cj >= 0 && cj < cats.length) [cats[ci], cats[cj]] = [cats[cj], cats[ci]];
    order = cats.flatMap(c => items.filter(i => i.category === c));
  } else {
    const same = items.filter(i => i.category === items[idx].category);
    const si = same.findIndex(i => i.id === req.params.id), sj = si + dir;
    if (sj >= 0 && sj < same.length) [same[si], same[sj]] = [same[sj], same[si]];
    const cats = [...new Set(items.map(i => i.category))];
    order = cats.flatMap(c => (c === items[idx].category ? same : items.filter(i => i.category === c)));
  }
  const upd = db.prepare("UPDATE items SET sort=? WHERE id=?");
  db.transaction(() => order.forEach((i, n) => upd.run(n + 1, i.id)))();
  broadcast("menu", {});
  res.json(allItems());
});

// Upload a photo for an item (JPG, PNG or WebP, up to 3 MB)
const IMG_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
staff.post("/items/:id/photo", express.raw({ type: Object.keys(IMG_TYPES), limit: "3mb" }), (req, res) => {
  const it = db.prepare("SELECT * FROM items WHERE id=?").get(req.params.id);
  if (!it) return res.status(404).json({ error: "Item not found" });
  const ext = IMG_TYPES[req.get("content-type")];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Upload a JPG, PNG or WebP photo." });
  const file = `${it.id}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), req.body);
  if (it.photo) fs.rm(path.join(UPLOAD_DIR, it.photo), { force: true }, () => {});
  db.prepare("UPDATE items SET photo=? WHERE id=?").run(file, it.id);
  broadcast("menu", {});
  res.json(itemOut(db.prepare("SELECT * FROM items WHERE id=?").get(it.id)));
});
staff.delete("/items/:id/photo", (req, res) => {
  const it = db.prepare("SELECT * FROM items WHERE id=?").get(req.params.id);
  if (!it) return res.status(404).json({ error: "Item not found" });
  if (it.photo) fs.rm(path.join(UPLOAD_DIR, it.photo), { force: true }, () => {});
  db.prepare("UPDATE items SET photo=NULL WHERE id=?").run(it.id);
  broadcast("menu", {});
  res.json(itemOut(db.prepare("SELECT * FROM items WHERE id=?").get(it.id)));
});

// Import a menu spreadsheet (CSV). mode "add" updates matching items and adds new ones; "replace" swaps the whole menu.
staff.post("/menu/import", (req, res) => {
  const { csv, mode } = req.body || {};
  let rows;
  try { rows = parseCsv(String(csv || "")); } catch (e) { return res.status(400).json({ error: "Couldn't read that file. Save it as CSV and try again." }); }
  if (!rows.length) return res.status(400).json({ error: "The file has no menu rows. Check it has a header row: category,name,price,description,veg,emoji,available" });
  if (!("name" in rows[0]) || !("price" in rows[0]) || !("category" in rows[0])) return res.status(400).json({ error: "The first row must name the columns: category, name, price (description, veg, emoji, available are optional)." });
  const r = insertItems(rows, { replace: mode === "replace" });
  if (r.error) return res.status(400).json(r);
  broadcast("menu", {});
  res.json(r);
});
staff.get("/menu.csv", (req, res) => {
  const csv = toCsv([["category", "name", "price", "description", "veg", "emoji", "available"],
    ...allItems().map(i => [i.category, i.name, i.price, i.description || "", i.veg ? "yes" : "no", i.emoji || "", i.available ? "yes" : "no"])]);
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="albake-menu.csv"' });
  res.send("﻿" + csv);
});

staff.get("/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("event: hello\ndata: {}\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
});

app.use("/api/staff", staff);

// ---------- Pages ----------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "customer.html")));
app.get(["/cafe", "/cafe/"], (req, res) => res.sendFile(path.join(__dirname, "cafe.html")));
app.get("/staff", (req, res) => res.redirect("/cafe"));
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.use((req, res) => res.redirect("/"));
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "That file is too big." });
  if (err.status && err.status < 500) return res.status(err.status).end();
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server. Try again." });
});

const server = app.listen(PORT, () => {
  console.log(`${CAFE_NAME} running. Customer app: http://localhost:${PORT}/  Cafe app: http://localhost:${PORT}/cafe`);
  console.log(ONLINE ? `Razorpay online payment ON (${RZP_KEY_ID.startsWith("rzp_test") ? "TEST mode" : "LIVE mode"})` : "Razorpay keys not set: only pay at seat is offered.");
  if (STAFF_PIN === "1234") console.log("Warning: using default cafe PIN 1234. Set STAFF_PIN before going live.");
});
const shutdown = () => { server.close(); db.close(); process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
