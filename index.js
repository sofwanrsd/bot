const dotenv = require("dotenv");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const moment = require("moment-timezone");
require("./setting.js");
const path = require("path");
const archiver = require("archiver");
const cron = require("node-cron");

// Load file
const premiumMedia = require("./function/premiumMedia.js");
const { mutasiPremium } = premiumMedia;
const dinamis = require("./function/dinamis.js");
const { qrisDinamis } = dinamis;

const crypto = require("crypto");
const toMs = require("ms");

// === DEBUG LOGGER ===
const logPath = path.join(__dirname, "logs", "debug.log");
fs.mkdirSync(path.dirname(logPath), { recursive: true });
function logDebug(...args) {
  const line = `[${moment()
    .tz("Asia/Jakarta")
    .format("DD/MM HH:mm:ss")}] ${args.join(" ")}\n`;
  console.log(...args);
  fs.appendFileSync(logPath, line);
}

dotenv.config();
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN belum diisi di file .env");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
console.log("🤖 Taveve Telegram BOT aktif...");
console.log(
  `🕒 Waktu: ${moment().tz("Asia/Jakarta").format("DD/MM/YYYY HH:mm:ss")}`
);

const { Low, JSONFile } = require("lowdb");

(async () => {
  const file = "./options/database.json";
  const adapter = new JSONFile(file);
  const mydb = new Low(adapter);

  await mydb.read();

  if (mydb.data && mydb.data.data) {
    global.db = mydb.data.data;
  } else {
    global.db = mydb.data || {};
  }

  // pastikan struktur dasar
  if (!global.db.produk) global.db.produk = {};
  if (!global.db.user) global.db.user = {};
  if (!global.db.transaksi) global.db.transaksi = [];
  if (!global.db.list) global.db.list = [];
  if (!global.db.testi) global.db.testi = [];
  if (!global.db.premium)
    global.db.premium = { username: "", authToken: "", id: "" };
  if (!global.db.order) global.db.order = {};

  // === Fungsi Simpan Database (VERSI AMAN & FINAL) ===
  let isSaving = false;
  let saveQueued = false;

  async function saveDb() {
    if (isSaving) {
      // Jika sedang menyimpan, tandai request save baru, dan return
      saveQueued = true;
      logDebug("🔄 SaveDb sedang berjalan, request disimpan dalam queue...");
      return;
    }

    isSaving = true;
    try {
      mydb.data = { data: global.db };
      await mydb.write();
    } catch (err) {
      console.error("❌ Gagal menyimpan database:", err);
    } finally {
      isSaving = false;

      // Jika ada request save yang tertunda, jalankan lagi
      if (saveQueued) {
        saveQueued = false;
        logDebug("🔁 Menjalankan saveDb dari queue...");
        await saveDb(); // rekursif aman karena flag dikontrol
      }
    }
  }
  // auto-save tiap 10 detik
  setInterval(async () => await saveDb(), 10000);
  console.log("✅ Database terhubung ke options/database.json");

  // lanjutkan inisialisasi bot di sini...
  // (tempel semua perintah bot di dalam blok async ini)

  // ==============================
  // FUNGSI BANTUAN UMUM
  // ==============================

  // ==============================
  // INISIALISASI KODE UNIK TRACKING
  // ==============================
  if (!global.recentKodeUnik) global.recentKodeUnik = [];
  if (!global.usedKodeUnik) global.usedKodeUnik = new Set();
  if (!global.kodeUnikExpiry) global.kodeUnikExpiry = new Map();

  // Cleanup otomatis kode unik expired (tiap 1 menit)
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;

    for (const [code, expiry] of global.kodeUnikExpiry.entries()) {
      if (now > expiry) {
        global.usedKodeUnik.delete(code);
        global.kodeUnikExpiry.delete(code);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logDebug(`🧹 Cleanup ${cleaned} kode unik expired`);
    }
  }, 60 * 1000);

  function deleteFileIfExists(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logDebug(`🗑 File QRIS dihapus: ${filePath}`);
      }
    } catch (err) {
      logDebug(`⚠ Gagal hapus file QRIS: ${err.message}`);
    }
  }

  const getUserName = (msg) =>
    msg.from.username || msg.from.first_name || "User";

  function toNumber(x) {
    if (typeof x === "string") x = x.replace(/[^\d.-]/g, ""); // hilangkan simbol Rupiah, koma, dll
    const n = Number(x);
    return isNaN(n) ? 0 : n;
  }

  function toRupiah(angka) {
    if (!angka && angka !== 0) return "0";
    const number = toNumber(angka);
    if (isNaN(number)) return angka;
    return number.toLocaleString("id-ID");
  }

  async function withTimeout(promise, ms) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Timeout")), ms);
    });
    return Promise.race([promise, timeout]).finally(() =>
      clearTimeout(timeoutId)
    );
  }

  async function sendLongMessage(bot, chatId, text, opts = {}) {
    const parts = text.match(/[\s\S]{1,4000}/g) || [];
    for (const part of parts) {
      await bot.sendMessage(chatId, part, opts);
    }
  }

  function profitEach(rec) {
    // Ambil profit dari record transaksi
    // Kalau gak ada, anggap 0
    return rec?.profit ? toNumber(rec.profit) : 0;
  }

  function runtime(seconds) {
    seconds = toNumber(seconds);
    var d = Math.floor(seconds / (3600 * 24));
    var h = Math.floor((seconds % (3600 * 24)) / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = Math.floor(seconds % 60);
    var dDisplay = d > 0 ? d + " hari, " : "";
    var hDisplay = h > 0 ? h + " jam, " : "";
    var mDisplay = m > 0 ? m + " menit, " : "";
    var sDisplay = s > 0 ? s + " detik" : "";
    return dDisplay + hDisplay + mDisplay + sDisplay;
  }

  bot.onText(/^\/menu$/, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from.username || msg.from.first_name;
    const teks = global.menu("/", user, user);

    const parts = teks.match(/[\s\S]{1,4000}/g);
    for (const part of parts) {
      await bot.sendMessage(chatId, part, { parse_mode: "HTML" });
    }
  });

  bot.onText(/^\/allmenu$/, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from.username || msg.from.first_name;
    const teks = global.allmenu("/", user, user);

    const parts = teks.match(/[\s\S]{1,4000}/g);
    for (const part of parts) {
      await bot.sendMessage(chatId, part, { parse_mode: "HTML" });
    }
  });

  bot.onText(/^\/infobot$/, (msg) => {
    const chatId = msg.chat.id;
    const teks =
      `🤖 ${global.botName} Info\n\n` +
      `🧑‍💻 Owner: ${global.ownerName}\n` +
      `📞 Contact: ${global.ownerNomer}\n` +
      `📆 Aktif Sejak: ${moment()
        .tz("Asia/Jakarta")
        .format("DD MMMM YYYY")}\n` +
      `🕒 Waktu Lokal: ${moment().tz("Asia/Jakarta").format("HH:mm:ss")}`;
    bot.sendMessage(chatId, teks, { parse_mode: "HTML" });
  });

  // /stok
  bot.onText(/^\/(stok|stock)$/, async (msg) => {
    const chatId = msg.chat.id;
    const prefix = "/";
    const data = global.db;

    if (Object.keys(data.produk).length === 0)
      return bot.sendMessage(chatId, "Belum ada produk di database.");

    let teks = `╭────〔 PRODUCT LIST📦 〕─ 
┊・ Cara membeli produk ketik perintah berikut
┊・ ${prefix}buy kodeproduk jumlah
┊・ Contoh: ${prefix}buy netflix 2
┊・ Pastikan kode dan jumlah akun sudah benar
┊・ Kontak Admin: @${global.ownerNomer}
╰┈┈┈┈┈┈┈┈\n\n`;

    Object.keys(data.produk).forEach((i) => {
      const p = data.produk[i];
      teks += `╭──〔 ${p.name} 〕─
┊・ 🔐| Kode: ${p.id}
┊・ 🏷️| Harga: Rp${p.price.toLocaleString("id-ID")}
┊・ 📦| Stok Tersedia: ${p.stok.length}
┊・ 🧾| Stok Terjual: ${p.terjual}
┊・ 📝| Desk: ${p.desc}
┊・ ✍️| Ketik: ${prefix}buy ${p.id} 1
╰┈┈┈┈┈┈┈┈\n\n`;
    });

    // === Pecah jadi bagian < 4000 karakter agar aman ===
    const parts = teks.match(/[\s\S]{1,4000}/g) || [];
    for (const part of parts) {
      await bot.sendMessage(chatId, part, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    }
  });

  // /stokbycode
  bot.onText(/^\/(stokbycode|stockbycode)(?: (.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const prefix = "/";
    const data = global.db;

    if (Object.keys(data.produk).length === 0)
      return bot.sendMessage(chatId, "Belum ada produk di database.");

    const keyword = (match[2] || "").toLowerCase();
    const entries = Object.values(data.produk)
      .filter(
        (p) =>
          !keyword ||
          p.id.toLowerCase().includes(keyword) ||
          (p.name || "").toLowerCase().includes(keyword)
      )
      .sort((a, b) => a.id.localeCompare(b.id));

    if (entries.length === 0)
      return bot.sendMessage(
        chatId,
        "Produk tidak ditemukan. Coba kata kunci lain."
      );

    let teks = `╭────〔 LIST STOK BY CODE 〕─\n`;
    for (const p of entries) {
      const stokCount = Array.isArray(p.stok) ? p.stok.length : 0;
      teks += `┊ \`${p.id}\`  |  ${p.name}  →  ${stokCount} stok\n`;
    }
    teks += `╰┈┈┈┈┈┈┈┈\n\n`;
    teks += `📌 Panduan Order 📌\n`;
    teks += `> 🔎 Ketik *list* untuk melihat harga dan detail produk.\n`;
    teks += `⚡ Cara Order Cepat:\n`;
    teks += `> ${prefix}buy <id> <jumlah>\n`;
    teks += `> Contoh: ${prefix}buy canva1b 2\n`;

    bot.sendMessage(chatId, teks, { parse_mode: "HTML" });
  });

  bot.onText(/^\/addproduk (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const q = match[1];
    const prefix = "/";
    const data = global.db;

    // ✅ hanya owner yang bisa akses
    if (!global.owner.includes(String(msg.from.id)))
      return bot.sendMessage(chatId, global.mess.owner);

    // 📘 contoh penggunaan
    const EXAMPLE =
      `${prefix}addproduk id|namaproduk|deskripsi|snk|harga|profit|aktif_hari\n` +
      `atau\n` +
      `${prefix}addproduk id|namaproduk|deskripsi|snk|harga|profit|aktif_hari_min|aktif_hari_max`;

    // 🧩 parsing data
    const d = (q || "").split("|").map((s) => (s ?? "").trim());
    if (d.length < 6)
      return bot.sendMessage(
        chatId,
        `⚠️ Format kurang lengkap!\n\nContoh:\n${EXAMPLE}`
      );

    const [pid, pname, pdesc, psnk, phargaRaw, pprofitRaw, pDur1, pDur2] = d;

    // 🧠 validasi data
    if (!pid || !pname || !phargaRaw || !pprofitRaw)
      return bot.sendMessage(
        chatId,
        `⚠️ Ada field wajib yang kosong!\n\n${EXAMPLE}`
      );

    const pharga = toNumber(phargaRaw);
    const pprofit = toNumber(pprofitRaw);
    if (isNaN(pharga) || isNaN(pprofit))
      return bot.sendMessage(chatId, "❌ Harga dan profit harus berupa angka.");

    if (isNaN(pharga) || pharga <= 0)
      return bot.sendMessage(chatId, "❌ Harga harus lebih dari 0");

    if (isNaN(pprofit) || pprofit < 0)
      return bot.sendMessage(chatId, "❌ Profit harus angka positif atau 0");

    if (data.produk[pid])
      return bot.sendMessage(
        chatId,
        `⚠️ Produk dengan ID ${pid} sudah ada di database.`
      );

    // 📆 atur durasi aktif
    let aktifHari = toNumber(pDur1) || null;
    let aktifHariMin = null;
    let aktifHariMax = null;

    if (pDur2) {
      aktifHariMin = toNumber(pDur1);
      aktifHariMax = toNumber(pDur2);
    }

    // 🧱 buat objek produk baru
    const newProduk = {
      id: pid,
      name: pname,
      desc: pdesc || "-",
      snk: psnk || "-",
      price: pharga,
      profit: pprofit,
      stok: [],
      terjual: 0,
      aktif_hari: aktifHari,
      aktif_hari_min: aktifHariMin,
      aktif_hari_max: aktifHariMax,
    };

    // 📝 simpan ke database
    data.produk[pid] = newProduk;
    try {
      await saveDb();
      await bot.sendMessage(
        chatId,
        `✅ Produk baru berhasil ditambahkan!\n\n📦 ID: ${pid}\n🛍️ Nama: ${pname}\n💰 Harga: Rp${toRupiah(
          pharga
        )}\n💵 Profit: Rp${toRupiah(pprofit)}\n📅 Durasi: ${
          pDur2 ? `${pDur1}–${pDur2}` : aktifHari || "-"
        } hari\n\nDeskripsi:\n${pdesc || "-"}`
      );
    } catch (err) {
      console.error("Gagal menyimpan produk:", err);
      await bot.sendMessage(
        chatId,
        "❌ Gagal menyimpan ke database. Coba lagi nanti."
      );
    }
  });

  bot.onText(/^\/delproduk (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const q = match[1];
    const data = global.db;

    if (!global.owner.includes(String(msg.from.id)))
      return bot.sendMessage(chatId, global.mess.owner);

    if (!q) return bot.sendMessage(chatId, `Contoh: /delproduk idproduk`);
    if (!data.produk[q])
      return bot.sendMessage(
        chatId,
        `Produk dengan ID ${q} tidak ada di database.`,
        { parse_mode: "HTML" }
      );

    delete data.produk[q];
    await saveDb();

    bot.sendMessage(chatId, `✅ Berhasil delete produk ${q}`, {
      parse_mode: "HTML",
    });
  });

  // /setharga id|harga
  bot.onText(/^\/setharga (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const q = match[1];
    const data = q.split("|");
    const senderId = String(msg.from.id);
    if (!global.owner.includes(senderId))
      return bot.sendMessage(chatId, global.mess.owner);

    if (!data[1])
      return bot.sendMessage(chatId, `Contoh: /setharga idproduk|harga`);
    if (!global.db.produk[data[0]])
      return bot.sendMessage(
        chatId,
        `Produk dengan ID ${data[0]} tidak ada di database`,
        { parse_mode: "HTML" }
      );

    global.db.produk[data[0]].price = toNumber(data[1]);
    await saveDb();
    bot.sendMessage(
      chatId,
      `✅ Berhasil set harga produk ${data[0]} menjadi Rp${toNumber(
        data[1]
      ).toLocaleString("id-ID")}`,
      { parse_mode: "HTML" }
    );
  });

  bot.onText(/^\/setjudul (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const q = match[1];
    const data = q.split("|");
    const senderId = String(msg.from.id);
    if (!global.owner.includes(senderId))
      return bot.sendMessage(chatId, global.mess.owner);

    if (!data[1])
      return bot.sendMessage(chatId, `Contoh: /setjudul idproduk|judulbaru`);
    if (!global.db.produk[data[0]])
      return bot.sendMessage(
        chatId,
        `Produk dengan ID *${data[0]}* tidak ada di database`,
        { parse_mode: "HTML" }
      );

    global.db.produk[data[0]].name = data[1];
    await saveDb();
    bot.sendMessage(
      chatId,
      `✅ Berhasil set judul produk *${data[0]}* menjadi *${data[1]}*`,
      { parse_mode: "HTML" }
    );
  });

  bot.onText(/^\/setdesk (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const q = match[1];
    const data = q.split("|");
    const senderId = String(msg.from.id);
    if (!global.owner.includes(senderId))
      return bot.sendMessage(chatId, global.mess.owner);

    if (!data[1])
      return bot.sendMessage(chatId, `Contoh: /setdesk idproduk|deskripsi`);
    if (!global.db.produk[data[0]])
      return bot.sendMessage(
        chatId,
        `Produk dengan ID *${data[0]}* tidak ada di database`,
        { parse_mode: "HTML" }
      );

    global.db.produk[data[0]].desc = data[1];
    await saveDb();
    bot.sendMessage(chatId, `✅ Berhasil set deskripsi produk *${data[0]}*`, {
      parse_mode: "HTML",
    });
  });

  bot.onText(/^\/setsnk (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const q = match[1];
    const data = q.split("|");
    const senderId = String(msg.from.id);
    if (!global.owner.includes(senderId))
      return bot.sendMessage(chatId, global.mess.owner);

    if (!data[1])
      return bot.sendMessage(chatId, `Contoh: /setsnk idproduk|snkbaru`);
    if (!global.db.produk[data[0]])
      return bot.sendMessage(
        chatId,
        `Produk dengan ID *${data[0]}* tidak ada di database`,
        { parse_mode: "HTML" }
      );

    global.db.produk[data[0]].snk = data[1];
    await saveDb();
    bot.sendMessage(chatId, `✅ Berhasil set SNK produk *${data[0]}*`, {
      parse_mode: "HTML",
    });
  });

  bot.onText(/^\/setprofit (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const q = match[1];
    const data = q.split("|");
    const senderId = String(msg.from.id);
    if (!global.owner.includes(senderId))
      return bot.sendMessage(chatId, global.mess.owner);

    if (!data[1])
      return bot.sendMessage(chatId, `Contoh: /setprofit idproduk|profit`);
    if (!global.db.produk[data[0]])
      return bot.sendMessage(
        chatId,
        `Produk dengan ID *${data[0]}* tidak ada di database`,
        { parse_mode: "HTML" }
      );

    global.db.produk[data[0]].profit = toNumber(data[1]);
    await saveDb();
    bot.sendMessage(chatId, `✅ Berhasil set profit produk *${data[0]}*`, {
      parse_mode: "HTML",
    });
  });

  bot.onText(/^\/setkode (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const q = match[1];
    const data = q.split("|");
    const senderId = String(msg.from.id);
    if (!global.owner.includes(senderId))
      return bot.sendMessage(chatId, global.mess.owner);

    if (!data[1])
      return bot.sendMessage(chatId, `Contoh: /setkode idlama|idbaru`);
    if (!global.db.produk[data[0]])
      return bot.sendMessage(
        chatId,
        `Produk dengan ID *${data[0]}* tidak ada di database`,
        { parse_mode: "HTML" }
      );

    global.db.produk[data[1]] = { ...global.db.produk[data[0]], id: data[1] };
    delete global.db.produk[data[0]];
    await saveDb();
    bot.sendMessage(
      chatId,
      `✅ Berhasil ubah kode produk dari *${data[0]}* menjadi *${data[1]}*`,
      { parse_mode: "HTML" }
    );
  });

  bot.onText(/^\/addstok([\s\S]*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const fromId = String(msg.from.id);

    // Pastikan hanya owner
    if (!global.owner.includes(fromId))
      return bot.sendMessage(chatId, global.mess.owner);

    // Ambil seluruh teks setelah /addstok (termasuk newline)
    const raw = (match[1] || "").trim();

    // Pisahkan id produk dan isi stok
    const firstComma = raw.indexOf(",");
    if (firstComma === -1)
      return bot.sendMessage(
        chatId,
        `⚠️ Format salah!\n\nContoh:\n/addstok idproduk,email1|pass1|profil1|pin1|note1\nemail2|pass2|profil2|pin2|note2`,
        { parse_mode: "HTML" }
      );

    const id = raw.slice(0, firstComma).trim();
    const stokText = raw.slice(firstComma + 1).trim();

    const prod = global.db.produk?.[id];
    if (!prod)
      return bot.sendMessage(
        chatId,
        `Produk dengan ID *${id}* tidak ditemukan.`,
        {
          parse_mode: "HTML",
        }
      );

    // Pisahkan berdasarkan newline (\r, \n, atau \r\n)
    const stokBaru = stokText
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x.length > 0);

    if (stokBaru.length === 0)
      return bot.sendMessage(
        chatId,
        `⚠️ Tidak ada data stok yang valid.\n\nContoh:\n/addstok idproduk,email1|pass1|profil1|pin1|note1\nemail2|pass2|profil2|pin2|note2`,
        { parse_mode: "HTML" }
      );

    prod.stok.push(...stokBaru);
    await saveDb();

    bot.sendMessage(
      chatId,
      `✅ Berhasil menambah ${stokBaru.length} stok ke produk *${prod.name}*`,
      { parse_mode: "HTML" }
    );
  });

  bot.onText(/^\/getstok (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const fromId = msg.from.id?.toString();
    const q = match[1];
    const prefix = "/";
    const data = global.db;

    // Cek owner
    if (!global.owner.includes(fromId))
      return bot.sendMessage(chatId, global.mess.owner);

    // Validasi input
    const [idProduk, jumlahStr] = (q || "").split("|").map((x) => x.trim());
    if (!jumlahStr)
      return bot.sendMessage(
        chatId,
        `Contoh: ${prefix}getstok idproduk|jumlah`
      );

    const produk = data.produk[idProduk];
    if (!produk)
      return bot.sendMessage(
        chatId,
        `Produk dengan ID *${idProduk}* tidak ada.`,
        {
          parse_mode: "HTML",
        }
      );
    if (produk.stok.length <= 0)
      return bot.sendMessage(chatId, `❌ Stok habis untuk produk ini.`);
    if (produk.stok.length < toNumber(jumlahStr))
      return bot.sendMessage(
        chatId,
        `⚠️ Stok tersedia hanya ${produk.stok.length}, jumlah melebihi stok.`,
        { parse_mode: "HTML" }
      );

    // Ambil data stok
    const jumlah = toNumber(jumlahStr);
    const dataStok = [];
    for (let i = 0; i < jumlah; i++) dataStok.push(produk.stok.shift());
    produk.terjual += jumlah;

    // Generate transaksi
    const reffId = crypto.randomBytes(5).toString("hex").toUpperCase();
    const harga = toNumber(produk.price);
    const totalBayar = harga * jumlah;
    const tanggal = moment().tz("Asia/Jakarta").format("DD/MM/YYYY");
    const jamwib = moment().tz("Asia/Jakarta").format("HH:mm");

    // === Pesan pertama: akun + transaksi
    let akunTeks = `*───「 ACCOUNT DETAIL 」───*\n`;
    dataStok.forEach((i, idx) => {
      const a = i.split("|");
      akunTeks += `#${idx + 1}\n• Email: ${a[0]}\n• Password: ${
        a[1]
      }\n• Profil: ${a[2] || "-"}\n• Pin: ${a[3] || "-"}\n• Note: ${
        a[4] || "-"
      }\n\n`;
    });

    akunTeks +=
      `*───「 TRANSAKSI DETAIL 」───*\n` +
      `*┊・ 🧾| Reff Id:* ${reffId}\n` +
      `*┊・ 📦| Nama Barang:* ${produk.name}\n` +
      `*┊・ 🏷️| Harga Barang:* Rp${toRupiah(harga)}\n` +
      `*┊・ 🛍️| Jumlah Order:* ${jumlah}\n` +
      `*┊・ 💰| Total Bayar:* Rp${toRupiah(totalBayar)}\n` +
      `*┊・ 📅| Tanggal:* ${tanggal}\n` +
      `*┊・ ⏰| Jam:* ${jamwib} WIB`;

    await bot.sendMessage(chatId, akunTeks, { parse_mode: "HTML" });

    // === Pesan kedua: SNK produk
    if (produk.snk)
      await bot.sendMessage(chatId, `*───「 SNK PRODUK 」───*\n${produk.snk}`, {
        parse_mode: "HTML",
      });

    // === Notifikasi ke owner
    const ownerId = global.owner[0];
    const notifTeks = `Hai Owner 👋\nAda transaksi manual (GET STOK):

*╭────「 TRANSAKSI DETAIL 」───*
*┊・ 🧾| Reff Id:* ${reffId}
*┊・ 👤| User ID:* ${fromId}
*┊・ 📦| Nama Barang:* ${produk.name}
*┊・ 🏷️| Harga Barang:* Rp${toRupiah(harga)}
*┊・ 🛍️| Jumlah Order:* ${jumlah}
*┊・ 💰| Total Bayar:* Rp${toRupiah(totalBayar)}
*┊・ 📅| Tanggal:* ${tanggal}
*┊・ ⏰| Jam:* ${jamwib} WIB
*╰┈┈┈┈┈┈┈┈*

*───「 ACCOUNT DETAIL 」───*
${dataStok
  .map((i, idx) => {
    const a = i.split("|");
    return `#${idx + 1}\n• Email: ${a[0]}\n• Password: ${a[1]}\n• Profil: ${
      a[2] || "-"
    }\n• Pin: ${a[3] || "-"}\n• Note: ${a[4] || "-"}`;
  })
  .join("\n\n")}`;

    await bot.sendMessage(ownerId, notifTeks, { parse_mode: "HTML" });

    // === Catat transaksi ke database
    const win = computeActiveWindowByProduct(produk);
    data.transaksi.push({
      reffId,
      id: idProduk,
      nomor: fromId,
      name: produk.name,
      price: harga,
      jumlah,
      profit: produk.profit,
      status: win.status,
      start: win.start.format("YYYY-MM-DD HH:mm:ss"),
      expire: win.expire ? win.expire.format("YYYY-MM-DD HH:mm:ss") : "",
      sisaHari: win.sisaHari,
      date: moment.tz("Asia/Jakarta").format("YYYY-MM-DD HH:mm:ss"),
    });

    try {
      await saveDb();
    } catch (e) {
      console.log("❌ Gagal menyimpan transaksi:", e);
    }
  });

  // ===== /delstok id =====
  bot.onText(/^\/delstok (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const senderId = String(msg.from.id);
    if (!global.owner.includes(senderId))
      return bot.sendMessage(chatId, global.mess.owner);

    const id = match[1].trim();
    const prod = global.db.produk?.[id];
    if (!prod)
      return bot.sendMessage(
        chatId,
        `Produk dengan ID *${id}* tidak ditemukan.`,
        { parse_mode: "HTML" }
      );

    const len = prod.stok.length;
    prod.stok = [];
    await saveDb();

    bot.sendMessage(
      chatId,
      `🗑️ Berhasil menghapus ${len} stok dari *${prod.name}*`,
      { parse_mode: "HTML" }
    );
  });

  // =====================================
  // CASE BUY - TELEGRAM VERSION (100% sama variabel)
  // =====================================
  function digit() {
    // Menghasilkan biaya admin acak 3 digit
    return Math.floor(Math.random() * 150) + 1;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function computeActiveWindowByProduct(prod) {
    const now = moment().tz("Asia/Jakarta");
    const hasil = {
      status: "aktif",
      start: now.clone(),
      expire: null,
      sisaHari: null,
    };

    // ambil durasi dari produk
    if (prod.aktif_hari) {
      hasil.expire = now.clone().add(prod.aktif_hari, "days");
      hasil.sisaHari = prod.aktif_hari;
    } else if (prod.aktif_hari_min && prod.aktif_hari_max) {
      // kalau produk pakai range hari (misal 25–30 hari)
      const randomDays =
        Math.floor(
          Math.random() * (prod.aktif_hari_max - prod.aktif_hari_min + 1)
        ) + prod.aktif_hari_min;
      hasil.expire = now.clone().add(randomDays, "days");
      hasil.sisaHari = randomDays;
    } else {
      // fallback: 30 hari
      hasil.expire = now.clone().add(30, "days");
      hasil.sisaHari = 30;
    }

    hasil.status = hasil.expire.isAfter(now) ? "aktif" : "expired";
    return hasil;
  }

  function getTanggalJam() {
    return {
      tanggal: moment().tz("Asia/Jakarta").format("DD/MM/YYYY"),
      jamwib: moment().tz("Asia/Jakarta").format("HH:mm"),
    };
  }

  // ==============================
  // RELEASE KODE UNIK (SETELAH TRANSAKSI SELESAI/BATAL)
  // ==============================
  function releaseKodeUnik(kodeUnik, success = false) {
    // Hapus dari active set
    global.usedKodeUnik.delete(kodeUnik);
    global.kodeUnikExpiry.delete(kodeUnik);

    // Jika transaksi BERHASIL, masukkan ke history (block untuk 3 orderan berikutnya)
    if (success) {
      global.recentKodeUnik.unshift(kodeUnik);

      // Keep only last 3
      if (global.recentKodeUnik.length > 3) {
        const released = global.recentKodeUnik.pop();
        logDebug(`♻️ [KODE] Released dari history: ${released}`);
      }
    }

    logDebug(
      `🔓 [KODE] Released: ${kodeUnik} | Success: ${success} | Aktif: ${
        global.usedKodeUnik.size
      } | History: [${global.recentKodeUnik.join(", ")}]`
    );
  }

  // ========================================
  // HANDLE BUY - Premium Media + Kode Unik Aman (anti duplikat)
  // ========================================
  async function handleBuy(bot, msg, idProduk, jumlah) {
    const chatId = msg.chat.id;
    const sender = String(chatId);
    const prefix = "/";
    const { tanggal, jamwib } = getTanggalJam();
    let retryCount = 0;
    const MAX_RETRIES = 40; // 10 menit
    const API_TIMEOUT = 15000;

    function reply(teks) {
      return bot.sendMessage(chatId, teks, { parse_mode: "HTML" });
    }

    // === CEK LOGIN PREMIUM MEDIA ===
    if (
      !global.db.premium?.authToken ||
      !global.db.premium?.username ||
      !global.db.premium?.id
    )
      return reply(
        "⚙️ Server belum login Premium Media.\nSilahkan isi <b>username</b>, <b>authToken</b>, dan <b>id</b> di <code>options/database.json</code>"
      );

    if (global.db.order[sender])
      return reply(
        `Kamu sedang melakukan order lain.\nKetik <b>${prefix}batal</b> untuk membatalkan.`
      );

    const produk = global.db.produk[idProduk];
    if (!produk)
      return reply(`Produk dengan ID <b>${idProduk}</b> tidak ditemukan.`);

    const stok = produk.stok || [];
    if (stok.length < jumlah)
      return reply(`⚠️ Stok tersedia hanya ${stok.length}.`);

    await reply("Sedang membuat QR Code...");

    const harga = toNumber(produk.price);
    const totalHarga = harga * jumlah;

    // ==============================
    // GENERATE KODE UNIK ANTI DUPLIKAT
    // ==============================
    const MAX_ATTEMPTS = 100;
    let kodeUnik;
    let attempts = 0;

    do {
      kodeUnik = Math.floor(Math.random() * 391) + 10;
      attempts++;

      // ✅ CEK 1: Tidak boleh dipakai order aktif
      if (global.usedKodeUnik.has(kodeUnik)) continue;

      // ✅ CEK 2: Tidak boleh di 3 history terakhir
      if (global.recentKodeUnik.includes(kodeUnik)) continue;

      // ✅ Kode aman!
      break;
    } while (attempts < MAX_ATTEMPTS);

    // Safety: jika semua kode terpakai, expand range
    if (attempts >= MAX_ATTEMPTS) {
      logDebug("⚠️ [WARN] Kode unik hampir habis, expand range!");
      kodeUnik = Math.floor(Math.random() * 500) + 10;
    }

    // Tandai sebagai terpakai (aktif)
    global.usedKodeUnik.add(kodeUnik);
    global.kodeUnikExpiry.set(kodeUnik, Date.now() + 15 * 60 * 1000); // 15 menit

    logDebug(
      `🔢 [KODE] Generated: ${kodeUnik} | Aktif: ${
        global.usedKodeUnik.size
      } | History: [${global.recentKodeUnik.join(", ")}]`
    );

    const totalAmount = totalHarga + kodeUnik;

    // ==============================
    // GENERATE QRIS DINAMIS
    // ==============================
    const refId = crypto.randomBytes(5).toString("hex").toUpperCase();
    const nominalKunci = String(Math.floor(totalAmount));

    logDebug("🔧 [DEBUG] Nominal dikirim ke qrisDinamis:", nominalKunci);

    const qrisPath = await qrisDinamis(
      nominalKunci,
      "./options/sticker/qris.png"
    );

    if (!qrisPath || !fs.existsSync(qrisPath)) {
      delete global.db.order[sender];
      return reply("❌ Gagal generate QRIS. Silakan coba lagi.");
    }

    const expire = Date.now() + toMs("10m");
    const formattedExpire = moment(expire).tz("Asia/Jakarta").format("HH:mm");

    // ==============================
    // PESAN PEMBAYARAN
    // ==============================
    const caption =
      `🧾 <b>MENUNGGU PEMBAYARAN</b>\n\n` +
      `🔖 <b>Ref ID:</b> ${refId}\n` +
      `📦 <b>Produk:</b> ${produk.name}\n💰 <b>Harga:</b> Rp${toRupiah(
        harga
      )}\n🧮 <b>Jumlah:</b> ${jumlah}\n` +
      `🔢 <b>Kode Unik:</b> ${kodeUnik}\n💵 <b>Total Bayar:</b> Rp${toRupiah(
        totalAmount
      )}\n\n` +
      `⌛ Bayar sebelum <b>${formattedExpire} WIB</b>\n\n` +
      `Ketik /batal untuk membatalkan.`;

    const message = await bot.sendPhoto(chatId, fs.readFileSync(qrisPath), {
      caption,
      parse_mode: "HTML",
    });

    global.db.order[sender] = {
      id: idProduk,
      jumlah,
      from: chatId,
      key: message.message_id,
      ref: refId,
      kodeUnik,
      qrisPath,
    };

    // ==============================
    // LOOP CEK MUTASI PREMIUM MEDIA
    // ==============================

    const startTime = Date.now();
    const ABSOLUTE_TIMEOUT = 15 * 60 * 1000; // 15 menit maksimal

    while (global.db.order[sender] && retryCount < MAX_RETRIES) {
      if (Date.now() - startTime >= ABSOLUTE_TIMEOUT) {
        logDebug("⏰ Timeout absolut tercapai");
        break;
      }
      await sleep(15 * 1000);
      retryCount++;

      if (Date.now() >= expire) {
        logDebug("⏰ [DEBUG] Pembayaran expired untuk", sender);
        await bot.deleteMessage(chatId, message.message_id).catch(() => {});
        await reply("⚠️ Pembayaran dibatalkan (expired).");
        delete global.db.order[sender];
        deleteFileIfExists(qrisPath);
        releaseKodeUnik(kodeUnik, false); // ❌ EXPIRED
        break;
      }

      try {
        logDebug("🔍 [DEBUG] Mengecek mutasi Premium Media...");
        const res = await withTimeout(
          mutasiPremium(
            global.db.premium.username,
            global.db.premium.authToken,
            global.db.premium.id
          ),
          API_TIMEOUT
        );

        if (res.status !== "success") {
          logDebug(
            `❌ MutasiPremium gagal: status=${res.status}, message=${
              res.message || "unknown"
            }`
          );

          // Jika error autentikasi/token → hentikan saja, beri tahu admin/user
          const msg = (res.message || "").toLowerCase();
          if (msg.includes("token") || msg.includes("auth")) {
            await reply(
              "⚠️ Server Premium Media autentikasi gagal.\nSilakan hubungi admin."
            );
            // Optional: notify owner
            try {
              await bot.sendMessage(
                global.owner[0],
                "⚠️ AUTH ERROR: segera cek token!",
                { parse_mode: "HTML" }
              );
            } catch {}
            delete global.db.order[sender];
            deleteFileIfExists(qrisPath);
            releaseKodeUnik(kodeUnik, false); // ❌ AUTH ERROR
            break;
          }
          continue;
        }

        if (!Array.isArray(res.data)) {
          logDebug(
            `⚠️ MutasiPremium data bukan array: ${JSON.stringify(res.data)}`
          );
          continue;
        }

        const list = res.data;

        // === CEK TRANSAKSI MASUK ===
        const found = list.find((tx) => {
          const nominal = toNumber(tx.amount || tx.nominal || tx.kredit || 0);
          const status = (tx.status || tx.type || tx.jenis || "").toLowerCase();
          const desc = (tx.desc || tx.ket || tx.remark || "").toLowerCase();

          const cocokNominal = Math.abs(nominal - totalAmount) <= 2;
          const cocokStatus = status.includes("in");
          const cocokRef = desc.includes(refId.toLowerCase());

          logDebug(
            `🔸 [DEBUG] TX cek => nominal=${nominal}, status=${status}, desc=${desc}, cocokNominal=${cocokNominal}`
          );

          return cocokNominal && cocokStatus && (cocokRef || true);
        });

        if (!found) {
          logDebug("❌ [DEBUG] Belum ada transaksi masuk cocok:", totalAmount);
          continue;
        }

        // ==============================
        // PEMBAYARAN BERHASIL
        // ==============================
        logDebug(
          "✅ [DEBUG] Transaksi cocok ditemukan:",
          JSON.stringify(found, null, 2)
        );
        await bot.deleteMessage(chatId, message.message_id).catch(() => {});
        await reply("✅ Pembayaran diterima! Data akun sedang diproses...");

        // Race-check stok lagi
        if (stok.length < jumlah) {
          await reply(
            "⚠️ Stok berubah/habis saat proses. Stok Anda akan Dikirimkan manual (chat owner)."
          );
          delete global.db.order[sender];
          deleteFileIfExists(qrisPath);
          releaseKodeUnik(kodeUnik, true); // ✅ BAYAR SUKSES (meski stok habis)
          break;
        }

        const stokOut = [];
        for (let i = 0; i < jumlah; i++) stokOut.push(stok.shift());
        produk.terjual += jumlah;

        const reffId = crypto.randomBytes(5).toString("hex").toUpperCase();

        // === PESAN UNTUK PEMBELI ===
        let akunTeks = `───「 ACCOUNT DETAIL 」───\n\n`;
        stokOut.forEach((s, i) => {
          const [email, pass, profil, pin, note] = s.split("|");
          akunTeks +=
            `#${i + 1}\n` +
            `• Email: ${email}\n` +
            `• Password: ${pass}\n` +
            `• Profil: ${profil || "-"}\n` +
            `• Pin: ${pin || "-"}\n` +
            `• Note: ${note || "-"}\n\n`;
        });

        akunTeks +=
          "───「 TRANSAKSI DETAIL 」───\n" +
          `🧾 Ref ID: ${refId}\n` +
          `📦 Produk: ${produk.name}\n` +
          `💰 Harga: Rp${toRupiah(harga)}\n` +
          `🧮 Jumlah: ${jumlah}\n` +
          `🔢 Kode Unik: ${kodeUnik}\n` +
          `💵 Total Bayar: Rp${toRupiah(totalAmount)}\n` +
          `📅 Tanggal: ${tanggal}\n` +
          `⏰ Jam: ${jamwib} WIB`;

        await bot.sendMessage(chatId, akunTeks.trim(), { parse_mode: "HTML" });
        if (produk.snk) {
          const snkText = `───「 SNK PRODUK 」───\n${produk.snk}`;
          await bot.sendMessage(chatId, snkText, { parse_mode: "HTML" });
        }

        // === PESAN UNTUK OWNER ===
        const ownerText =
          `Hai Owner,\nAda transaksi yang telah dibayar!\n\n` +
          `╭────「 TRANSAKSI DETAIL 」───\n` +
          `┊・ 🧾| Ref ID: ${refId}\n` +
          `┊・ 📮| Pembeli: ${sender}\n` +
          `┊・ 📦| Nama Barang: ${produk.name}\n` +
          `┊・ 🏷️| Harga Barang: Rp${toRupiah(harga)}\n` +
          `┊・ 🛍️| Jumlah Order: ${jumlah}\n` +
          `┊・ 💰| Total Bayar: Rp${toRupiah(totalAmount)}\n` +
          `┊・ 📅| Tanggal: ${tanggal}\n` +
          `┊・ ⏰| Jam: ${jamwib} WIB\n` +
          `╰┈┈┈┈┈┈┈┈\n\n` +
          `───「 ACCOUNT DETAIL 」───\n` +
          stokOut
            .map((s, i) => {
              const [email, pass, profil, pin, note] = s.split("|");
              return (
                `#${i + 1}\n` +
                `• Email: ${email}\n` +
                `• Password: ${pass}\n` +
                `• Profil: ${profil || "-"}\n` +
                `• Pin: ${pin || "-"}\n` +
                `• Note: ${note || "-"}`
              );
            })
            .join("\n\n");

        try {
          await bot.sendMessage(global.owner[0], ownerText, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
          });
        } catch (e) {
          logDebug("⚠️ [DEBUG] Gagal kirim notifikasi owner:", e.message);
        }

        // === SIMPAN TRANSAKSI KE DATABASE ===
        const win = computeActiveWindowByProduct(produk);
        global.db.transaksi.push({
          reffId: reffId,
          id: idProduk,
          nomor: sender,
          price: harga,
          jumlah,
          profit: produk.profit,
          kodeUnik,
          status: win.status,
          start: win.start.format("YYYY-MM-DD HH:mm:ss"),
          expire: win.expire ? win.expire.format("YYYY-MM-DD HH:mm:ss") : "",
          sisaHari: win.sisaHari,
          date: moment().tz("Asia/Jakarta").format("YYYY-MM-DD HH:mm:ss"),
        });

        await saveDb();
        delete global.db.order[sender];
        deleteFileIfExists(qrisPath);
        releaseKodeUnik(kodeUnik, true); // ✅ TRANSAKSI SUKSES

        logDebug("💾 [DEBUG] Transaksi berhasil disimpan ke database.");
        break;
      } catch (err) {
        logDebug(`❌ [DEBUG] Error saat cek mutasi : ${err.message}`);
        logDebug(`⚠️ [DEBUG] Percobaan ke-${retryCount} dari ${MAX_RETRIES}`);

        // Jika sudah mencapai batas pengecekan, hentikan
        if (retryCount >= MAX_RETRIES) {
          await bot.deleteMessage(chatId, message.message_id).catch(() => {});
          await reply(
            "⚠️ <b>Timeout Verifikasi Pembayaran</b>\n\n" +
              "Sistem tidak bisa memverifikasi pembayaran Anda secara otomatis.\n" +
              "Jika Anda sudah melakukan transfer, mohon hubungi admin dengan bukti pembayaran.\n" +
              `Ref ID: <code>${refId}</code>`
          );
          delete global.db.order[sender];
          deleteFileIfExists(qrisPath);
          releaseKodeUnik(kodeUnik, false); // ⏱️ TIMEOUT
          break; // Keluar dari loop
        }

        continue; // Lanjutkan retry berikutnya
      }
    }
    // === SAFETY CHECK SETELAH LOOP ===
    if (retryCount >= MAX_RETRIES && global.db.order[sender]) {
      delete global.db.order[sender];
      deleteFileIfExists(qrisPath);
      releaseKodeUnik(kodeUnik, false); // ❌ FORCE CLEANUP
      logDebug(
        "⚠️ [DEBUG] Order dihapus secara paksa karena mencapai batas retry"
      );
    }
  }

  bot.onText(/^\/buy (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name;

    const args = match[1].split(" ");
    const idProduk = args[0];
    const jumlah = toNumber(args[1]) || 1;

    // 🔍 DEBUG
    logDebug(
      `🛒 [CMD: /buy] User: ${username} | ID: ${userId} | Args: "${match[1]}"`
    );

    // ✅ VALIDASI
    if (jumlah < 1) {
      logDebug(`⚠️ [/buy REJECTED] Jumlah < 1 oleh ${username}`);
      return bot.sendMessage(chatId, "⚠️ Jumlah minimal 1!", {
        parse_mode: "HTML",
      });
    }

    if (jumlah > 50) {
      logDebug(`⚠️ [/buy REJECTED] Jumlah > 50 oleh ${username}`);
      return bot.sendMessage(chatId, "⚠️ Maksimal 50 item per transaksi!", {
        parse_mode: "HTML",
      });
    }

    await handleBuy(bot, msg, idProduk, jumlah);
  });

  // ========================================
  // HANDLE BATAL TRANSAKSI
  // ========================================
  bot.onText(/^\/batal$/, async (msg) => {
    const chatId = msg.chat.id;
    const sender = String(chatId);
    let qrisPath = null; // letakkan di luar try

    try {
      // Cek apakah user punya transaksi aktif
      if (!global.db.order || !global.db.order[sender]) {
        return bot.sendMessage(
          chatId,
          "⚠️ Tidak ada transaksi yang sedang berjalan.",
          {
            parse_mode: "HTML",
          }
        );
      }

      const orderData = global.db.order[sender];
      const qrisPath = orderData.qrisPath || null; // Ambil qrisPath jika ada

      // Hapus pesan QR
      if (orderData.key) {
        await bot.deleteMessage(chatId, orderData.key).catch(() => {});
      }

      // Hapus file QR jika ada
      if (qrisPath) {
        deleteFileIfExists(qrisPath);
      }

      // Ambil kode unik sebelum dihapus
      const kodeUnik = orderData.kodeUnik;

      // Hapus order dari database
      delete global.db.order[sender];

      // Release kode unik
      if (kodeUnik) releaseKodeUnik(kodeUnik, false);

      await bot.sendMessage(chatId, "✅ Transaksi berhasil dibatalkan.", {
        parse_mode: "HTML",
      });

      logDebug(`🔴 Transaksi dibatalkan oleh user ${sender}`);
    } catch (err) {
      logDebug("Error batal transaksi:", err.message);
      await bot.sendMessage(
        chatId,
        "⚠️ Terjadi kesalahan saat membatalkan transaksi.",
        {
          parse_mode: "HTML",
        }
      );
    } finally {
      // Pastikan file QRIS selalu dihapus
      if (qrisPath) deleteFileIfExists(qrisPath);
      if (global.db.order[sender]) delete global.db.order[sender];
    }
  });

  bot.onText(/^\/rekaptotal$/, async (msg) => {
    const chatId = msg.chat.id;
    const sender = String(chatId);

    // Batasi hanya owner
    if (toNumber(sender) !== toNumber(global.ownerNomer))
      return bot.sendMessage(
        chatId,
        "❌ Hanya owner yang bisa pakai perintah ini."
      );

    try {
      const list = Array.isArray(global.db.transaksi)
        ? global.db.transaksi
        : [];
      let qty = 0,
        gross = 0,
        net = 0;

      // Hitung total semua transaksi
      for (const rec of list) {
        const j = Math.max(1, toNumber(rec.jumlah));
        const harga = toNumber(rec.harga_jual ?? rec.price);
        const pEach = profitEach(rec);

        qty += j;
        gross += harga * j;
        net += pEach * j;
      }

      // Kirim hasil rekap ke owner
      const hasil =
        `📊 REKAP TOTAL SEMUA TRANSAKSI\n\n` +
        `- 🛍️ Total Stok Terjual: ${qty}\n` +
        `- 💰 Pendapatan Kotor: Rp${toRupiah(gross)}\n` +
        `- 🧾 Pendapatan Bersih: Rp${toRupiah(net)}`;

      await bot.sendMessage(chatId, hasil, { parse_mode: "HTML" });
    } catch (err) {
      console.error("❌ Error rekap total:", err);
      await bot.sendMessage(chatId, "❌ Gagal membuat rekap total transaksi.");
    }
  });

  bot.onText(/^\/rekapbulanan(?:\s+([\d-]+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const sender = String(chatId);
    const arg = (match[1] || "").trim().toLowerCase();

    if (toNumber(sender) !== toNumber(global.ownerNomer))
      return bot.sendMessage(
        chatId,
        "❌ Hanya owner yang bisa pakai perintah ini."
      );

    try {
      // === Argumen opsional: YYYY-MM atau MM-YYYY
      let startYm = null;
      if (arg) {
        let m = arg.match(/^(\d{4})-(\d{1,2})$/);
        if (m) {
          startYm = `${m[1]}-${String(m[2]).padStart(2, "0")}`;
        } else {
          m = arg.match(/^(\d{1,2})-(\d{4})$/);
          if (m) startYm = `${m[2]}-${String(m[1]).padStart(2, "0")}`;
          else
            return bot.sendMessage(
              chatId,
              `📅 Contoh penggunaan:\n\n` +
                `/rekapbulanan\n` +
                `/rekapbulanan 2025-06\n` +
                `/rekapbulanan 06-2025`,
              { parse_mode: "HTML" }
            );
        }
      }

      const list = Array.isArray(global.db.transaksi)
        ? global.db.transaksi
        : [];
      const agg = {}; // ym -> {qty,gross,net}

      // Helper functions
      const profitEach = (rec) => (rec?.profit ? toNumber(rec.profit) : 0);

      const txDateMoment = (rec) => {
        const d = rec?.date;
        if (!d) return null;
        return moment(d, ["YYYY-MM-DD HH:mm:ss", "YYYY/MM/DD", "DD-MM-YYYY"]);
      };

      const monthLabel = (ym) => {
        const [y, m] = ym.split("-");
        return moment(`${y}-${m}-01`).format("MMMM YYYY");
      };

      // === Loop data transaksi
      for (const rec of list) {
        const m = txDateMoment(rec);
        if (!m || !m.isValid()) continue;
        const ym = m.format("YYYY-MM");
        if (startYm && ym < startYm) continue;

        const j = Math.max(1, toNumber(rec.jumlah));
        const harga = toNumber(rec.harga_jual ?? rec.price);
        const pEach = profitEach(rec);

        if (!agg[ym]) agg[ym] = { qty: 0, gross: 0, net: 0 };
        agg[ym].qty += j;
        agg[ym].gross += harga * j;
        agg[ym].net += pEach * j;
      }

      const months = Object.keys(agg).sort(); // urut kronologis
      if (months.length === 0) {
        return bot.sendMessage(
          chatId,
          startYm
            ? `❌ Tidak ada transaksi sejak ${monthLabel(startYm)}.`
            : `⚠️ Belum ada transaksi untuk direkap.`,
          { parse_mode: "HTML" }
        );
      }

      let totalQty = 0,
        totalGross = 0,
        totalNet = 0;
      const parts = [];

      for (const ym of months) {
        const a = agg[ym];
        totalQty += a.qty;
        totalGross += a.gross;
        totalNet += a.net;

        parts.push(
          `📆 *${monthLabel(ym).toUpperCase()}*\n` +
            `  • Stok Terjual: ${a.qty}\n` +
            `  • Pendapatan Kotor: Rp${toRupiah(a.gross)}\n` +
            `  • Pendapatan Bersih: Rp${toRupiah(a.net)}`
        );
      }

      const footer =
        `\n\n📊 *TOTAL (${monthLabel(months[0])} – ${monthLabel(
          months[months.length - 1]
        )})*\n` +
        `  • Total Stok Terjual: ${totalQty}\n` +
        `  • Total Pendapatan Kotor: Rp${toRupiah(totalGross)}\n` +
        `  • Total Pendapatan Bersih: Rp${toRupiah(totalNet)}`;

      const hasil = parts.join("\n\n") + footer;

      await bot.sendMessage(chatId, hasil, { parse_mode: "HTML" });
    } catch (err) {
      console.error("❌ Error rekapbulanan:", err);
      bot.sendMessage(chatId, "❌ Gagal membuat rekap bulanan.");
    }
  });

  bot.onText(/^\/rekapmingguan$/, async (msg) => {
    const chatId = msg.chat.id;
    const sender = String(chatId);

    if (toNumber(sender) !== toNumber(global.ownerNomer))
      return bot.sendMessage(
        chatId,
        "❌ Hanya owner yang bisa pakai perintah ini."
      );

    try {
      const list = Array.isArray(global.db.transaksi)
        ? global.db.transaksi
        : [];

      if (list.length === 0)
        return bot.sendMessage(chatId, "⚠️ Belum ada transaksi bulan ini.");

      const profitEach = (rec) => (rec?.profit ? toNumber(rec.profit) : 0);

      const now = moment().tz("Asia/Jakarta");
      const currentMonth = now.format("YYYY-MM");

      // ambil transaksi di bulan berjalan aja
      const transaksiBulanIni = list.filter((rec) => {
        const m = moment(rec.date, ["YYYY-MM-DD HH:mm:ss", "YYYY/MM/DD"]);
        return m.isValid() && m.format("YYYY-MM") === currentMonth;
      });

      if (transaksiBulanIni.length === 0)
        return bot.sendMessage(
          chatId,
          `⚠️ Belum ada transaksi untuk bulan *${now.format("MMMM YYYY")}*`,
          { parse_mode: "HTML" }
        );

      // kelompokkan berdasarkan minggu keberapa di bulan ini
      const agg = {}; // weekNum -> {qty,gross,net,range}
      for (const rec of transaksiBulanIni) {
        const d = moment(rec.date, ["YYYY-MM-DD HH:mm:ss", "YYYY/MM/DD"]);
        if (!d.isValid()) continue;

        const weekNum = d.week() - d.clone().startOf("month").week() + 1;
        const startOfWeek = d.clone().startOf("week").format("DD/MM");
        const endOfWeek = d.clone().endOf("week").format("DD/MM");
        const range = `${startOfWeek}–${endOfWeek}`;

        if (!agg[weekNum]) agg[weekNum] = { qty: 0, gross: 0, net: 0, range };
        const j = Math.max(1, toNumber(rec.jumlah));
        const harga = toNumber(rec.harga_jual ?? rec.price);
        const pEach = profitEach(rec);
        agg[weekNum].qty += j;
        agg[weekNum].gross += harga * j;
        agg[weekNum].net += pEach * j;
      }

      // urut minggu
      const weeks = Object.keys(agg)
        .map((n) => toNumber(n))
        .sort((a, b) => a - b);

      // filter hanya sampai minggu saat ini
      const currentWeek = Math.ceil(now.date() / 7);
      const visibleWeeks = weeks.filter((w) => w <= currentWeek);

      if (visibleWeeks.length === 0)
        return bot.sendMessage(chatId, "⚠️ Belum ada transaksi di minggu ini.");

      // susun output
      let totalQty = 0,
        totalGross = 0,
        totalNet = 0;
      const parts = [];

      for (const w of visibleWeeks) {
        const a = agg[w];
        totalQty += a.qty;
        totalGross += a.gross;
        totalNet += a.net;

        parts.push(
          `🗓️ *Minggu ${w}* (${a.range})\n` +
            `  • Stok Terjual: ${a.qty}\n` +
            `  • Pendapatan Kotor: Rp${toRupiah(a.gross)}\n` +
            `  • Pendapatan Bersih: Rp${toRupiah(a.net)}`
        );
      }

      const hasil =
        `📅 *Rekap Mingguan Bulan ${now.format("MMMM YYYY")}*\n\n` +
        parts.join("\n\n") +
        `\n\n📊 *TOTAL SAMPAI MINGGU KE-${currentWeek}:*\n` +
        `  • Total Stok Terjual: ${totalQty}\n` +
        `  • Total Pendapatan Kotor: Rp${toRupiah(totalGross)}\n` +
        `  • Total Pendapatan Bersih: Rp${toRupiah(totalNet)}`;

      await bot.sendMessage(chatId, hasil, { parse_mode: "HTML" });
    } catch (err) {
      console.error("❌ Error rekapmingguan:", err);
      bot.sendMessage(chatId, "❌ Gagal membuat rekap mingguan.");
    }
  });

  bot.onText(/^\/rekapharian$/, async (msg) => {
    const chatId = msg.chat.id;
    const sender = String(chatId);

    if (toNumber(sender) !== toNumber(global.ownerNomer))
      return bot.sendMessage(
        chatId,
        "❌ Hanya owner yang bisa pakai perintah ini."
      );

    try {
      const list = Array.isArray(global.db.transaksi)
        ? global.db.transaksi
        : [];

      if (list.length === 0)
        return bot.sendMessage(
          chatId,
          "⚠️ Belum ada transaksi yang tersimpan."
        );

      const profitEach = (rec) => (rec?.profit ? toNumber(rec.profit) : 0);

      const now = moment().tz("Asia/Jakarta");
      const startOfWeek = now.clone().startOf("isoWeek");
      const endOfWeek = now.clone().endOf("isoWeek");

      // ambil transaksi dalam minggu ini aja
      const transaksiMingguIni = list.filter((rec) => {
        const m = moment(rec.date, ["YYYY-MM-DD HH:mm:ss", "YYYY/MM/DD"]);
        return m.isValid() && m.isBetween(startOfWeek, endOfWeek, "day", "[]");
      });

      if (transaksiMingguIni.length === 0)
        return bot.sendMessage(chatId, "⚠️ Belum ada transaksi minggu ini.");

      // kelompokkan per hari
      const agg = {}; // tgl -> {qty,gross,net}
      for (const rec of transaksiMingguIni) {
        const d = moment(rec.date, ["YYYY-MM-DD HH:mm:ss", "YYYY/MM/DD"]);
        const hari = d.format("dddd, DD MMM");
        if (!agg[hari]) agg[hari] = { qty: 0, gross: 0, net: 0 };
        const j = Math.max(1, toNumber(rec.jumlah));
        const harga = toNumber(rec.harga_jual ?? rec.price);
        const pEach = profitEach(rec);
        agg[hari].qty += j;
        agg[hari].gross += harga * j;
        agg[hari].net += pEach * j;
      }

      // urutkan tanggal
      const sortedDays = Object.keys(agg).sort((a, b) => {
        const da = moment(a, "dddd, DD MMM");
        const db = moment(b, "dddd, DD MMM");
        return da - db;
      });

      // buat hasil
      let totalQty = 0,
        totalGross = 0,
        totalNet = 0;
      const parts = [];

      for (const day of sortedDays) {
        const a = agg[day];
        totalQty += a.qty;
        totalGross += a.gross;
        totalNet += a.net;

        parts.push(
          `📆 *${day}*\n` +
            `  • Stok Terjual: ${a.qty}\n` +
            `  • Pendapatan Kotor: Rp${toRupiah(a.gross)}\n` +
            `  • Pendapatan Bersih: Rp${toRupiah(a.net)}`
        );
      }

      const hasil =
        `📅 *Rekap Harian Minggu Ini*\n` +
        `(${startOfWeek.format("DD MMM")} – ${endOfWeek.format(
          "DD MMM YYYY"
        )})\n\n` +
        parts.join("\n\n") +
        `\n\n📊 *TOTAL MINGGU INI:*\n` +
        `  • Total Stok Terjual: ${totalQty}\n` +
        `  • Total Pendapatan Kotor: Rp${toRupiah(totalGross)}\n` +
        `  • Total Pendapatan Bersih: Rp${toRupiah(totalNet)}`;

      await bot.sendMessage(chatId, hasil, { parse_mode: "HTML" });
    } catch (err) {
      console.error("❌ Error rekapharian:", err);
      bot.sendMessage(chatId, "❌ Gagal membuat rekap harian minggu ini.");
    }
  });

  /* HELPER*/
  // ==============================
  // HELPER: HITUNG STATUS TRANSAKSI (AKTIF / EXPIRED)
  // ==============================
  function computeDisplayWindow(rec, produkObj = {}) {
    const now = moment().tz("Asia/Jakarta");
    let start = moment(rec.start, "YYYY-MM-DD HH:mm:ss");
    let expire = moment(rec.expire, "YYYY-MM-DD HH:mm:ss");

    // fallback kalau tanggal ga valid
    if (!start.isValid()) start = now.clone();
    if (!expire.isValid()) {
      // jika tidak ada expire, hitung dari durasi produk (aktif_hari/min/max)
      const aktifHari = produkObj.aktif_hari
        ? produkObj.aktif_hari
        : produkObj.aktif_hari_min || 0;
      expire = start.clone().add(aktifHari, "days");
    }

    // status
    const status = expire.isAfter(now) ? "aktif" : "expired";

    // sisa hari
    let sisaHari = expire.diff(now, "days");
    if (sisaHari < 0) sisaHari = 0;

    return {
      status,
      startStr: start.format("DD/MM/YYYY HH:mm"),
      expireStr: expire.format("DD/MM/YYYY HH:mm"),
      sisaHari,
    };
  }

  /* EnD HelPer*/

  bot.onText(/^\/(trxaktif|trxexpired)(?:\s+(.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const command = match[1];
    const arg = (match[2] || "").trim().toLowerCase();

    const isOwner = String(chatId) === String(global.ownerNomer);
    if (!isOwner)
      return bot.sendMessage(
        chatId,
        "❌ Hanya owner yang bisa menjalankan perintah ini."
      );

    try {
      const wantExpired = command === "trxexpired";

      // === ARGUMENT PARSING ===
      const perPage = 15;
      let page = 1;
      let sortBySisa = false;
      let sortDir = "asc";

      if (arg) {
        const parts = arg.split(/\s+/).filter(Boolean);
        for (const token of parts) {
          if (/^\d+$/.test(token)) page = Math.max(1, toNumber(token));
          else if (["sisa", "sisahari", "sisa-hari"].includes(token))
            sortBySisa = true;
          else if (token === "asc" || token === "desc") sortDir = token;
        }
      }

      const list = Array.isArray(global.db.transaksi)
        ? global.db.transaksi
        : [];
      const entries = [];

      let aktifCount = 0,
        expiredCount = 0;

      for (const rec of list) {
        const produkObj = global.db.produk?.[rec.id] || {};
        const disp = computeDisplayWindow(rec, produkObj);

        if (disp.status === "aktif") aktifCount++;
        else expiredCount++;
        if (wantExpired ? disp.status !== "expired" : disp.status !== "aktif")
          continue;

        const sisaNum =
          typeof disp.sisaHari === "number"
            ? disp.sisaHari
            : number.POSITIVE_INFINITY;

        // === FORMAT SESUAI CONTOH KAMU ===
        const line =
          `🧾 ReffID: ${rec.reffId || "-"}\n` +
          `👤 Pembeli ID: ${rec.nomor || "-"}\n` +
          `📦 Produk: ${rec.name || rec.id || "-"}\n` +
          `💰 Harga: Rp${toNumber(rec.price ?? 0).toLocaleString("id-ID")}\n` +
          `💵 Profit: Rp${toNumber(rec.profit ?? 0).toLocaleString(
            "id-ID"
          )}\n` +
          `🧮 Jumlah: ${rec.jumlah ?? 1}\n` +
          `📆 Sisa Hari: ${disp.sisaHari} hari\n` +
          `📅 Start: ${disp.startStr || "-"}\n` +
          `⏰ Expire: ${disp.expireStr || "-"}`;

        entries.push({ sisaNum, line });
      }

      if (entries.length === 0) {
        return bot.sendMessage(
          chatId,
          wantExpired
            ? "⚠️ Belum ada transaksi expired."
            : "⚠️ Belum ada transaksi aktif.",
          { parse_mode: "HTML" }
        );
      }

      // === SORTING ===
      if (sortBySisa) {
        entries.sort(
          (a, b) => (a.sisaNum - b.sisaNum) * (sortDir === "asc" ? 1 : -1)
        );
      }

      // === PAGINATION ===
      const totalItems = entries.length;
      const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
      if (page > totalPages) page = totalPages;

      const startIdx = (page - 1) * perPage;
      const pageChunk = entries
        .slice(startIdx, startIdx + perPage)
        .map((e, i) => `📦 #${startIdx + i + 1}\n${e.line}`)
        .join("\n\n");

      const header =
        `📊 *REKAP TRANSAKSI ${wantExpired ? "EXPIRED" : "AKTIF"}*\n` +
        `Total Aktif: ${aktifCount} | Total Expired: ${expiredCount}\n` +
        `Ditampilkan: ${Math.min(
          perPage,
          totalItems - startIdx
        )}/${totalItems}\n` +
        `Halaman ${page}/${totalPages}\n` +
        `Urut: ${
          sortBySisa ? `SisaHari ${sortDir.toUpperCase()}` : "Default"
        }\n` +
        `──────────────────────────────\n\n`;

      const footerNext =
        page < totalPages
          ? `\n\n➡️ Ketik /${command} ${page + 1}${sortBySisa ? " sisa" : ""}${
              sortBySisa && sortDir === "desc" ? " desc" : ""
            } untuk halaman berikutnya.`
          : "";
      const footerHint = `\n\n💡 Tips sort: tambah *sisa* (asc) atau *sisa desc*.\nContoh: */${command} 2 sisa* atau */${command} sisa desc*`;

      const result = header + pageChunk + footerNext + footerHint;
      await bot.sendMessage(chatId, result, { parse_mode: "HTML" });
    } catch (err) {
      console.error("❌ Error trxaktif/expired:", err);
      bot.sendMessage(chatId, "❌ Gagal memproses data transaksi.");
    }
  });

  bot.onText(/^\/setdurasi(?:\s+(.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const q = (match[1] || "").trim();

    const isOwner = String(chatId) === String(global.ownerNomer);
    if (!isOwner)
      return bot.sendMessage(
        chatId,
        "❌ Hanya owner yang bisa menjalankan perintah ini."
      );

    try {
      const prefix = "/";
      const EXAMPLE_HTML =
        `${prefix}setdurasi id|aktif_hari\n` +
        `atau\n` +
        `${prefix}setdurasi id|aktif_hari_min|aktif_hari_max`;

      if (!q)
        return bot.sendMessage(
          chatId,
          `📘 <b>Contoh penggunaan:</b>\n${EXAMPLE_HTML}`,
          { parse_mode: "HTML" }
        );

      const parts = q.split("|").map((s) => (s ?? "").trim());
      const pid = parts[0];
      const v1 = parts[1];
      const v2 = parts[2]; // opsional

      if (!pid || !v1)
        return bot.sendMessage(
          chatId,
          `📘 <b>Contoh penggunaan:</b>\n${EXAMPLE_HTML}`,
          { parse_mode: "HTML" }
        );

      const prod = global.db.produk?.[pid];
      if (!prod)
        return bot.sendMessage(
          chatId,
          `⚠️ Produk dengan ID <b>${pid}</b> tidak ditemukan.`,
          { parse_mode: "HTML" }
        );

      const n1 = toNumber(v1);
      const n2 = toNumber(v2);

      if (!v2) {
        // === Durasi tetap ===
        if (!n1)
          return bot.sendMessage(
            chatId,
            `⚠️ <b>aktif_hari</b> harus berupa angka hari > 0.\n\n<b>Contoh:</b>\n${EXAMPLE_HTML}`,
            { parse_mode: "HTML" }
          );

        prod.aktif_hari = n1;
        delete prod.aktif_hari_min;
        delete prod.aktif_hari_max;

        await saveDb();
        return bot.sendMessage(
          chatId,
          `✅ Durasi produk <b>${prod.name || pid}</b> diperbarui:\n` +
            `• aktif_hari = ${n1} hari\n\n` +
            `💡 Jalankan <code>/trxsync force</code> untuk merapikan transaksi lama.`,
          { parse_mode: "HTML" }
        );
      } else {
        // === Durasi acak (rentang hari) ===
        if (!n1)
          return bot.sendMessage(
            chatId,
            `⚠️ <b>aktif_hari_min</b> harus angka > 0.`,
            {
              parse_mode: "HTML",
            }
          );
        if (v2 !== "" && v2 !== undefined && v2 !== null && !n2)
          return bot.sendMessage(
            chatId,
            `⚠️ <b>aktif_hari_max</b> harus angka > 0 bila diisi.`,
            { parse_mode: "HTML" }
          );
        if (n2 && n2 < n1)
          return bot.sendMessage(
            chatId,
            `⚠️ <b>aktif_hari_max</b> tidak boleh lebih kecil dari <b>aktif_hari_min</b>.`,
            { parse_mode: "HTML" }
          );

        prod.aktif_hari_min = n1;
        if (n2) prod.aktif_hari_max = n2;
        else delete prod.aktif_hari_max;
        delete prod.aktif_hari;

        await saveDb();
        return bot.sendMessage(
          chatId,
          `✅ Durasi produk <b>${prod.name || pid}</b> diperbarui:\n` +
            (n2
              ? `• aktif_hari_min = ${n1} hari\n• aktif_hari_max = ${n2} hari`
              : `• aktif_hari_min = ${n1} hari`),
          { parse_mode: "HTML" }
        );
      }
    } catch (err) {
      console.error("❌ Error setdurasi:", err);
      bot.sendMessage(
        chatId,
        "❌ Terjadi kesalahan saat memperbarui durasi produk."
      );
    }
  });

  // === Command /script atau /sc
  bot.onText(/^\/(script|sc)$/i, async (msg) => {
    const chatId = msg.chat.id;

    const teks =
      `<b>📜 SCRIPT NO ENC + PG ORKUT</b>\n` +
      `Mau beli scriptnya?\n\n` +
      `<b>Contact Person 📞</b>\n` +
      `<a href="https://t.me/WannnAja">t.me/WannAja</a>\n\n` + // ganti ke username Telegram owner kamu
      `<b>💰 Harga</b>\n` +
      `Rp150.000\n\n` +
      `<b>💳 Payment</b>\n` +
      `Qris\n\n` +
      `Sudah termasuk tutorial.\n` +
      `Kalau error difixs ✅\n` +
      `Pasti dapet update code no PG 🔥\n` +
      `Size script ringan ⚡\n` +
      `Anti ngelag/delay 💪`;

    const opts = {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "💬 Chat Owner",
              url: "https://t.me/WannnAja", // ubah ke Telegram owner kamu
            },
          ],
        ],
      },
    };

    await bot.sendMessage(chatId, teks, opts);
  });

  // === Command /owner
  bot.onText(/^\/owner$/i, async (msg) => {
    const chatId = msg.chat.id;

    const ownerName = "👑 Wann";
    const ownerUser = "WannnAja"; // username Telegram kamu
    const waNumber = "6281232729502"; // opsional (bisa dikosongkan)

    const text =
      `<b>${ownerName}</b>\n` +
      `Founder & Developer Taveve Store Bot\n\n` +
      `📞 Telegram: <a href="https://t.me/${ownerUser}">@${ownerUser}</a>` +
      (waNumber
        ? `\n📱 WhatsApp: <a href="https://wa.me/${waNumber}">Klik di sini</a>`
        : "") +
      `\n\nSilakan hubungi jika ada kendala, permintaan fitur, atau kerja sama.`;

    const opts = {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "💬 Chat di Telegram", url: `https://t.me/${ownerUser}` },
            { text: "📱 Chat di WhatsApp", url: `https://wa.me/${waNumber}` },
          ],
        ],
      },
    };

    await bot.sendMessage(chatId, text, opts);
  });

  // === Command /tes atau /runtime
  bot.onText(/^\/(tes|runtime)$/i, async (msg) => {
    const chatId = msg.chat.id;

    // fungsi runtime converter
    function formatRuntime(seconds) {
      const d = Math.floor(seconds / (3600 * 24));
      const h = Math.floor((seconds % (3600 * 24)) / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const parts = [];
      if (d) parts.push(`${d} hari`);
      if (h) parts.push(`${h} jam`);
      if (m) parts.push(`${m} menit`);
      if (s) parts.push(`${s} detik`);
      return parts.join(", ");
    }

    const uptime = formatRuntime(process.uptime());

    const text =
      `✅ <b>STATUS :</b> BOT ONLINE\n` +
      `⏱️ <b>Runtime:</b> ${uptime}\n\n` +
      `Bot aktif & siap menerima perintah.`;

    const opts = {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🛍️ Taveve BOT", url: "https://t.me/tavevestore_bot" },
            { text: "🛍️ Taveve Store", url: "https://t.me/tavevestore" },
            { text: "👑 Owner", url: "https://t.me/WannnAja" },
          ],
        ],
      },
    };

    await bot.sendMessage(chatId, text, opts);
  });

  // === Command /ping
  bot.onText(/^\/ping$/i, async (msg) => {
    const chatId = msg.chat.id;
    const os = require("os");
    const { performance } = require("perf_hooks");

    // === hitung latensi ===
    const start = Date.now();
    await bot.sendChatAction(chatId, "typing"); // Simulasi request
    const end = Date.now();
    const latency = ((end - start) / 1000).toFixed(4);

    // === fungsi konversi byte ke format ram ===
    function formatBytes(bytes) {
      const sizes = ["B", "KB", "MB", "GB", "TB"];
      if (bytes === 0) return "0 B";
      const i = toNumber(Math.floor(Math.log(bytes) / Math.log(1024)), 10);
      return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
    }

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cores = os.cpus().length;
    const hostname = os.hostname();

    const text =
      `🏓 <b>PING TEST</b>\n` +
      `Kecepatan respon: <b>${latency} detik</b>\n\n` +
      `💻 <b>INFO SERVER</b>\n` +
      `• Hostname: <code>${hostname}</code>\n` +
      `• RAM: ${formatBytes(usedMem)} / ${formatBytes(totalMem)}\n` +
      `• CPU: ${cores} core\n\n` +
      `Status: <b>BOT AKTIF ✅</b>`;

    const opts = {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "👑 Owner", url: "https://t.me/WannnAja" },
            { text: "🛍️ Taveve Store", url: "https://t.me/tavevestore" },
          ],
        ],
      },
    };

    await bot.sendMessage(chatId, text, opts);
  });

  function buildListTextAndKeyboard(senderName = "User", page = 1) {
    const produkData = global.db?.produk || {};
    const items = Object.entries(produkData)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    const perPage = 10; // batas per halaman
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    const startIdx = (page - 1) * perPage;
    const pagedItems = items.slice(startIdx, startIdx + perPage);

    if (items.length === 0) {
      return {
        text: "❌ Belum ada produk di database.",
        keyboard: [[{ text: "👑 Owner", url: "https://t.me/WannnAja" }]],
      };
    }

    const now = moment().tz("Asia/Jakarta").format("DD/MM/YYYY HH:mm:ss");
    let teks =
      `👋 Hai <b>${senderName}</b>!\nBerikut daftar produk di <b>TAVEVE STORE</b> 🛍️\n` +
      `⏱ <i>Diperbarui:</i> ${now}\n\n`;

    pagedItems.forEach((p, i) => {
      const stokList = Array.isArray(p.stok) ? p.stok : [];
      const sisa = stokList.length;
      const stokIcon = sisa > 0 ? "🟢" : "🔴";
      teks += `${stokIcon} <b>${startIdx + i + 1}. ${
        p.name
      }</b> (Stok: <b>${sisa}</b>)\n`;
    });

    teks +=
      `\nℹ️ Beberapa produk belum dapat dimasukkan langsung ke bot.\n` +
      `Jika stok sedang kosong, kamu bisa order langsung ke Owner 💬`;

    // buat keyboard nomor + navigasi
    const keyboard = [];
    let row = [];

    pagedItems.forEach((item, i) => {
      row.push({
        text: `${startIdx + i + 1}`,
        callback_data: `detail_${item.id}`,
      });
      if (row.length === 3) {
        keyboard.push(row);
        row = [];
      }
    });
    if (row.length) keyboard.push(row);

    // tombol navigasi
    const navRow = [];
    if (page > 1)
      navRow.push({
        text: "⏮️ Sebelumnya",
        callback_data: `list_page_${page - 1}`,
      });
    if (page < totalPages)
      navRow.push({
        text: "⏭️ Berikutnya",
        callback_data: `list_page_${page + 1}`,
      });
    if (navRow.length) keyboard.push(navRow);

    // tombol bawah
    keyboard.push([
      { text: "🔄 Refresh", callback_data: "refresh_list" },
      { text: "👑 Owner", url: "https://t.me/WannnAja" },
    ]);

    return { text: teks, keyboard };
  }

  bot.onText(/^\/list$/i, async (msg) => {
    const chatId = msg.chat.id;
    const senderName = msg.from.first_name || msg.from.username || "User";
    const { text, keyboard } = buildListTextAndKeyboard(senderName);
    await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // === CALLBACK HANDLER ===
  bot.on("callback_query", async (cq) => {
    const msg = cq.message;
    const data = cq.data || "";
    const chatId = msg.chat.id;
    const mid = msg.message_id;

    // === SHOW LIST DARI /START BUTTON ===
    if (data === "show_list") {
      const senderName = msg.chat?.first_name || msg.chat?.username || "User";
      try {
        const { text, keyboard } = buildListTextAndKeyboard(senderName);
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: mid,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboard },
        });
      } catch (err) {
        console.error("❌ Error show_list:", err);
        await bot.sendMessage(
          chatId,
          "❌ Terjadi kesalahan saat memuat list produk."
        );
      }
      return bot.answerCallbackQuery(cq.id);
    }

    // === REFRESH LIST ===
    if (data === "refresh_list") {
      const senderName = msg.chat?.first_name || msg.chat?.username || "User";
      try {
        const { text, keyboard } = buildListTextAndKeyboard(senderName);
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: mid,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboard },
        });
      } catch (err) {
        console.error("❌ Error refresh_list:", err);
        await bot.sendMessage(chatId, "❌ Gagal memuat ulang list produk.");
      }
      return bot.answerCallbackQuery(cq.id);
    }

    // === PAGINATION (list_page_X) ===
    if (data.startsWith("list_page_")) {
      const page = toNumber(data.replace("list_page_", "")) || 1;
      const senderName = msg.chat?.first_name || msg.chat?.username || "User";

      try {
        const { text, keyboard } = buildListTextAndKeyboard(senderName, page);
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: mid,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboard },
        });
      } catch (err) {
        console.error("❌ Error pagination:", err);
        await bot.sendMessage(
          chatId,
          "❌ Gagal memuat halaman produk berikutnya."
        );
      }
      return bot.answerCallbackQuery(cq.id);
    }

    // === DETAIL PRODUK ===
    if (data.startsWith("detail_")) {
      const pid = data.slice(7);
      const prod = global.db.produk?.[pid];
      if (!prod)
        return bot.answerCallbackQuery(cq.id, {
          text: "❌ Produk tidak ditemukan.",
          show_alert: true,
        });

      const stokList = Array.isArray(prod.stok) ? prod.stok : [];
      const sisa = stokList.length;
      const harga = toNumber(prod.price).toLocaleString("id-ID");

      const teks =
        `📦 <b>DETAIL PRODUK</b>\n━━━━━━━━━━━━━━━\n` +
        `<b>Nama:</b> ${prod.name}\n` +
        `<b>Harga:</b> Rp${harga}\n` +
        `<b>Stok Tersedia:</b> ${sisa}\n\n` +
        (prod.desc ? `📝 <b>Deskripsi:</b>\n${prod.desc}\n\n` : "") +
        (sisa > 0
          ? `🛒 <i>Pilih jumlah yang ingin dibeli:</i>`
          : `⚠️ <i>Stok habis, produk tidak dapat dibeli.</i>`);

      const jumlahAwal = 1;

      // tombol beli hanya muncul jika stok > 0
      const tombolBeli =
        sisa > 0
          ? [
              {
                text: "🛍️ Beli Sekarang",
                callback_data: `buy_${pid}_${jumlahAwal}`,
              },
            ]
          : [];

      await bot.editMessageText(teks, {
        chat_id: chatId,
        message_id: mid,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "➖", callback_data: `qtydec_${pid}_${jumlahAwal}` },
              { text: `🧮 ${jumlahAwal}`, callback_data: "noop" },
              { text: "➕", callback_data: `qtyinc_${pid}_${jumlahAwal}` },
            ],
            ...[tombolBeli].filter(Boolean),
            [{ text: "⬅️ Kembali", callback_data: "back_to_list" }],
          ],
        },
      });
      return bot.answerCallbackQuery(cq.id);
    }

    // === HANDLE TOMBOL TAMBAH / KURANG JUMLAH ===
    if (data.startsWith("qtyinc_") || data.startsWith("qtydec_")) {
      const [_, pid, jmlStr] = data.split("_");
      const prod = global.db.produk?.[pid];
      if (!prod)
        return bot.answerCallbackQuery(cq.id, {
          text: "❌ Produk tidak ditemukan.",
          show_alert: true,
        });

      const stokList = Array.isArray(prod.stok) ? prod.stok : [];
      const sisa = stokList.length;
      let jumlah = parseInt(jmlStr);

      if (sisa <= 0) {
        return bot.answerCallbackQuery(cq.id, {
          text: "⚠️ Produk sedang kehabisan stok.",
          show_alert: true,
        });
      }

      // tombol ➕ ditekan
      if (data.startsWith("qtyinc_")) {
        if (jumlah >= sisa) {
          return bot.answerCallbackQuery(cq.id, {
            text: `⚠️ Jumlah tidak bisa lebih dari stok (${sisa}).`,
            show_alert: true,
          });
        }
        jumlah++;
      }

      // tombol ➖ ditekan
      if (data.startsWith("qtydec_")) {
        if (jumlah <= 1) {
          return bot.answerCallbackQuery(cq.id, {
            text: "⚠️ Minimal pembelian 1 produk.",
            show_alert: true,
          });
        }
        jumlah--;
      }

      const harga = toNumber(prod.price).toLocaleString("id-ID");
      const teks =
        `📦 <b>DETAIL PRODUK</b>\n━━━━━━━━━━━━━━━\n` +
        `<b>Nama:</b> ${prod.name}\n` +
        `<b>Harga:</b> Rp${harga}\n` +
        `<b>Stok Tersedia:</b> ${sisa}\n\n` +
        (prod.desc ? `📝 <b>Deskripsi:</b>\n${prod.desc}\n\n` : "") +
        `🛒 <i>Pilih jumlah yang ingin dibeli:</i>`;

      await bot.editMessageText(teks, {
        chat_id: chatId,
        message_id: mid,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "➖", callback_data: `qtydec_${pid}_${jumlah}` },
              { text: `🧮 ${jumlah}`, callback_data: "noop" },
              { text: "➕", callback_data: `qtyinc_${pid}_${jumlah}` },
            ],
            [
              {
                text: "🛍️ Beli Sekarang",
                callback_data: `buy_${pid}_${jumlah}`,
              },
            ],
            [{ text: "⬅️ Kembali", callback_data: "back_to_list" }],
          ],
        },
      });

      return bot.answerCallbackQuery(cq.id);
    }

    // === HANDLE INPUT JUMLAH CUSTOM ===
    if (data.startsWith("noop")) {
      const row = cq.message.reply_markup?.inline_keyboard?.[0];
      const btn = row?.find((b) => b.callback_data?.startsWith("qtydec_"));
      if (!btn)
        return bot.answerCallbackQuery(cq.id, {
          text: "❌ Gagal membaca data produk.",
          show_alert: true,
        });

      const pidFromBtn = btn.callback_data.split("_")[1];
      const prod = global.db.produk?.[pidFromBtn];
      if (!prod)
        return bot.answerCallbackQuery(cq.id, {
          text: "❌ Produk tidak ditemukan.",
          show_alert: true,
        });

      const stokList = Array.isArray(prod.stok) ? prod.stok : [];
      const sisa = stokList.length;
      if (sisa <= 0)
        return bot.answerCallbackQuery(cq.id, {
          text: "⚠️ Stok produk habis, tidak bisa beli.",
          show_alert: true,
        });

      await bot.answerCallbackQuery(cq.id);
      const ask = await bot.sendMessage(
        chatId,
        "📥 Masukkan jumlah yang ingin dibeli:",
        {
          reply_markup: { force_reply: true },
        }
      );

      bot.once("message", async (rep) => {
        if (
          !rep.reply_to_message ||
          rep.reply_to_message.message_id !== ask.message_id
        )
          return;

        const input = parseInt(rep.text);
        if (isNaN(input) || input < 1)
          return bot.sendMessage(
            chatId,
            "⚠️ Jumlah tidak valid. Harus angka positif."
          );
        if (input > sisa)
          return bot.sendMessage(
            chatId,
            `⚠️ Jumlah melebihi stok tersedia (${sisa}).`
          );

        const harga = toNumber(prod.price).toLocaleString("id-ID");
        const teks =
          `📦 <b>DETAIL PRODUK</b>\n━━━━━━━━━━━━━━━\n` +
          `<b>Nama:</b> ${prod.name}\n` +
          `<b>Harga:</b> Rp${harga}\n` +
          `<b>Stok Tersedia:</b> ${sisa}\n\n` +
          (prod.desc ? `📝 <b>Deskripsi:</b>\n${prod.desc}\n\n` : "") +
          `🛒 <i>Pilih jumlah yang ingin dibeli:</i>`;

        await bot.editMessageText(teks, {
          chat_id: chatId,
          message_id: mid,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "➖", callback_data: `qtydec_${pidFromBtn}_${input}` },
                { text: `🧮 ${input}`, callback_data: "noop" },
                { text: "➕", callback_data: `qtyinc_${pidFromBtn}_${input}` },
              ],
              [
                {
                  text: "🛍️ Beli Sekarang",
                  callback_data: `buy_${pidFromBtn}_${input}`,
                },
              ],
              [{ text: "⬅️ Kembali", callback_data: "back_to_list" }],
            ],
          },
        });
      });

      return;
    }

    // === UBAH JUMLAH (➖ ➕) ===
    if (data.startsWith("qtyinc_") || data.startsWith("qtydec_")) {
      const [type, pid, jumlahStr] = data.split("_");
      let jumlah = toNumber(jumlahStr);
      if (type === "qtyinc") jumlah++;
      if (type === "qtydec" && jumlah > 1) jumlah--;

      const prod = global.db.produk?.[pid];
      if (!prod) return bot.answerCallbackQuery(cq.id);

      const harga = toNumber(prod.price).toLocaleString("id-ID");
      const stokList = Array.isArray(prod.stok) ? prod.stok : [];
      const sisa = stokList.length;
      const teks =
        `📦 <b>DETAIL PRODUK</b>\n━━━━━━━━━━━━━━━\n` +
        `👕 <b>Nama:</b> ${prod.name}\n` +
        `💰 <b>Harga:</b> Rp${harga}\n` +
        `📦 <b>Stok Tersedia:</b> ${sisa}\n\n` +
        (prod.desc ? `📝 <b>Deskripsi:</b>\n${prod.desc}\n\n` : "") +
        `🛒 <i>Pilih jumlah yang ingin dibeli:</i>`;

      await bot.editMessageText(teks, {
        chat_id: chatId,
        message_id: mid,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "➖", callback_data: `qtydec_${pid}_${jumlah}` },
              { text: `🧮 ${jumlah}`, callback_data: "noop" },
              { text: "➕", callback_data: `qtyinc_${pid}_${jumlah}` },
            ],
            [
              {
                text: "🛍️ Beli Sekarang",
                callback_data: `buy_${pid}_${jumlah}`,
              },
            ],
            [{ text: "⬅️ Kembali", callback_data: "back_to_list" }],
          ],
        },
      });
      return bot.answerCallbackQuery(cq.id);
    }

    // === KONFIRMASI PEMBELIAN ===
    if (data.startsWith("buy_")) {
      const [_, pid, jumlahStr] = data.split("_");
      const jumlah = toNumber(jumlahStr);
      const prod = global.db.produk?.[pid];
      if (!prod)
        return bot.answerCallbackQuery(cq.id, {
          text: "Produk tidak ditemukan.",
          show_alert: true,
        });

      const harga = toNumber(prod.price);
      const total = harga * jumlah;
      const teks =
        `🧾 <b>KONFIRMASI PEMBELIAN</b>\n━━━━━━━━━━━━━━━\n` +
        `📦 <b>Produk:</b> ${prod.name}\n` +
        `🔢 <b>Jumlah:</b> ${jumlah}\n` +
        `💰 <b>Harga Satuan:</b> Rp${harga.toLocaleString("id-ID")}\n` +
        `💵 <b>Total Bayar:</b> Rp${total.toLocaleString("id-ID")}\n\n` +
        `Tekan tombol di bawah untuk melanjutkan pembayaran.`;

      await bot.editMessageText(teks, {
        chat_id: chatId,
        message_id: mid,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "💳 Bayar via QRIS",
                callback_data: `qris_${pid}_${jumlah}`,
              },
              { text: "❌ Batal", callback_data: `detail_${pid}` },
            ],
          ],
        },
      });
      return bot.answerCallbackQuery(cq.id);
    }

    // === PEMBAYARAN VIA QRIS ===
    if (data.startsWith("qris_")) {
      const [_, pid, jumlahStr] = data.split("_");
      const jumlah = toNumber(jumlahStr) || 1;
      await handleBuy(bot, { chat: { id: chatId } }, pid, jumlah);
      return;
    }

    // === KEMBALI ===
    if (data === "back_to_list" || data === "refresh_list") {
      const senderName = msg.chat?.first_name || msg.chat?.username || "User";
      const { text, keyboard } = buildListTextAndKeyboard(senderName);
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: mid,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      });
      return bot.answerCallbackQuery(cq.id);
    }

    bot.answerCallbackQuery(cq.id);
  });

  // =======================
  //  BACKUP OTOMATIS & MANUAL (Fix: auto delete)
  // =======================

  async function runBackup(bot, notifyChatId = null) {
    const ownerId = toNumber(global.ownerNomer);
    const isNotify = !!notifyChatId;

    async function say(teks) {
      if (!isNotify) return;
      try {
        await bot.sendMessage(notifyChatId, teks, { parse_mode: "HTML" });
      } catch {}
    }

    await say("🗂️ Mengumpulkan semua file untuk backup...");

    try {
      const exclude = [
        "node_modules",
        "session",
        "package-lock.json",
        "yarn.lock",
        ".npm",
        ".cache",
        ".git",
      ];

      const ts = moment().tz("Asia/Jakarta").format("YYYYMMDD-HHmmss");
      const outputPath = path.join(__dirname, `SC-TAVEVE-BOT-${ts}.zip`);
      const output = fs.createWriteStream(outputPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      // Pastikan kita tunggu file selesai tertutup sebelum lanjut
      const done = new Promise((resolve, reject) => {
        output.on("close", resolve);
        archive.on("error", reject);
      });

      archive.pipe(output);

      // Tambahkan semua file & folder
      const items = fs.readdirSync(__dirname);
      for (const item of items) {
        if (exclude.includes(item)) continue;
        const fullPath = path.join(__dirname, item);
        const stats = fs.statSync(fullPath);
        if (stats.isDirectory()) archive.directory(fullPath, item);
        else archive.file(fullPath, { name: item });
      }

      await say("📦 Membuat file ZIP, mohon tunggu...");
      await archive.finalize();
      await done; // pastikan sudah benar-benar close

      // Kirim ke owner
      const caption =
        `✅ <b>Backup Script TAVEVE BOT</b>\n` +
        `Waktu: ${moment()
          .tz("Asia/Jakarta")
          .format("DD/MM/YYYY HH:mm:ss")} WIB\n` +
        `Size: ${archive.pointer().toLocaleString("id-ID")} bytes`;

      await bot.sendDocument(ownerId, fs.createReadStream(outputPath), {
        caption,
        parse_mode: "HTML",
      });

      await say("✅ Backup berhasil dibuat & dikirim ke Owner!");

      // Tunggu sedikit agar stream kirim selesai, lalu hapus file
      setTimeout(() => {
        try {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
            console.log(
              `🧹 File backup ${path.basename(outputPath)} telah dihapus.`
            );
          }
        } catch (err) {
          console.warn("⚠️ Gagal menghapus file backup:", err.message);
        }
      }, 3000); // delay 3 detik untuk jaga-jaga proses upload Telegram
    } catch (err) {
      console.error("❌ Gagal backup:", err);
      await say("❌ Terjadi kesalahan saat membuat backup ZIP.");
    }
  }

  // ✅ Command manual: /backup
  bot.onText(/^\/backup$/, async (msg) => {
    const chatId = msg.chat.id;
    const sender = String(msg.from.id);
    const isOwner = sender === String(global.ownerNomer);
    if (!isOwner) {
      return bot.sendMessage(
        chatId,
        "❌ Perintah ini hanya bisa dijalankan oleh Owner Bot!",
        { parse_mode: "HTML" }
      );
    }
    await runBackup(bot, chatId);
  });

  // ==============================
  // COMMAND DASAR
  // ==============================

  // ========================================
  // LOG USER SETIAP INTERAKSI
  // ========================================
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.chat.username || "-";
    const first_name = msg.chat.first_name || "-";

    if (!global.db.user[chatId]) {
      global.db.user[chatId] = {
        id: chatId,
        username,
        first_name,
        lastActive: new Date().toISOString(),
      };
      await saveDb();
    } else {
      global.db.user[chatId].lastActive = new Date().toISOString();
    }
  });

  // ========================================
  // BROADCAST TEKS ATAU GAMBAR (FULL VERSION)
  // ========================================
  bot.onText(/^\/broadcast(?:\s+(.+))?/s, async (msg, match) => {
    const chatId = msg.chat.id;
    const sender = String(msg.from.id);

    // cek owner
    if (!global.owner.includes(sender))
      return bot.sendMessage(
        chatId,
        "❌ Hanya Owner yang dapat menggunakan perintah ini."
      );

    // deteksi apakah ada reply ke foto atau cuma teks
    const reply = msg.reply_to_message;
    const isPhotoBroadcast = reply && reply.photo;

    // isi pesan teks
    const text = match[1]?.trim() || "";

    if (!isPhotoBroadcast && !text)
      return bot.sendMessage(
        chatId,
        "⚠️ Format salah.\nGunakan:\n" +
          "`/broadcast teks_pesan`\n\n" +
          "Atau reply ke gambar lalu ketik `/broadcast` untuk broadcast banner + caption.",
        { parse_mode: "HTML" }
      );

    const users = Object.values(global.db.user || {});
    if (users.length === 0)
      return bot.sendMessage(chatId, "❌ Belum ada user terdaftar.");

    await bot.sendMessage(
      chatId,
      `📢 Mengirim broadcast ke ${users.length} pengguna...`,
      {
        parse_mode: "HTML",
      }
    );

    let success = 0;
    let failed = 0;

    // fungsi split teks panjang
    const splitText = (str, len = 4000) => {
      const regex = new RegExp(`.{1,${len}}`, "gs");
      return str.match(regex) || [];
    };

    // fungsi kirim aman
    async function sendBroadcast(userId, content) {
      try {
        if (isPhotoBroadcast) {
          // === broadcast gambar + caption ===
          const fileId = reply.photo.pop().file_id;
          const chunks = splitText(text || reply.caption || "");
          for (let i = 0; i < chunks.length; i++) {
            await bot.sendPhoto(userId, fileId, {
              caption:
                i === 0
                  ? `📢 <b>BROADCAST PESAN</b>\n\n${chunks[i]}`
                  : chunks[i],
              parse_mode: "HTML",
            });
            await new Promise((r) => setTimeout(r, 300));
          }
        } else {
          // === broadcast teks biasa ===
          const chunks = splitText(content);
          for (let i = 0; i < chunks.length; i++) {
            await bot.sendMessage(
              userId,
              `📢 <b>BROADCAST PESAN</b>\n\n${chunks[i]}`,
              { parse_mode: "HTML" }
            );
            await new Promise((r) => setTimeout(r, 300));
          }
        }
        success++;
      } catch (err) {
        failed++;
        if (err.response && err.response.body.error_code === 403) {
          // User block bot, hapus dari database
          delete global.db.user[userId];
          logDebug(`🗑️ User ${userId} removed (blocked bot)`);
        }
      }
    }

    // loop kirim ke semua user
    for (const user of users) {
      await sendBroadcast(user.id, text);
    }

    await bot.sendMessage(
      chatId,
      `✅ Broadcast selesai!\n\n📨 Berhasil: ${success}\n❌ Gagal: ${failed}`,
      { parse_mode: "HTML" }
    );
  });

  // Command /start
  bot.onText(/^\/start$/, async (msg) => {
    const chatId = msg.chat.id;

    const opts = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛍 Lihat List Produk", callback_data: "show_list" }],
        ],
      },
      parse_mode: "HTML",
    };

    bot.sendMessage(
      chatId,
      `Selamat datang di ${global.botName}\nKetik /menu untuk melihat daftar perintah.`,
      opts
    );
  });

  // /id untuk cek user ID Telegram
  bot.onText(/^\/id$/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      `🧩 ID Telegram Kamu: \`${msg.from.id}\`\nGunakan ID ini di setting.js untuk daftar owner.`,
      { parse_mode: "HTML" }
    );
  });

  // ==============================
  // COMMAND SET
  // ==============================

  bot.setMyCommands([
    { command: "start", description: "Mulai bot" },
    { command: "menu", description: "Tampilkan menu utama" },
    { command: "list", description: "Lihat daftar produk" },
    { command: "owner", description: "Hubungi owner" },
  ]);

  // ==============================
  // ERROR HANDLER
  // ==============================

  bot.on("polling_error", (err) => {
    const isConnectionReset = String(err.message).includes("ECONNRESET");
    if (isConnectionReset) {
      console.log("⚠️ Koneksi Telegram terputus, mencoba reconnect...");
    } else {
      console.error("Polling error:", err.message);
    }
  });

  // =======================
  // AUTO BACKUP SETIAP 00:00 WIB
  // =======================
  cron.schedule(
    "39 13 * * *", // setiap jam 00:00
    async () => {
      try {
        console.log("[CRON] Menjalankan auto-backup harian (00:00 WIB)...");
        await runBackup(bot); // kirim langsung ke owner
      } catch (e) {
        console.error("[CRON] Gagal auto-backup:", e);
      }
    },
    { timezone: "Asia/Jakarta" }
  );
})();
