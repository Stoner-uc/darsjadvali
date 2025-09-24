// index.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const schedule = require("node-schedule");
const axios = require("axios");
const XLSX = require("xlsx");

// ----------------- Konfiguratsiya -----------------
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN .env faylda topilmadi!");
  process.exit(1);
}
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean).map(Number);
if (ADMIN_IDS.length === 0) {
  console.warn("⚠️ Eslatma: ADMIN_IDS .env da ko'rsatilmagan. Test uchun adminni qo'shing.");
}
const DEFAULT_NOTIFY_TIME = process.env.DEFAULT_NOTIFY_TIME || "07:30";
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_BYTES || 10 * 1024 * 1024); // 10 MB

// ----------------- Fayl yo'llari -----------------
const DATA_DIR = __dirname;
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SCHEDULE_FILE = path.join(DATA_DIR, "schedule.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ----------------- Yordamchi funktsiyalar -----------------
function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const s = fs.readFileSync(filePath, "utf8");
    return JSON.parse(s);
  } catch (e) {
    console.error(`readJsonSafe error (${filePath}):`, e.message || e);
    return fallback;
  }
}
function writeJsonSafe(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error(`writeJsonSafe error (${filePath}):`, e.message || e);
    return false;
  }
}
function backupFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const base = path.basename(filePath);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(BACKUP_DIR, `${base}.${ts}.bak`);
    fs.copyFileSync(filePath, dest);
    return dest;
  } catch (e) {
    console.error("backupFile error:", e.message || e);
    return null;
  }
}
function isAdmin(id) {
  return ADMIN_IDS.includes(Number(id));
}

// ----------------- Dastlabki holat -----------------
let users = readJsonSafe(USERS_FILE, {});
let scheduleData = readJsonSafe(SCHEDULE_FILE, null);
const DAYS = ["Dushanba","Seshanba","Chorshanba","Payshanba","Juma","Shanba","Yakshanba"];
if (!scheduleData || typeof scheduleData !== "object") {
  scheduleData = {};
  DAYS.forEach(d => scheduleData[d] = []);
  writeJsonSafe(SCHEDULE_FILE, scheduleData);
}

// ----------------- Bot init -----------------
const bot = new TelegramBot(TOKEN, { polling: true });

// ----------------- Safe send & error handling -----------------
async function safeSendMessage(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, opts);
  } catch (err) {
    // log
    console.error(`safeSendMessage error (chatId: ${chatId}):`, (err && err.response && err.response.body) ? err.response.body : (err && err.message) ? err.message : err);
    // If chat not found (400), remove user from users list to prevent repeated failures
    const code = err && err.response && err.response.status;
    if (code === 400 || code === 403) {
      // remove this chatId from users if present
      if (users && users[String(chatId)]) {
        delete users[String(chatId)];
        writeJsonSafe(USERS_FILE, users);
        // notify admins
        for (const a of ADMIN_IDS) {
          try { await bot.sendMessage(a, `⚠️ Foydalanuvchi ${chatId} ga xabar yuborib bo'lmadi va u users.json dan o'chirildi (kod ${code}).`); } catch(_) {}
        }
      }
    }
    return null;
  }
}

// ----------------- Time helpers -----------------
function getTodayDay() {
  const idx = new Date().getDay(); // 0 Sunday
  return idx === 0 ? "Yakshanba" : DAYS[idx - 1];
}
function getTomorrowDay() {
  const idx = (new Date().getDay() + 1) % 7;
  return idx === 0 ? "Yakshanba" : DAYS[idx - 1];
}
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const m = timeStr.match(/([01]?\d|2[0-3])[:.]([0-5]\d)/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

// ----------------- Schedule sending (chunk-safe) -----------------
async function sendDaySchedule(chatId, dayName) {
  try {
    const arr = Array.isArray(scheduleData[dayName]) ? scheduleData[dayName] : [];
    if (arr.length === 0) {
      if (dayName !== "Shanba" && dayName !== "Yakshanba") {
        await safeSendMessage(chatId, `📅 ${dayName}: darslar mavjud emas.`);
      }
      return;
    }
    // sort by time
    const sorted = arr.slice().sort((a,b) => parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time));
    const header = `📅 ${dayName} jadvali:\n\n`;
    const items = sorted.map((it, i) => {
      const line1 = `${i+1}. ${it.time || ""} | ${it.subject || ""}`;
      const line2 = [it.building || "", it.room ? `Xona: ${it.room}` : ""].filter(Boolean).join(" | ");
      const line3 = it.teacher ? `👨‍🏫 ${it.teacher}` : "";
      return [line1, line2, line3].filter(Boolean).join("\n");
    });
    // chunking to avoid >4096 Telegram limit
    const MAX = 3800;
    let chunk = header;
    for (const item of items) {
      const toAdd = item + "\n\n";
      if ((chunk + toAdd).length > MAX) {
        await safeSendMessage(chatId, chunk.trim());
        chunk = toAdd;
      } else chunk += toAdd;
    }
    if (chunk.trim()) await safeSendMessage(chatId, chunk.trim());
  } catch (e) {
    console.error("sendDaySchedule error:", e.message || e);
  }
}

// ----------------- Jobs: reminders per user -----------------
let jobs = {};
function clearJobFor(chatId) {
  if (jobs[chatId]) {
    try { jobs[chatId].cancel(); } catch(_) {}
    delete jobs[chatId];
  }
}
function scheduleReminder(chatId, timeStr) {
  clearJobFor(chatId);
  const m = timeStr && timeStr.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return;
  const hour = Number(m[1]), minute = Number(m[2]);
  try {
    const job = schedule.scheduleJob({ hour, minute, tz: "Asia/Tashkent" }, async () => {
      const tomorrow = getTomorrowDay();
      if ((tomorrow === "Shanba" || tomorrow === "Yakshanba") &&
          (!Array.isArray(scheduleData[tomorrow]) || scheduleData[tomorrow].length === 0)) {
        return; // don't send empty weekend
      }
      await sendDaySchedule(chatId, tomorrow);
    });
    jobs[chatId] = job;
  } catch (e) {
    console.error("scheduleReminder error:", e.message || e);
  }
}
function restoreAllReminders() {
  for (const k of Object.keys(users)) {
    const u = users[k];
    if (u && u.notifyTime) scheduleReminder(Number(k), u.notifyTime);
  }
}
restoreAllReminders();

// ----------------- Excel / Google Sheets parsing -----------------
function parseExcelBuffer(buffer) {
  try {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const normalize = s => (""+s).trim().toLowerCase();
    const synonyms = {
      day: ["kun","day","kuni","день","weekday"],
      time: ["vaqt","soat","time","hours"],
      subject: ["fan","fan/tadbir","tadbir","subject","title","nomi","name"],
      room: ["xona","room","auditoriya","auditorium"],
      building: ["bino","building"],
      teacher: ["o'qituvchi","oqituvchi","teacher","instr","professor"]
    };
    // find header mapping
    const headerKeys = Object.keys(rows[0] || {});
    const map = {};
    headerKeys.forEach(h => {
      const nh = normalize(h);
      for (const k of Object.keys(synonyms)) {
        for (const syn of synonyms[k]) {
          if (nh === syn || nh.includes(syn)) { map[k] = h; break; }
        }
        if (map[k]) break;
      }
    });
    // fallback: if day not found, assume first column is day
    if (!map.day && headerKeys.length > 0) map.day = headerKeys[0];

    const newSched = {};
    DAYS.forEach(d => newSched[d] = []);

    for (const r of rows) {
      const dayVal = (r[map.day] || "").toString().trim();
      if (!dayVal) continue;
      // normalize dayVal to one of DAYS
      let dayName = null;
      const dv = dayVal.toLowerCase();
      for (const d of DAYS) if (dv.includes(d.toLowerCase())) { dayName = d; break; }
      if (!dayName) {
        const en = { monday:"Dushanba", tuesday:"Seshanba", wednesday:"Chorshanba", thursday:"Payshanba", friday:"Juma", saturday:"Shanba", sunday:"Yakshanba" };
        for (const k of Object.keys(en)) if (dv.includes(k)) { dayName = en[k]; break; }
      }
      if (!dayName) continue;

      const time = map.time ? (r[map.time]||"").toString().trim() : "";
      const subject = map.subject ? (r[map.subject]||"").toString().trim() : "";
      const room = map.room ? (r[map.room]||"").toString().trim() : "";
      const building = map.building ? (r[map.building]||"").toString().trim() : "";
      const teacher = map.teacher ? (r[map.teacher]||"").toString().trim() : "";

      newSched[dayName].push({ time, subject, room, building, teacher });
    }

    // remove empty weekend days
    ["Shanba","Yakshanba"].forEach(d => { if (!Array.isArray(newSched[d]) || newSched[d].length === 0) delete newSched[d]; });
    // ensure weekdays exist
    ["Dushanba","Seshanba","Chorshanba","Payshanba","Juma"].forEach(d => { if (!Array.isArray(newSched[d])) newSched[d] = []; });

    return newSched;
  } catch (e) {
    console.error("parseExcelBuffer error:", e.message || e);
    return null;
  }
}

function toGoogleExportUrl(inputUrl) {
  if (!inputUrl || typeof inputUrl !== "string") return null;
  const m = inputUrl.match(/\/d\/([a-zA-Z0-9-_]+)/) || inputUrl.match(/docs.google.com\/spreadsheets\/u\/\d+\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return null;
  const fileId = m[1];
  const gidMatch = inputUrl.match(/[?&]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : undefined;
  let url = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx`;
  if (gid) url += `&gid=${gid}`;
  return url;
}

// ----------------- Keyboards -----------------
function mainMenuInline(chatId) {
  const ik = [
    [{ text: "📅 Bugungi", callback_data: "view_today" }, { text: "📅 Ertangi", callback_data: "view_tomorrow" }],
    [{ text: "📆 Haftalik", callback_data: "view_week" }, { text: "⏰ Eslatma", callback_data: "set_time" }]
  ];
  if (isAdmin(chatId)) ik.push([{ text: "🔐 Admin panel", callback_data: "admin_panel" }]);
  return { reply_markup: { inline_keyboard: ik } };
}
function adminPanelInline() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Qo'lda qo'shish", callback_data: "admin_add" }],
        [{ text: "📥 Excel/Google yuklash", callback_data: "admin_upload" }],
        [{ text: "🗑️ O'chirish", callback_data: "admin_remove" }],
        [{ text: "📊 Statistika", callback_data: "admin_stats" }],
        [{ text: "📨 Xabar yuborish", callback_data: "admin_broadcast" }],
        [{ text: "⬅️ Orqaga", callback_data: "back_main" }]
      ]
    }
  };
}
function daysInlineWithBack(prefix="") {
  const rows = DAYS.map(d => ([{ text: d, callback_data: `${prefix}${d}` }]));
  rows.push([{ text: "⬅️ Orqaga", callback_data: "back_main" }]);
  return { reply_markup: { inline_keyboard: rows } };
}
function backOnly() { return { reply_markup: { inline_keyboard: [[{ text: "⬅️ Orqaga", callback_data: "back_main" }]] } }; }

// ----------------- Callback handler -----------------
bot.on("callback_query", async (cq) => {
  const data = cq.data;
  const chatId = cq.message.chat.id;
  try {
    if (data === "view_today") { await sendDaySchedule(chatId, getTodayDay()); return bot.answerCallbackQuery(cq.id); }
    if (data === "view_tomorrow") { await sendDaySchedule(chatId, getTomorrowDay()); return bot.answerCallbackQuery(cq.id); }
    if (data === "view_week") {
      for (const d of DAYS) {
        if ((d === "Shanba" || d === "Yakshanba") && (!Array.isArray(scheduleData[d]) || scheduleData[d].length === 0)) continue;
        await sendDaySchedule(chatId, d);
      }
      return bot.answerCallbackQuery(cq.id);
    }
    if (data === "set_time") {
      users[chatId] = users[chatId] || {};
      users[chatId].waitingForTime = true; writeJsonSafe(USERS_FILE, users);
      await safeSendMessage(chatId, "⏰ Vaqtni `HH:MM` formatda yuboring (masalan: 07:30).", { parse_mode: "Markdown", ...backOnly() });
      return bot.answerCallbackQuery(cq.id);
    }

    if (data === "admin_panel") {
      if (!isAdmin(chatId)) { await bot.answerCallbackQuery(cq.id, { text: "Siz admin emassiz." }); return; }
      await safeSendMessage(chatId, "🔐 Admin panel:", adminPanelInline());
      return bot.answerCallbackQuery(cq.id);
    }

    if (data === "admin_stats") {
      if (!isAdmin(chatId)) return bot.answerCallbackQuery(cq.id);
      await safeSendMessage(chatId, `📊 Foydalanuvchilar soni: ${Object.keys(users).length}`);
      return bot.answerCallbackQuery(cq.id);
    }

    if (data === "admin_upload") {
      if (!isAdmin(chatId)) return bot.answerCallbackQuery(cq.id);
      users[chatId] = users[chatId] || {};
      users[chatId].uploadingExcel = true; writeJsonSafe(USERS_FILE, users);
      await safeSendMessage(chatId, "📂 Excel (.xlsx) faylini yuboring yoki Google Sheets havolasini yuboring.", backOnly());
      return bot.answerCallbackQuery(cq.id);
    }

    if (data === "admin_add") {
      if (!isAdmin(chatId)) return bot.answerCallbackQuery(cq.id);
      users[chatId] = users[chatId] || {};
      users[chatId].addingManual = { step: "choose_day" }; writeJsonSafe(USERS_FILE, users);
      await safeSendMessage(chatId, "📅 Qaysi kunga qo'shmoqchisiz?", daysInlineWithBack("admin_add_day|"));
      return bot.answerCallbackQuery(cq.id);
    }

    if (data && data.startsWith("admin_add_day|")) {
      if (!isAdmin(chatId)) return bot.answerCallbackQuery(cq.id);
      const day = data.split("|")[1];
      if (!DAYS.includes(day)) return bot.answerCallbackQuery(cq.id, { text: "Noma'lum kun." });
      users[chatId].addingManual = { step: "time", day }; writeJsonSafe(USERS_FILE, users);
      await safeSendMessage(chatId, `✍️ ${day} uchun soatni kiriting (misol: 12:00-13:20).`, backOnly());
      return bot.answerCallbackQuery(cq.id);
    }

    if (data === "admin_remove") {
      if (!isAdmin(chatId)) return bot.answerCallbackQuery(cq.id);
      users[chatId] = users[chatId] || {};
      users[chatId].removing = { step: "choose_day" }; writeJsonSafe(USERS_FILE, users);
      await safeSendMessage(chatId, "📅 Qaysi kundan o'chirmoqchisiz?", daysInlineWithBack("admin_remove_day|"));
      return bot.answerCallbackQuery(cq.id);
    }

    if (data && data.startsWith("admin_remove_day|")) {
      if (!isAdmin(chatId)) return bot.answerCallbackQuery(cq.id);
      const day = data.split("|")[1];
      const arr = Array.isArray(scheduleData[day]) ? scheduleData[day] : [];
      if (!arr.length) {
        await safeSendMessage(chatId, `${day} uchun hech narsa topilmadi.`, backOnly());
        return bot.answerCallbackQuery(cq.id);
      }
      const ik = { reply_markup: { inline_keyboard: arr.map((it, idx) => ([{ text: `${idx+1}. ${it.subject || it.time || "Item"}`, callback_data: `remove_item|${day}|${idx}` }])).concat([[{ text: "⬅️ Orqaga", callback_data: "back_main" }]]) } };
      await safeSendMessage(chatId, `🔹 ${day} jadvali:`, ik);
      return bot.answerCallbackQuery(cq.id);
    }

    if (data && data.startsWith("remove_item|")) {
      if (!isAdmin(chatId)) return bot.answerCallbackQuery(cq.id);
      const [, day, idxS] = data.split("|");
      const idx = Number(idxS);
      if (!Array.isArray(scheduleData[day]) || isNaN(idx) || idx < 0 || idx >= scheduleData[day].length) {
        await safeSendMessage(chatId, "❌ Noto'g'ri indeks.", backOnly());
        return bot.answerCallbackQuery(cq.id);
      }
      const removed = scheduleData[day].splice(idx, 1)[0];
      backupFile(SCHEDULE_FILE);
      writeJsonSafe(SCHEDULE_FILE, scheduleData);
      await safeSendMessage(chatId, `✅ O'chirildi: ${removed.subject || removed.time || JSON.stringify(removed)}`, adminPanelInline());
      return bot.answerCallbackQuery(cq.id);
    }

    if (data === "admin_broadcast") {
      if (!isAdmin(chatId)) return bot.answerCallbackQuery(cq.id);
      users[chatId] = users[chatId] || {};
      users[chatId].waitingForBroadcast = true; writeJsonSafe(USERS_FILE, users);
      await safeSendMessage(chatId, "✍️ Endi yubormoqchi bo'lgan xabaringizni (text/photo/video/document/audio/voice) yuboring.", backOnly());
      return bot.answerCallbackQuery(cq.id);
    }

    if (data === "back_main") {
      if (users[chatId]) {
        delete users[chatId].uploadingExcel;
        delete users[chatId].addingManual;
        delete users[chatId].removing;
        delete users[chatId].waitingForTime;
        delete users[chatId].waitingForBroadcast;
        writeJsonSafe(USERS_FILE, users);
      }
      await safeSendMessage(chatId, "🔙 Asosiy menyu:", mainMenuInline(chatId));
      return bot.answerCallbackQuery(cq.id);
    }

    // default
    return bot.answerCallbackQuery(cq.id);
  } catch (e) {
    console.error("callback_query error:", e.message || e);
    try { await bot.answerCallbackQuery(cq.id, { text: "Xatolik yuz berdi." }); } catch(_) {}
  }
});

// ----------------- Single message handler -----------------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // Ensure user exists
  if (!users[String(chatId)]) {
    users[String(chatId)] = { notifyTime: DEFAULT_NOTIFY_TIME };
    writeJsonSafe(USERS_FILE, users);
    scheduleReminder(chatId, DEFAULT_NOTIFY_TIME);
  }

  // 1) If document and admin is in upload state => Excel file
  if (msg.document && isAdmin(chatId) && users[String(chatId)].uploadingExcel) {
    const size = msg.document.file_size || 0;
    if (size > MAX_FILE_SIZE) {
      delete users[String(chatId)].uploadingExcel; writeJsonSafe(USERS_FILE, users);
      return safeSendMessage(chatId, `❌ Fayl juda katta. Maks hajm: ${Math.round(MAX_FILE_SIZE/1024/1024)} MB.`, adminPanelInline());
    }
    try {
      const fileInfo = await bot.getFile(msg.document.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;
      const resp = await axios.get(fileUrl, { responseType: "arraybuffer", timeout: 20000 });
      const parsed = parseExcelBuffer(Buffer.from(resp.data));
      if (!parsed) throw new Error("parseExcelBuffer returned null");
      backupFile(SCHEDULE_FILE);
      scheduleData = parsed;
      writeJsonSafe(SCHEDULE_FILE, scheduleData);
      delete users[String(chatId)].uploadingExcel; writeJsonSafe(USERS_FILE, users);
      await safeSendMessage(chatId, "✅ Excel fayldan jadval muvaffaqiyatli yuklandi.", adminPanelInline());
    } catch (e) {
      console.error("document processing error:", e.message || e);
      delete users[String(chatId)].uploadingExcel; writeJsonSafe(USERS_FILE, users);
      await safeSendMessage(chatId, "❌ Faylni o'qishda xato. Iltimos faylni tekshirib qayta yuboring.", adminPanelInline());
    }
    return;
  }

  // 2) If admin in uploadingExcel and sent Google Sheets URL
  if (isAdmin(chatId) && users[String(chatId)].uploadingExcel && text.startsWith("http")) {
    const gUrl = toGoogleExportUrl(text);
    if (!gUrl) {
      return safeSendMessage(chatId, "❌ Google Sheets havolasi noto'g'ri. Iltimos to'liq URL yuboring.", backOnly());
    }
    try {
      const resp = await axios.get(gUrl, { responseType: "arraybuffer", timeout: 20000 });
      const parsed = parseExcelBuffer(Buffer.from(resp.data));
      if (!parsed) throw new Error("parseExcelBuffer returned null");
      backupFile(SCHEDULE_FILE);
      scheduleData = parsed;
      writeJsonSafe(SCHEDULE_FILE, scheduleData);
      delete users[String(chatId)].uploadingExcel; writeJsonSafe(USERS_FILE, users);
      await safeSendMessage(chatId, "✅ Google Sheets jadvali yuklandi.", adminPanelInline());
    } catch (e) {
      console.error("GoogleSheets fetch error:", e.message || e);
      delete users[String(chatId)].uploadingExcel; writeJsonSafe(USERS_FILE, users);
      await safeSendMessage(chatId, "❌ Havolani yuklashda xato (ruxsat yoki internet).", adminPanelInline());
    }
    return;
  }

  // 3) Admin manual add flow (step-by-step via text)
  if (isAdmin(chatId) && users[String(chatId)].addingManual) {
    const st = users[String(chatId)].addingManual;
    try {
      if (st.step === "choose_day") {
        // This step expects callback; if came as text, try to accept day name text
        const dayText = DAYS.find(d => d.toLowerCase() === text.toLowerCase());
        if (!dayText) return safeSendMessage(chatId, "❌ Iltimos to'g'ri kunni tanlang (Dushanba..Yakshanba).", backOnly());
        st.day = dayText; st.step = "time"; writeJsonSafe(USERS_FILE, users);
        return safeSendMessage(chatId, `✍️ ${dayText} uchun soatni kiriting (misol: 12:00-13:20).`, backOnly());
      }
      if (st.step === "time") {
        st.time = text; st.step = "subject"; writeJsonSafe(USERS_FILE, users);
        return safeSendMessage(chatId, "📘 Fan yoki tadbir nomini kiriting:", backOnly());
      }
      if (st.step === "subject") {
        st.subject = text; st.step = "room"; writeJsonSafe(USERS_FILE, users);
        return safeSendMessage(chatId, "🚪 Xona raqamini kiriting:", backOnly());
      }
      if (st.step === "room") {
        st.room = text; st.step = "building"; writeJsonSafe(USERS_FILE, users);
        return safeSendMessage(chatId, "🏢 Bino nomini kiriting:", backOnly());
      }
      if (st.step === "building") {
        st.building = text; st.step = "teacher"; writeJsonSafe(USERS_FILE, users);
        return safeSendMessage(chatId, "👩‍🏫 O'qituvchi (ixtiyoriy):", backOnly());
      }
      if (st.step === "teacher") {
        st.teacher = text || "";
        const day = st.day;
        if (!DAYS.includes(day)) {
          delete users[String(chatId)].addingManual; writeJsonSafe(USERS_FILE, users);
          return safeSendMessage(chatId, "❌ Kun noto'g'ri. Qayta boshlang.", adminPanelInline());
        }
        scheduleData[day] = scheduleData[day] || [];
        scheduleData[day].push({ time: st.time || "", subject: st.subject || "", room: st.room || "", building: st.building || "", teacher: st.teacher || "" });
        backupFile(SCHEDULE_FILE);
        writeJsonSafe(SCHEDULE_FILE, scheduleData);
        delete users[String(chatId)].addingManual; writeJsonSafe(USERS_FILE, users);
        return safeSendMessage(chatId, `✅ ${day} uchun yozuv qo'shildi.`, adminPanelInline());
      }
    } catch (e) {
      console.error("addingManual error:", e.message || e);
      delete users[String(chatId)].addingManual; writeJsonSafe(USERS_FILE, users);
      return safeSendMessage(chatId, "❌ Xatolik yuz berdi. Qayta urinib ko'ring.", adminPanelInline());
    }
    return;
  }

  // 4) Setting notify time by user
  if (users[String(chatId)] && users[String(chatId)].waitingForTime) {
    const rx = /^([01]?\d|2[0-3]):([0-5]\d)$/;
    if (!rx.test(text)) return safeSendMessage(chatId, "❌ Vaqt format noto'g'ri. Misol: 07:30", backOnly());
    users[String(chatId)].waitingForTime = false;
    users[String(chatId)].notifyTime = text;
    writeJsonSafe(USERS_FILE, users);
    scheduleReminder(chatId, text);
    return safeSendMessage(chatId, `✅ Eslatma vaqti o'rnatildi: ${text}`, mainMenuInline(chatId));
  }

  // 5) Broadcast: if admin in waitingForBroadcast
  if (isAdmin(chatId) && users[String(chatId)].waitingForBroadcast) {
    // turn off flag
    delete users[String(chatId)].waitingForBroadcast; writeJsonSafe(USERS_FILE, users);
    const targetIds = Object.keys(users).map(k => Number(k)).filter(id => !isNaN(id) && !ADMIN_IDS.includes(id));
    let sent = 0;
    for (const tid of targetIds) {
      try {
        if (msg.text) await bot.sendMessage(tid, `Muxum xabar!:\n\n${msg.text}`);
        else if (msg.photo) await bot.sendPhoto(tid, msg.photo[msg.photo.length-1].file_id, { caption: msg.caption || "" });
        else if (msg.video) await bot.sendVideo(tid, msg.video.file_id, { caption: msg.caption || "" });
        else if (msg.document) await bot.sendDocument(tid, msg.document.file_id, { caption: msg.caption || "" });
        else if (msg.audio) await bot.sendAudio(tid, msg.audio.file_id, { caption: msg.caption || "" });
        else if (msg.voice) await bot.sendVoice(tid, msg.voice.file_id, { caption: msg.caption || "" });
        else await bot.sendMessage(tid, "📢 Admin yangi xabar yubordi.");
        sent++;
      } catch (e) {
        console.error("broadcast send error to", tid, e && e.message ? e.message : e);
        // remove unreachable users on 400/403
        const code = e && e.response && e.response.status;
        if (code === 400 || code === 403) {
          if (users[String(tid)]) { delete users[String(tid)]; writeJsonSafe(USERS_FILE, users); }
        }
      }
      await new Promise(r => setTimeout(r, 120)); // small delay to reduce flood
    }
    return safeSendMessage(chatId, `✅ Xabar ${sent} foydalanuvchiga yuborildi.`, adminPanelInline());
  }

  // 6) Commands via text (simple)
  if (text === "/start") {
    // user already added above
    return safeSendMessage(chatId, "👋 Assalomu alaykum! Asosiy menyu:", mainMenuInline(chatId));
  }

  if (text === "🔐 Admin panel" && isAdmin(chatId)) {
    users[String(chatId)] = users[String(chatId)] || {}; writeJsonSafe(USERS_FILE, users);
    return safeSendMessage(chatId, "🔐 Admin panel:", adminPanelInline());
  }

  if (text === "📨 Xabar yuborish" && isAdmin(chatId)) {
    users[String(chatId)] = users[String(chatId)] || {};
    users[String(chatId)].waitingForBroadcast = true; writeJsonSafe(USERS_FILE, users);
    return safeSendMessage(chatId, "✍️ Endi yubormoqchi bo'lgan xabaringizni yuboring (text/photo/video/document/audio/voice).", backOnly());
  }

  if (text === "📅 Bugungi jadval") { await sendDaySchedule(chatId, getTodayDay()); return; }
  if (text === "📅 Ertangi jadval") { await sendDaySchedule(chatId, getTomorrowDay()); return; }
  if (text === "📆 Haftalik jadval") {
    for (const d of ["Dushanba","Seshanba","Chorshanba","Payshanba","Juma","Shanba","Yakshanba"]) {
      if ((d === "Shanba" || d === "Yakshanba") && (!Array.isArray(scheduleData[d]) || scheduleData[d].length === 0)) continue;
      await sendDaySchedule(chatId, d);
    }
    return;
  }
  if (text === "⏰ Eslatma vaqtini sozlash") {
    users[String(chatId)].waitingForTime = true; writeJsonSafe(USERS_FILE, users);
    return safeSendMessage(chatId, "⏰ Vaqtni `HH:MM` formatda yuboring (masalan: 07:30).", { parse_mode: "Markdown", ...backOnly() });
  }

  // Fallback: show main menu
  return safeSendMessage(chatId, "📋 Iltimos menyudan tanlang:", mainMenuInline(chatId));
});

// ----------------- On startup notify admins -----------------
for (const a of ADMIN_IDS) {
  if (!isNaN(a)) safeSendMessage(a, "✅ Bot ishga tushdi. Admin panelga kirish uchun menyudan '🔐 Admin panel' ni tanlang.", mainMenuInline(a));
}

console.log("✅ Bot ishga tushdi.");
