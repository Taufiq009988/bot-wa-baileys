import {
  makeWASocket,
  delay,
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
} from "@itsliaaa/baileys";
import pino from "pino";
import fs from "fs";
import path from "path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import cron from "node-cron";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// =========================================================================
// DEKLARASI KONSTANTA & INISIALISASI UTAMA
// =========================================================================
const DB_FILE = "./PasienPasienDB.json";
const MEDIA_DIR = "./media";
const myPhoneNumber = "6289523625059";
const JID_GRUP_STAF = "120363411876684007@g.us";

// Nomor-nomor yang diizinkan mengakses perintah bot (format tanpa '+')
const ALLOWED_NUMBERS = ["98626089009193"];

const logger = pino({ level: "silent" });
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // Timeout otomatis 15 menit jika idle

if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

const CATEGORIES_MAP = {
  1: "Muka",
  2: "Mata",
  3: "Hidung",
  4: "Telinga",
  5: "Kaki",
  6: "Nafas",
  7: "Luka",
  8: "Testis",
  9: "Paw",
};

// =========================================================================
// HELPER UTILITAS DATABASE & FORMATTING
// =========================================================================
const loadData = () => {
  if (!fs.existsSync(DB_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  } catch (e) {
    return [];
  }
};

let isPethotel = false;
const saveData = (data) => {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("❌ Gagal menyimpan data ke database:", err);
  }
};

async function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (err) {
    console.error(`❌ Gagal menghapus file: ${filePath}`, err);
  }
}

const userSessions = {};
let PasienPasienDB = loadData();

// Management Session Pengguna dengan Auto-Timeout
const setSession = (jid, step, data = {}) => {
  if (userSessions[jid]?.timeout) {
    clearTimeout(userSessions[jid].timeout);
  }
  const timeout = setTimeout(() => {
    delete userSessions[jid];
  }, SESSION_TIMEOUT_MS);

  userSessions[jid] = { step, data, timeout };
};

const clearSession = (jid) => {
  if (userSessions[jid]?.timeout) {
    clearTimeout(userSessions[jid].timeout);
  }
  delete userSessions[jid];
};

function clearMediaFolder() {
  try {
    if (fs.existsSync(MEDIA_DIR)) {
      const files = fs.readdirSync(MEDIA_DIR);
      for (const file of files) {
        if (file.startsWith(".")) continue;
        const filePath = path.join(MEDIA_DIR, file);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
      console.log("🗑️ [RESET] Semua file di folder media berhasil dihapus.");
    }
  } catch (err) {
    console.error("❌ Gagal menghapus file di folder media:", err);
  }
}

function resetDailyTreatments() {
  try {
    if (Array.isArray(PasienPasienDB)) {
      PasienPasienDB.forEach((Pasien) => {
        Pasien.treatments = [];
        Pasien.reportSent = false;
      });
      saveData(PasienPasienDB);
      console.log(
        "🔄 [RESET] Data treatment seluruh Pasien telah dikosongkan untuk hari baru.",
      );
    }
  } catch (err) {
    console.error("❌ Gagal mereset data treatment:", err);
  }
}

function getSesiSaatIni() {
  const now = new Date();
  const jakartaHours = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }),
  ).getHours();

  // Jam 21:00 - 23:59 ATAU Jam 00:00 - 13:59
  if (jakartaHours >= 21 || jakartaHours < 14) {
    return { kode: "PAGI", label: "pagi ini" };
  } else if (jakartaHours >= 14 && jakartaHours < 21) {
    return { kode: "SORE", label: "sore ini" };
  }
}

function cropVideoToMaxDuration(inputPath, outputPath, durationSec = 10) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime("00:00:00")
      .setDuration(durationSec)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions(["-preset ultrafast", "-crf 28", "-vf scale=-2:1080"])
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err))
      .save(outputPath);
  });
}

function formatOwnerName(namaOwner) {
  if (!namaOwner) return "Kak";
  const clean = namaOwner.trim();
  if (/^(ny\.|tn\.)/i.test(clean)) return clean;
  return `Kak ${clean}`;
}

const getButtonText = (patient, subValue, defaultText) => {
  const isSelected = (patient.treatments || []).some(
    (t) => t.modul === "PIP/PUP/Muntah" && t.subValue === subValue,
  );
  return isSelected ? `✅ ${defaultText}` : defaultText;
};

// Helper untuk mengecek apakah laporan pasien sudah dikirim
const isReportSent = (patient) => {
  return patient && patient.reportSent === true;
};
// Helper untuk mengecek apakah pasien sudah diisi data treatment-nya
// Helper untuk mengecek apakah SEMUA modul treatment wajib sudah lengkap terisi
const isTreatmentCompleted = (patient) => {
  if (!patient || !Array.isArray(patient.treatments)) return false;

  const sesi = getSesiSaatIni();
  const isObservasiOnly =
    patient.categories &&
    patient.categories.length === 1 &&
    patient.categories.includes(0);

  // Daftar modul wajib yang harus diisi
  const requiredModules = [
    "pip/pup/muntah",
    "sisa makanan",
    "makan",
    "minum",
    "kondisi pasien",
  ];

  // Sesi PAGI wajib isi Suhu Badan
  if (sesi && sesi.kode === "PAGI") {
    requiredModules.push("suhu badan");
  }

  // Jika pasien bukan Pet Hotel & bukan Observasi Only, wajib isi Infus
  if (!patient.isPetHotel && !isObservasiOnly) {
    requiredModules.push("infus");
  }

  const filledModules = patient.treatments.map((t) =>
    (t.modul || "").toLowerCase().trim(),
  );

  // Mengembalikan true HANYA JIKA seluruh modul wajib sudah ada di treatments
  return requiredModules.every((req) =>
    filledModules.some((filled) => filled.includes(req)),
  );
};

// =========================================================================
// JADWAL CRON (Pembersihan Harian Jam 00:00)
// =========================================================================
cron.schedule(
  "30 12,20 * * *",
  async () => {
    console.log("⏰ Menjalankan pembersihan harian (12:30 & 20:30)...");
    try {
      await clearMediaFolder();
      await resetDailyTreatments();
      console.log("✅ Pembersihan harian selesai.");
    } catch (error) {
      console.error("❌ Gagal menjalankan pembersihan harian:", error);
    }
  },
  {
    scheduled: true,
    timezone: "Asia/Jakarta",
  },
);
// =========================================================================
// HELPER PENGIRIMAN LAPORAN KE OWNER
// =========================================================================
async function sendPatientReportToOwner(sock, patient, ownerJid) {
  // 1. Kirim Foto / Video Treatment
  for (const treatment of patient.treatments || []) {
    if (treatment.mediaPath && fs.existsSync(treatment.mediaPath)) {
      let caption = "";
      const targetIndex = session.data.targetIndex;
      const target = PasienPasienDB[targetIndex];
      const stage = session.data.progressTiming;
      const bodyPart = session.data.selectedBodyPart;
      const captionGrup = `${bodyPart} ${target.namaKucing} ${stage}`;
      if (treatment.modul === "PIP/PUP/Muntah") {
        if (treatment.subType === "pippup_khusus") {
          caption =
            `${patient.namaKucing} ${treatment.penjelasanKhusus || "kondisi khusus"}`.trim();
        } else {
          caption = `${patient.namaKucing} ${treatment.subValue || ""}`.trim();
        }
      } else {
        caption = captionGrup;
      }

      const mediaBuffer = await fs.promises.readFile(treatment.mediaPath);

      try {
        if (treatment.mediaType === "image") {
          await sock.sendMessage(ownerJid, {
            image: mediaBuffer,
            caption,
            mimetype: "image/jpeg",
          });
        } else if (treatment.mediaType === "video") {
          await sock.sendMessage(ownerJid, {
            video: mediaBuffer,
            caption,
            mimetype: "video/mp4",
          });
        }
      } catch (err) {
        console.error(
          `❌ Gagal mengirim media treatment (${treatment.modul}):`,
          err,
        );
      }
      await delay(1000);
    }
  }
  const pesanDokterTreatment = (patient.treatments || []).find(
    (t) => t.modul === "Pesan Dokter",
  );
  // 2. Kirim Video Injeksi
  const injeksiTreatment = (patient.treatments || []).find(
    (t) => t.modul === "Injeksi",
  );
  if (
    injeksiTreatment &&
    injeksiTreatment.videos &&
    injeksiTreatment.videos.length > 0
  ) {
    for (let i = 0; i < injeksiTreatment.videos.length; i++) {
      const vid = injeksiTreatment.videos[i];
      if (vid.mediaPath && fs.existsSync(vid.mediaPath)) {
        await sock.sendMessage(ownerJid, {
          video: await fs.promises.readFile(vid.mediaPath),
          caption: `📹 Video Injeksi ${i + 1} (${patient.namaKucing}): ${vid.keterangan}`,
        });
        await delay(1000);
      }
    }
  }

  // 3. Kirim Rangkuman (Summary) Teks
  const sesi = getSesiSaatIni();
  const tanggal = new Date().toLocaleDateString("id-ID", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const findTreatment = (modulKeyword) =>
    (patient.treatments || []).find((t) =>
      t.modul.toLowerCase().includes(modulKeyword.toLowerCase()),
    );

  const pantauan_makan =
    patient.treatments.find((t) => t.modul === "Makan" && t.mediaPath)
      ?.keterangan || "Belum ada laporan";
  const pantauan_minum =
    findTreatment("minum")?.keterangan || "Belum ada laporan";
  const suhuTreatment = patient.treatments.find(
    (t) => t.modul === "Suhu Badan",
  );

  const suhu = suhuTreatment ? parseFloat(suhuTreatment.keterangan) || 0 : 0;
  const catatan_obat =
    patient.treatments.find((t) => t.modul === "Treatment Obat")?.keterangan ||
    "Tidak ada catatan obat khusus";
  const catatan_injeksi =
    patient.treatments.find((t) => t.modul === "Injeksi")?.keterangan ||
    "Tidak ada injeksi";
  const kondisi_Pasien =
    findTreatment("kondisi")?.keterangan || "Belum ada laporan";
  const pesanDokterText =
    pesanDokterTreatment && pesanDokterTreatment.keterangan
      ? pesanDokterTreatment.keterangan
      : `Doakan ${patient.namaKucing} makin fit! 🥺🤲✨`;
  const getToiletStatus = () => {
    const pippupTreatments = (patient.treatments || []).filter(
      (t) => t.modul === "PIP/PUP/Muntah",
    );

    let pipText = `${patient.namaKucing} tidak pip`;
    let pupText = `${patient.namaKucing} tidak pup`;
    let muntahText = "tidak muntah";
    let combinedText = null;

    pippupTreatments.forEach((t) => {
      if (t.subType === "pip") pipText = `${patient.namaKucing} ${t.subValue}`;
      else if (t.subType === "pup")
        pupText = `${patient.namaKucing} ${t.subValue}`;
      else if (t.subType === "muntah")
        muntahText = `${patient.namaKucing} ${t.subValue}`;
      else if (t.subType === "pippup_normal") {
        combinedText = `${patient.namaKucing} Pip normal pup normal`;
      } else if (t.subType === "pippup_khusus") {
        const ket = t.penjelasanKhusus || "Kondisi Khusus";
        combinedText = `${patient.namaKucing} ${ket}`;
      }
    });

    return { pipText, pupText, muntahText, combinedText };
  };

  const toiletStatus = getToiletStatus();
  let toiletSummaryText = "";
  if (toiletStatus.combinedText) {
    toiletSummaryText = `💧 PIP & PUP💩 : ${toiletStatus.combinedText}`;
  } else {
    toiletSummaryText = `💧 PIP: ${toiletStatus.pipText}\n💩 PUP: ${toiletStatus.pupText}`;
  }

  const summaryText = `
🌈 *KABAR HARIAN SI MEONG* 🌈
------------------------------------------
👤 *Nama Owner:* ${formatOwnerName(patient.namaOwner)} 👋
🐱 *Nama Kucing:* ${patient.namaKucing} 🐾✨
📅 *Tanggal:* ${tanggal} 
⏰ *Sesi:* 🌅 ${sesi.label}
------------------------------------------

📊 *REKAP TREATMENT & KESEHATAN:*

1️⃣ *Urusan Toilet:*
${toiletSummaryText}
${toiletStatus.muntahText == "tidak muntah" ? "" : `🤮 Muntah: ${toiletStatus.muntahText}`}

2️⃣ *Nafsu Makan:*
${pantauan_makan} 🍗😋

3️⃣ *Asupan Minum:*
${pantauan_minum} 🥤💦
${
  sesi.kode === "PAGI"
    ? `4️⃣ *Suhu Tubuh:*
🌡️ ${
        suhu >= 38 && suhu <= 39.4
          ? `${suhu.toString().replace(".", ",")}°C (Suhu tubuh aman & stabil 👍)`
          : suhu > 0
            ? `${suhu.toString().replace(".", ",")}°C`
            : "belum ada laporan suhu badan"
      }`
    : ""
}
${sesi.kode === "SORE" ? "4️⃣" : "5️⃣"} *Obat-obatan:* 
💊${catatan_obat}

${sesi.kode === "SORE" ? "5️⃣" : "6️⃣"} *Injeksi:*
💉${catatan_injeksi}

${sesi.kode === "SORE" ? "6️⃣" : "7️⃣"} *Status Kondisi:*
🏃‍♂️⚡ *${kondisi_Pasien}* 🔥

------------------------------------------
💌 *Pesan dari Tim Perawat:*
${pesanDokterText}

Terima kasih telah mempercayakan perawatan hewan kesayangan Anda kepada kami! 🙏🐾❤️
  `.trim();

  await delay(1000);
  await sock.sendMessage(ownerJid, { text: summaryText });
}

// =========================================================================
// KONEKSI BOT & LOGIKA UTAMA
// =========================================================================
const connectToWhatsApp = async () => {
  const { state, saveCreds } = await useMultiFileAuthState("session");

  const sock = makeWASocket({
    logger,
    auth: state,
    printQRInTerminal: true,
    keepAliveIntervalMs: 30000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (Update) => {
    const { connection, lastDisconnect } = Update;
    if (connection === "connecting" && !sock.authState.creds.registered) {
      await delay(1500);
      const code = await sock.requestPairingCode(myPhoneNumber);
      console.log("🔗 Kode Pairing WhatsApp Anda:", code);
    } else if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp(), 3000);
      } else {
        console.log(
          "🔒 Session terkeluar (Logged Out). Hapus folder 'session' dan restart.",
        );
      }
    } else if (connection === "open") {
      console.log("✅ Bot Petshop Klinik Hewan Berhasil Terhubung!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const message of messages) {
      if (!message.message || message.key.fromMe) continue;

      try {
        const jid = message.key.remoteJid;

        const senderJid =
          message.key.participant || message.key.remoteJid || ""; //[cite: 3]
        // Ambil nomor telp saja (menghilangkan '@s.whatsapp.net', '@g.us', dll)
        const senderNumber = senderJid.split("@")[0].split(":")[0];

        // Cek apakah nomor pengirim ada di daftar ALLOWED_NUMBERS
        const isAllowed = ALLOWED_NUMBERS.includes(senderNumber);

        // Jika nomor TIDAK diizinkan, abaikan pesan (bot tidak merespons)
        if (!isAllowed) {
          console.log(isAllowed, senderNumber, ALLOWED_NUMBERS);
          continue;
        }
        const text =
          message.message.conversation ||
          message.message.extendedTextMessage?.text ||
          message.message.imageMessage?.caption ||
          message.message.videoMessage?.caption ||
          message.message.buttonsResponseMessage?.selectedButtonId ||
          message.message.templateButtonReplyMessage?.selectedId ||
          "";

        const cleanText = text.trim();
        const isImage = !!message.message?.imageMessage;
        const isVideo = !!message.message?.videoMessage;

        if (!cleanText && !isImage && !isVideo) continue;

        // Batal Sesi Interaktif
        if (
          cleanText.toLowerCase() === "batal" ||
          cleanText.toLowerCase() === "cancel"
        ) {
          clearSession(jid);
          await sock.sendMessage(
            jid,
            { text: "❌ Sesi interaktif berhasil dibatalkan." },
            { quoted: message },
          );
          return;
        }

        // Helper PIP/PUP/Muntah Menu (4 Tombol Utama)
        const sendPipPupMuntahMenu = async (patient, quotedMsg) => {
          // Ambil list treatment yang sudah tersimpan
          const treatments = patient.treatments || [];

          // Cek modul apa saja yang sudah tercatat
          const hasPip = treatments.some(
            (t) =>
              t.subType === "pip" ||
              t.subType === "pippup_normal" ||
              t.subType === "pippup_khusus",
          );
          const hasPup = treatments.some(
            (t) =>
              t.subType === "pup" ||
              t.subType === "pippup_normal" ||
              t.subType === "pippup_khusus",
          );
          const hasMuntah = treatments.some((t) => t.subType === "muntah");
          const hasPipPup = treatments.some(
            (t) =>
              t.subType === "pippup_normal" || t.subType === "pippup_khusus",
          );

          await sock.sendMessage(
            jid,
            {
              text: `💧💩🤮 *DOKUMENTASI PIP / PUP / MUNTAH (${patient.namaKucing})*\n\nPilih kategori yang ingin didokumentasikan:`,
              buttons: [
                {
                  text: `${hasPip ? "✅ " : ""}💧 1. PIP`,
                  id: "#PIPPUP_MENU_PIP",
                },
                {
                  text: `${hasPup ? "✅ " : ""}💩 2. PUP`,
                  id: "#PIPPUP_MENU_PUP",
                },
                {
                  text: `${hasMuntah ? "✅ " : ""}🤮 3. Muntah`,
                  id: "#PIPPUP_MENU_MUNTAH",
                },
                {
                  text: `${hasPipPup ? "✅ " : ""}💧💩 4. PIP & PUP`,
                  id: "#PIPPUP_MENU_PIPPUP",
                },
                {
                  text: "🔙 Kembali ke Menu Modul",
                  id: "#BACK_TO_MODULE_MENU",
                },
              ],
            },
            { quoted: quotedMsg },
          );
        };

        // Helper Menu Seleksi Kategori Organ
        const sendCategorySelectionMenu = async (session, quotedMsg) => {
          const selectedCategories = session.data.categories || [];

          const categoryButtons = Object.keys(CATEGORIES_MAP).map((key) => {
            const catId = parseInt(key);
            const isSelected = selectedCategories.includes(catId);
            return {
              text: `${isSelected ? "✅ " : ""}${CATEGORIES_MAP[catId]}`,
              id: `#CAT_${catId}`,
            };
          });

          categoryButtons.push({
            text: "🏁 Selesai Tambah Pasien",
            id: "#FINISH_Tambah_Pasien",
          });

          const textMessage =
            selectedCategories.length === 0
              ? "📝 *Registrasi Pasien (5/5)*\n\nSilakan pilih bagian tubuh yang mau dipantau progressnya:"
              : `📝 *Registrasi Pasien (5/5)*\n\nKategori terpilih (${selectedCategories.length}):\n${selectedCategories
                  .map((id) => `• ${CATEGORIES_MAP[id]}`)
                  .join(
                    "\n",
                  )}\n\n*Apakah ada lainnya?* Klik bagian tubuh yang ingin dipantau progressnya, atau klik *Selesai Tambah Pasien* jika sudah.`;

          await sock.sendMessage(
            jid,
            { text: textMessage, buttons: categoryButtons },
            { quoted: quotedMsg },
          );
        };

        // Helper Menu Treatment Pasien
        const sendTreatmentModuleMenu = async (targetIndex) => {
          const selected = PasienPasienDB[targetIndex];
          if (!selected) return;

          const sesi = getSesiSaatIni();
          if (!selected.treatments) selected.treatments = [];

          const categories = selected.categories || [];
          const isObservasiOnly =
            categories.length === 1 && categories.includes(0);

          setSession(jid, "SELECT_TREATMENT_MODULE", {
            targetIndex: targetIndex,
            patient: selected,
            sesiKode: sesi.kode,
            sesiLabel: sesi.label,
            isObservasiOnly,
          });

          const isFilled = (modulName) =>
            selected.treatments.some(
              (t) =>
                t.modul &&
                t.modul.toLowerCase().trim() === modulName.toLowerCase().trim(),
            );

          const treatmentsList = PasienPasienDB[targetIndex].treatments;
          const treatmentIndex = treatmentsList.findIndex(
            (t) =>
              t.uploud === "success" &&
              t.modul === "Dokumentasi Progress",
          );
          const data =
            PasienPasienDB[targetIndex].treatments[treatmentIndex] || "";
          const ModulProgressPasien =
            data.uploud === "success" ? "✅" : "";

          const hasPip = selected.treatments.some(
            (t) => t.modul === "PIP/PUP/Muntah" && t.subType === "pip",
          );
          const hasPup = selected.treatments.some(
            (t) => t.modul === "PIP/PUP/Muntah" && t.subType === "pup",
          );

          const pipPupLabel = hasPip && hasPup ? "✅" : "⏳";

          let moduleButtons = [
            {
              text: `PIP/PUP/Muntah ${pipPupLabel}`,
              id: "#MODUL_PIP_PUP",
            },
            {
              text: `Sisa Makanan ${isFilled("Sisa Makanan") ? "✅" : ""}`,
              id: "#MODUL_SISA_MAKANAN",
            },
            {
              text: `Makan ${isFilled("Makan") ? "✅" : ""}`,
              id: "#MODUL_MAKAN",
            },
            {
              text: `Minum ${isFilled("Minum") ? "✅" : ""}`,
              id: "#MODUL_MINUM",
            },
          ];

          if (isPethotel == false) {
            if (sesi.kode === "PAGI") {
              moduleButtons.push({
                text: `Suhu Badan ${isFilled("Suhu") ? "✅" : ""}`,
                id: "#MODUL_SUHU",
              });
            }
            moduleButtons.push(
              {
                text: `Infus ${isFilled("Infus") ? "✅" : ""}`,
                id: "#MODUL_INFUS",
              },
              {
                text: `Treatment Obat ${isFilled("Treatment Obat") ? "✅" : ""}`,
                id: "#MODUL_OBAT",
              },
              {
                text: `Kondisi Pasien ${isFilled("Kondisi Pasien") ? "✅" : ""}`,
                id: "#MODUL_KONDISI",
              },
              {
                text: `Progress Pasien ${ModulProgressPasien}`,
                id: "#MODUL_PROGRESS_DISEASE",
              },
              {
                text: `Pesan Dokter ${isFilled("Pesan Dokter") ? "✅" : ""}`,
                id: "#MODUL_PESAN_DOKTER",
              },
            );
          }

          moduleButtons.push(
            { text: "🏁 Selesai", id: `#FINISH_TREATMENT_${targetIndex}` },
            { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
          );

          await sock.sendMessage(
            jid,
            {
              text: `💊 *Input Treatment: ${selected.namaKucing}*\nStatus: ${selected.isInfectious ? "🔴 Infeksius" : "🟢 Non-Infeksius"}\nMode: *${isObservasiOnly ? "Observasi" : "Spesifik"}*\nSesi: *${sesi.label}*\n\nPilih modul yang ingin diisi:`,
              buttons: moduleButtons,
            },
            { quoted: message },
          );
        };

        // =========================================================================
        // MENU UTAMA
        // =========================================================================
        if (
          cleanText.toLowerCase() === "start" ||
          cleanText.toLowerCase() === "menu" ||
          cleanText === "#MENU_UTAMA"
        ) {
          clearSession(jid);
          await sock.sendMessage(
            jid,
            {
              text: "🐾 *SELAMAT DATANG DI SISTEM MANAJEMEN Pasien* 🐾\n\nSilakan pilih menu di bawah ini:",
              buttons: [
                { text: "👤 Pasien", id: "#Pasien" },
                { text: "💊 TREATMENT", id: "#TREATMENT" },
                { text: "📲 KIRIM OWNER", id: "#KIRIM_OWNER" },
              ],
            },
            { quoted: message },
          );
          return;
        }

        // =========================================================================
        // SUB-MENU Pasien
        // =========================================================================
        if (cleanText === "#Pasien") {
          clearSession(jid);
          await sock.sendMessage(
            jid,
            {
              text: "🏥 *MANAJEMEN Pasien Pasien*\n\nPilih aksi data Pasien:",
              buttons: [
                { text: "➕ Tambah Pasien", id: "#Tambah_Pasien" },
                { text: "✏️ Perbarui Pasien", id: "#Perbarui_Pasien" },
                { text: "🗑️ Hapus Pasien", id: "#Hapus_Pasien" },
                { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
              ],
            },
            { quoted: message },
          );
          return;
        }

        if (cleanText === "#Tambah_Pasien") {
          setSession(jid, "WAITING_NAMA_OWNER", { categories: [] });
          await sock.sendMessage(
            jid,
            {
              text: "📝 *Registrasi Pasien (1/5)*\n\nKetik dan kirim *Nama Owner*:",
            },
            { quoted: message },
          );
          return;
        }

        // =========================================================================
        // PERBARUI PASIEN (UPDATE)
        // =========================================================================
        if (cleanText === "#Perbarui_Pasien") {
          clearSession(jid);
          if (PasienPasienDB.length === 0) {
            await sock.sendMessage(
              jid,
              {
                text: "⚠️ Tidak ada data Pasien Pasien.",
                buttons: [
                  { text: "➕ Tambah Pasien Baru", id: "#Tambah_Pasien" },
                ],
              },
              { quoted: message },
            );
            return;
          }

          // Tampilkan 3 Pilihan Kategori
          await sock.sendMessage(
            jid,
            {
              text: "✏️ *PERBARUI PASIEN*\n\nPilih kategori status Pasien yang ingin diperbarui:",
              buttons: [
                { text: "🏨 Pet Hotel", id: "#UPDATE_FILTER_HOTEL" },
                { text: "🔴 Infeksius", id: "#UPDATE_FILTER_INF" },
                { text: "🟢 Non-Infeksius", id: "#UPDATE_FILTER_NONINF" },
                { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
              ],
            },
            { quoted: message },
          );
          return;
        }

        // Handler Filter Kategori Update
        if (
          cleanText === "#UPDATE_FILTER_HOTEL" ||
          cleanText === "#UPDATE_FILTER_INF" ||
          cleanText === "#UPDATE_FILTER_NONINF"
        ) {
          const filterType = cleanText.replace("#UPDATE_FILTER_", "");

          const filteredList = PasienPasienDB.map((p, idx) => ({
            ...p,
            originalIndex: idx,
          })).filter((p) => {
            if (filterType === "INF") return p.isInfectious && !p.isPetHotel;
            if (filterType === "NONINF")
              return !p.isInfectious && !p.isPetHotel;
            if (filterType === "HOTEL") return p.isPetHotel;
            return false;
          });

          const labelMap = {
            INF: "🔴 INFEKSIUS",
            NONINF: "🟢 NON-INFEKSIUS",
            HOTEL: "🏨 PET HOTEL",
          };

          if (filteredList.length === 0) {
            await sock.sendMessage(
              jid,
              {
                text: `⚠️ Tidak ada Pasien berkategori *${labelMap[filterType]}*.`,
                buttons: [{ text: "🔙 Kembali", id: "#Perbarui_Pasien" }],
              },
              { quoted: message },
            );
            return;
          }

          const patientButtons = filteredList.slice(0, 20).map((p) => ({
            text: `🐾 ${p.namaKucing} (${p.namaOwner})`,
            id: `#SELECT_Perbarui_${p.originalIndex}`,
          }));
          patientButtons.push({ text: "🔙 Kembali", id: "#Perbarui_Pasien" });

          await sock.sendMessage(
            jid,
            {
              text: `✏️ *Daftar Pasien ${labelMap[filterType]}*:\nPilih Pasien yang ingin diperbarui:`,
              buttons: patientButtons,
            },
            { quoted: message },
          );
          return;
        }

        // =========================================================================
        // HAPUS PASIEN (DELETE)
        // =========================================================================
        if (cleanText === "#Hapus_Pasien") {
          clearSession(jid);
          if (PasienPasienDB.length === 0) {
            await sock.sendMessage(
              jid,
              {
                text: "⚠️ Data Pasien Pasien kosong.",
                buttons: [{ text: "🏠 Menu Utama", id: "#MENU_UTAMA" }],
              },
              { quoted: message },
            );
            return;
          }

          // Tampilkan 3 Pilihan Kategori
          await sock.sendMessage(
            jid,
            {
              text: "🗑️ *HAPUS PASIEN*\n\nPilih kategori status Pasien yang ingin dihapus:",
              buttons: [
                { text: "🏨 Pet Hotel", id: "#DELETE_FILTER_HOTEL" },
                { text: "🔴 Infeksius", id: "#DELETE_FILTER_INF" },
                { text: "🟢 Non-Infeksius", id: "#DELETE_FILTER_NONINF" },
                { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
              ],
            },
            { quoted: message },
          );
          return;
        }

        // Handler Filter Kategori Delete
        if (
          cleanText === "#DELETE_FILTER_HOTEL" ||
          cleanText === "#DELETE_FILTER_INF" ||
          cleanText === "#DELETE_FILTER_NONINF"
        ) {
          const filterType = cleanText.replace("#DELETE_FILTER_", "");

          const filteredList = PasienPasienDB.map((p, idx) => ({
            ...p,
            originalIndex: idx,
          })).filter((p) => {
            if (filterType === "INF") return p.isInfectious && !p.isPetHotel;
            if (filterType === "NONINF")
              return !p.isInfectious && !p.isPetHotel;
            if (filterType === "HOTEL") return p.isPetHotel;
            return false;
          });

          const labelMap = {
            INF: "🔴 INFEKSIUS",
            NONINF: "🟢 NON-INFEKSIUS",
            HOTEL: "🏨 PET HOTEL",
          };

          if (filteredList.length === 0) {
            await sock.sendMessage(
              jid,
              {
                text: `⚠️ Tidak ada Pasien berkategori *${labelMap[filterType]}*.`,
                buttons: [{ text: "🔙 Kembali", id: "#Hapus_Pasien" }],
              },
              { quoted: message },
            );
            return;
          }

          const hapusButtons = filteredList.slice(0, 20).map((p) => ({
            text: `🗑️ ${p.namaKucing} (${p.namaOwner})`,
            id: `#ASK_Hapus_${p.originalIndex}`,
          }));
          hapusButtons.push({ text: "🔙 Kembali", id: "#Hapus_Pasien" });

          await sock.sendMessage(
            jid,
            {
              text: `🗑️ *Daftar Pasien ${labelMap[filterType]}*:\nPilih Pasien yang ingin dihapus:`,
              buttons: hapusButtons,
            },
            { quoted: message },
          );
          return;
        }

        // =========================================================================
        // HANDLER EKSPLISIT KONFIRMASI & EKSEKUSI HAPUS PASIEN
        // =========================================================================
        if (cleanText.startsWith("#ASK_Hapus_")) {
          const idx = parseInt(cleanText.replace("#ASK_Hapus_", ""));
          const patient = PasienPasienDB[idx];

          if (!patient) {
            await sock.sendMessage(
              jid,
              { text: "⚠️ Pasien tidak ditemukan." },
              { quoted: message },
            );
            return;
          }

          await sock.sendMessage(
            jid,
            {
              text: `⚠️ *KONFIRMASI HAPUS PASIEN*\n\nApakah Anda yakin ingin menghapus data pasien berikut?\n\n🐱 *Kucing:* ${patient.namaKucing}\n👤 *Owner:* ${patient.namaOwner}\n🆔 *ID:* ${patient.idPasien || "-"}`,
              buttons: [
                { text: "❌ Yakin, Hapus", id: `#CONFIRM_DELETE_${idx}` },
                { text: "🔙 Batal", id: "#Hapus_Pasien" },
              ],
            },
            { quoted: message },
          );
          return;
        }

        if (cleanText.startsWith("#CONFIRM_DELETE_")) {
          const idx = parseInt(cleanText.replace("#CONFIRM_DELETE_", ""));
          const patient = PasienPasienDB[idx];

          if (!patient) {
            await sock.sendMessage(
              jid,
              { text: "⚠️ Pasien sudah tidak ada atau telah dihapus." },
              { quoted: message },
            );
            return;
          }

          // Hapus file media terkait treatment pasien ini jika ada
          if (Array.isArray(patient.treatments)) {
            for (const t of patient.treatments) {
              if (t.mediaPath) await safeUnlink(t.mediaPath);
              if (Array.isArray(t.videos)) {
                for (const v of t.videos) {
                  if (v.mediaPath) await safeUnlink(v.mediaPath);
                }
              }
            }
          }

          // Hapus data dari array database
          const namaKucing = patient.namaKucing;
          PasienPasienDB.splice(idx, 1);
          saveData(PasienPasienDB);

          await sock.sendMessage(
            jid,
            {
              text: `🗑️ Data pasien *${namaKucing}* berhasil dihapus dari database!`,
              buttons: [
                { text: "🗑️ Hapus Pasien Lain", id: "#Hapus_Pasien" },
                { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
              ],
            },
            { quoted: message },
          );
          return;
        }

        if (cleanText.startsWith("#SELECT_Perbarui_")) {
          const idx = parseInt(cleanText.replace("#SELECT_Perbarui_", ""));
          const patient = PasienPasienDB[idx];
          if (!patient) {
            await sock.sendMessage(
              jid,
              { text: "⚠️ Pasien tidak ditemukan." },
              { quoted: message },
            );
            return;
          }

          setSession(jid, "WAITING_FIELD_CHOICE", { targetIndex: idx });

          await sock.sendMessage(
            jid,
            {
              text: `✏️ *Perbarui DATA: ${patient.namaKucing} (${patient.namaOwner})*\n\nPilih data yang ingin diubah:`,
              buttons: [
                { text: "👤 Nama Owner", id: "#Perbarui_FIELD_namaOwner" },
                { text: "🐾 Nama Kucing", id: "#Perbarui_FIELD_namaKucing" },
                { text: "📞 No. HP", id: "#Perbarui_FIELD_noHp" },
                { text: "🔙 Kembali", id: "#Pasien" },
              ],
            },
            { quoted: message },
          );
          return;
        }

        if (cleanText.startsWith("#Perbarui_FIELD_")) {
          if (
            !userSessions[jid] ||
            userSessions[jid].step !== "WAITING_FIELD_CHOICE"
          )
            return;

          const field = cleanText.replace("#Perbarui_FIELD_", "");
          const fieldMap = {
            namaOwner: "Nama Owner",
            namaKucing: "Nama Kucing",
            noHp: "No. HP",
          };

          if (!fieldMap[field]) return;

          setSession(jid, "WAITING_NEW_VALUE", {
            ...userSessions[jid].data,
            fieldToPerbarui: field,
          });

          await sock.sendMessage(
            jid,
            {
              text: `✏️ Masukkan nilai baru untuk *${fieldMap[field]}*:`,
              buttons: [{ text: "❌ Batal Perbarui", id: "#Pasien" }],
            },
            { quoted: message },
          );
          return;
        }

        if (
          userSessions[jid] &&
          userSessions[jid].step === "WAITING_NEW_VALUE"
        ) {
          const { targetIndex, fieldToPerbarui } = userSessions[jid].data;
          const patient = PasienPasienDB[targetIndex];

          if (!patient) {
            clearSession(jid);
            await sock.sendMessage(
              jid,
              { text: "⚠️ Terjadi kesalahan, Pasien tidak ditemukan." },
              { quoted: message },
            );
            return;
          }

          let valToSet = cleanText;
          if (fieldToPerbarui === "noHp") {
            valToSet = valToSet.replace(/[^0-9]/g, "");
            if (valToSet.startsWith("0")) valToSet = "62" + valToSet.slice(1);
          }

          const oldValue = patient[fieldToPerbarui];
          patient[fieldToPerbarui] = valToSet;
          saveData(PasienPasienDB);

          const fieldMap = {
            namaOwner: "Nama Owner",
            namaKucing: "Nama Kucing",
            noHp: "No. HP",
          };

          await sock.sendMessage(
            jid,
            {
              text: `✅ *DATA BERHASIL DI-Perbarui!*\n\n*Pasien:* ${patient.namaKucing}\n*Data:* ${fieldMap[fieldToPerbarui]}\n*Lama:* ${oldValue}\n*Baru:* ${valToSet}`,
              buttons: [
                {
                  text: "✏️ Perbarui Data Lain",
                  id: `#SELECT_Perbarui_${targetIndex}`,
                },
                { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
              ],
            },
            { quoted: message },
          );

          clearSession(jid);
          return;
        }
        // =========================================================================
        // TREATMENT FLOW
        // =========================================================================
        if (cleanText === "#TREATMENT") {
          clearSession(jid);
          if (PasienPasienDB.length === 0) {
            await sock.sendMessage(
              jid,
              {
                text: "⚠️ Data Pasien kosong.",
                buttons: [{ text: "➕ Tambah Pasien", id: "#Tambah_Pasien" }],
              },
              { quoted: message },
            );
            return;
          }

          await sock.sendMessage(
            jid,
            {
              text: "💊 *Menu Treatment Pasien*\n\nPilih aksi yang ingin dilakukan:",
              buttons: [
                { text: "📝 Input Treatment Baru", id: "#INPUT_TREATMENT_NEW" },
                {
                  text: "✏️ Update / Edit Treatment",
                  id: "#UPDATE_TREATMENT_MENU",
                },
                { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
              ],
            },
            { quoted: message },
          );
          return;
        }

        // Tambahkan handler ini jika user memilih Input Baru
        if (cleanText === "#INPUT_TREATMENT_NEW") {
          await sock.sendMessage(
            jid,
            {
              text: "💊 *Input Treatment Pasien*\n\nPilih kategori status Pasien:",
              buttons: [
                { text: "🏨 Pet Hotel", id: "#TREATMENT_FILTER_HOTEL" },
                { text: "🔴 Infeksius", id: "#TREATMENT_FILTER_INF" },
                { text: "🟢 Non-Infeksius", id: "#TREATMENT_FILTER_NONINF" },
                { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
              ],
            },
            { quoted: message },
          );
          return;
        }

        if (
          cleanText === "#TREATMENT_FILTER_INF" ||
          cleanText === "#TREATMENT_FILTER_NONINF" ||
          cleanText === "#TREATMENT_FILTER_HOTEL"
        ) {
          const filterType = cleanText.replace("#TREATMENT_FILTER_", "");

          if (filterType === "HOTEL") {
            isPethotel = true;
          } else {
            isPethotel = false;
          }
          const filteredList = PasienPasienDB.map((p, idx) => ({
            ...p,
            originalIndex: idx,
          })).filter((p) => {
            if (filterType === "INF") return p.isInfectious && !p.isPetHotel;
            if (filterType === "NONINF")
              return !p.isInfectious && !p.isPetHotel;
            if (filterType === "HOTEL") return p.isPetHotel;
            return false;
          });

          const labelMap = {
            INF: "🔴 INFEKSIUS",
            NONINF: "🟢 NON-INFEKSIUS",
            HOTEL: "🏨 PET HOTEL",
          };
          if (filteredList.length === 0) {
            await sock.sendMessage(
              jid,
              {
                text: `⚠️ Tidak ada Pasien berkategori *${labelMap[filterType]}*.`,
                buttons: [
                  { text: "🔙 Kembali Ke Opsi Lain", id: "#TREATMENT" },
                ],
              },
              { quoted: message },
            );
            return;
          }

          const buttons = filteredList.slice(0, 20).map((p) => ({
            text: `${isTreatmentCompleted(p) ? "✅ " : "🐾 "}${p.namaKucing} (${p.namaOwner})`,
            id: `#SELECT_TREATMENT_${p.originalIndex}`,
          }));
          buttons.push({ text: "🔙 Opsi Lain", id: "#TREATMENT" });

          await sock.sendMessage(
            jid,
            {
              text: `📋 *Daftar Pasien ${labelMap[filterType]}*:\nPilih Pasien untuk dicatat treatmentnya:`,
              buttons,
            },
            { quoted: message },
          );
          return;
        }

        if (cleanText.startsWith("#FINISH_TREATMENT_")) {
          clearSession(jid);
          await sock.sendMessage(
            jid,
            {
              text: "🎉 *PENGISIAN TREATMENT SELESAI!*",
              buttons: [
                { text: "💊 Pilih Pasien Lain", id: "#TREATMENT" },
                { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
              ],
            },
            { quoted: message },
          );
          return;
        }

        if (cleanText.startsWith("#SELECT_TREATMENT_")) {
          const idx = parseInt(cleanText.replace("#SELECT_TREATMENT_", ""));
          await sendTreatmentModuleMenu(idx);
          return;
        }

        // =========================================================================
        // FITUR UPDATE / EDIT TREATMENT PASIEN (BARU)
        // =========================================================================

        // 1. Menu Utama Update Treatment
        if (cleanText === "#UPDATE_TREATMENT_MENU") {
          clearSession(jid);
          if (PasienPasienDB.length === 0) {
            await sock.sendMessage(
              jid,
              {
                text: "⚠️ Data Pasien kosong.",
                buttons: [{ text: "🏠 Menu Utama", id: "#MENU_UTAMA" }],
              },
              { quoted: message },
            );
            return;
          }

          await sock.sendMessage(
            jid,
            {
              text: "✏️ *UPDATE TREATMENT PASIEN*\n\nPilih kategori pasien yang ingin diperbarui treatment-nya:",
              buttons: [
                { text: "🏨 Pet Hotel", id: "#UPDATE_TREAT_FILTER_HOTEL" },
                { text: "🔴 Infeksius", id: "#UPDATE_TREAT_FILTER_INF" },
                { text: "🟢 Non-Infeksius", id: "#UPDATE_TREAT_FILTER_NONINF" },
                { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
              ],
            },
            { quoted: message },
          );
          return;
        }

        // 2. Handler Filter Pasien yang Sudah Diisi Treatment
        if (
          cleanText === "#UPDATE_TREAT_FILTER_HOTEL" ||
          cleanText === "#UPDATE_TREAT_FILTER_INF" ||
          cleanText === "#UPDATE_TREAT_FILTER_NONINF"
        ) {
          const filterType = cleanText.replace("#UPDATE_TREAT_FILTER_", "");

          const filteredList = PasienPasienDB.map((p, idx) => ({
            ...p,
            originalIndex: idx,
          })).filter((p) => {
            // Hanya tampilkan pasien yang sudah diisi treatment-nya hari ini
            const hasTreatment =
              Array.isArray(p.treatments) && p.treatments.length > 0;
            if (!hasTreatment) return false;

            if (filterType === "INF") return p.isInfectious && !p.isPetHotel;
            if (filterType === "NONINF")
              return !p.isInfectious && !p.isPetHotel;
            if (filterType === "HOTEL") return p.isPetHotel;
            return false;
          });

          const labelMap = {
            INF: "🔴 INFEKSIUS",
            NONINF: "🟢 NON-INFEKSIUS",
            HOTEL: "🏨 PET HOTEL",
          };

          if (filteredList.length === 0) {
            await sock.sendMessage(
              jid,
              {
                text: `⚠️ Tidak ada Pasien *${labelMap[filterType]}* yang memiliki data treatment untuk di-update.`,
                buttons: [{ text: "🔙 Kembali", id: "#UPDATE_TREATMENT_MENU" }],
              },
              { quoted: message },
            );
            return;
          }

          const buttons = filteredList.slice(0, 20).map((p) => ({
            text: `✏️ ${p.namaKucing} (${p.namaOwner})`,
            id: `#SELECT_UPDATE_TREAT_${p.originalIndex}`,
          }));
          buttons.push({ text: "🔙 Kembali", id: "#UPDATE_TREATMENT_MENU" });

          await sock.sendMessage(
            jid,
            {
              text: `📋 *Daftar Pasien ${labelMap[filterType]} (Update Treatment)*:\nPilih pasien yang ingin diubah datanya:`,
              buttons,
            },
            { quoted: message },
          );
          return;
        }

        // 3. Handler Tampilan Modul Treatment yang Sudah Pernah Diisi
        if (cleanText.startsWith("#SELECT_UPDATE_TREAT_")) {
          const targetIndex = parseInt(
            cleanText.replace("#SELECT_UPDATE_TREAT_", ""),
          );
          const patient = PasienPasienDB[targetIndex];

          if (
            !patient ||
            !patient.treatments ||
            patient.treatments.length === 0
          ) {
            await sock.sendMessage(
              jid,
              {
                text: "⚠️ Pasien tidak ditemukan atau belum memiliki treatment.",
              },
              { quoted: message },
            );
            return;
          }

          // Dapatkan daftar unik modul treatment yang SUDAH diisi
          const existingModules = [
            ...new Set(patient.treatments.map((t) => t.modul)),
          ];

          const moduleButtons = existingModules.map((modulName) => {
            let buttonId = "";
            if (modulName === "PIP/PUP/Muntah") buttonId = "#MODUL_PIP_PUP";
            else if (modulName === "Sisa Makanan")
              buttonId = "#MODUL_SISA_MAKANAN";
            else if (modulName === "Makan") buttonId = "#MODUL_MAKAN";
            else if (modulName === "Minum") buttonId = "#MODUL_MINUM";
            else if (modulName === "Suhu Badan") buttonId = "#MODUL_SUHU";
            else if (modulName === "Infus") buttonId = "#MODUL_INFUS";
            else if (modulName === "Treatment Obat") buttonId = "#MODUL_OBAT";
            else if (modulName === "Injeksi") buttonId = "#MODUL_INJEKSI";
            else if (modulName === "Kondisi Pasien")
              buttonId = "#MODUL_KONDISI";
            else if (modulName === "Dokumentasi Progress")
              buttonId = "#MODUL_PROGRESS_DISEASE";
            else if (modulName === "Pesan Dokter")
              buttonId = "#MODUL_PESAN_DOKTER";

            return {
              text: `✏️ Edit ${modulName}`,
              id: buttonId,
            };
          });

          const sesi = getSesiSaatIni();
          setSession(jid, "SELECT_TREATMENT_MODULE", {
            targetIndex,
            patient,
            sesiKode: sesi.kode,
            sesiLabel: sesi.label,
            isUpdateMode: true, // Flag penanda mode update
          });

          moduleButtons.push(
            {
              text: "🏁 Selesai Update",
              id: `#FINISH_TREATMENT_${targetIndex}`,
            },
            { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
          );

          await sock.sendMessage(
            jid,
            {
              text: `✏️ *EDIT TREATMENT: ${patient.namaKucing}*\n\nPilih modul yang ingin diubah/di-update:`,
              buttons: moduleButtons,
            },
            { quoted: message },
          );
          return;
        }

        // =========================================================================
        // SUB-MENU KIRIM OWNER
        // =========================================================================
        if (cleanText === "#KIRIM_OWNER") {
          clearSession(jid);
          if (PasienPasienDB.length === 0) {
            await sock.sendMessage(
              jid,
              {
                text: "⚠️ Data Pasien Pasien kosong.",
                buttons: [{ text: "➕ Tambah Pasien", id: "#Tambah_Pasien" }],
              },
              { quoted: message },
            );
            return;
          }

          await sock.sendMessage(
            jid,
            {
              text: "📲 *KIRIM LAPORAN KE OWNER*\n\nPilih kategori status Pasien:",
              buttons: [
                { text: "🏨 Pet Hotel", id: "#SEND_OWNER_FILTER_HOTEL" },
                { text: "🔴 Infeksius", id: "#SEND_OWNER_FILTER_INF" },
                { text: "🟢 Non-Infeksius", id: "#SEND_OWNER_FILTER_NONINF" },
                { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
              ],
            },
            { quoted: message },
          );
          return;
        }

        if (
          cleanText === "#SEND_OWNER_FILTER_INF" ||
          cleanText === "#SEND_OWNER_FILTER_NONINF" ||
          cleanText === "#SEND_OWNER_FILTER_HOTEL"
        ) {
          const filterType = cleanText.replace("#SEND_OWNER_FILTER_", "");

          const filteredList = PasienPasienDB.map((p, idx) => ({
            ...p,
            originalIndex: idx,
          })).filter((p) => {
            if (filterType === "INF") return p.isInfectious && !p.isPetHotel;
            if (filterType === "NONINF")
              return !p.isInfectious && !p.isPetHotel;
            if (filterType === "HOTEL") return p.isPetHotel;
            return false;
          });

          const labelMap = {
            INF: "🔴 INFEKSIUS",
            NONINF: "🟢 NON-INFEKSIUS",
            HOTEL: "🏨 PET HOTEL",
          };

          if (filteredList.length === 0) {
            await sock.sendMessage(
              jid,
              {
                text: `⚠️ Tidak ada Pasien berkategori *${labelMap[filterType]}*.`,
                buttons: [
                  { text: "🔙 Kembali ke Opsi Lain", id: "#KIRIM_OWNER" },
                ],
              },
              { quoted: message },
            );
            return;
          }

          // DITAMBAHKAN: Pengecekan isReportSent(p) untuk menambahkan centang pada tombol
          const buttons = filteredList.slice(0, 20).map((p) => ({
            text: `${isReportSent(p) ? "✅ " : "🐾 "}${p.namaKucing} (${p.namaOwner})`,
            id: `#SEND_OWNER_${p.originalIndex}`,
          }));
          buttons.push({ text: "🔙 Opsi Lain", id: "#KIRIM_OWNER" });

          await sock.sendMessage(
            jid,
            {
              text: `📲 *KIRIM LAPORAN ${labelMap[filterType]}*:\nPilih Pasien yang laporannya akan dikirim:`,
              buttons,
            },
            { quoted: message },
          );
          return;
        }

        if (cleanText.startsWith("#SEND_OWNER_")) {
          const idx = parseInt(cleanText.replace("#SEND_OWNER_", ""));
          const patient = PasienPasienDB[idx];
          if (!patient) return;

          if (!patient.treatments || patient.treatments.length === 0) {
            await sock.sendMessage(
              jid,
              {
                text: `⚠️ Pasien *${patient.namaKucing}* belum memiliki data treatment untuk dikirim.`,
              },
              { quoted: message },
            );
            return;
          }

          await sock.sendMessage(
            jid,
            {
              text: `📲 *OPSI LAPORAN OWNER*\n\nPasien: *${patient.namaKucing}*\nOwner: *${formatOwnerName(patient.namaOwner)}*\n\nSilakan pilih aksi:`,
              buttons: [
                { text: "🚀 Kirim Sekarang", id: `#EXEC_SEND_NOW_${idx}` },
                { text: "👁️ Preview", id: `#PREVIEW_REPORT_${idx}` },
                { text: "🔙 Kembali", id: "#KIRIM_OWNER" },
              ],
            },
            { quoted: message },
          );
          return;
        }

        // -------------------------------------------------------------------------
        // HANDLER TOMBOL PREVIEW LAPORAN (KIRIM FOTO/VIDEO & RANGKUMAN KE PENGIRIM)
        // -------------------------------------------------------------------------
        if (cleanText.startsWith("#PREVIEW_REPORT_")) {
          const idx = parseInt(cleanText.replace("#PREVIEW_REPORT_", ""));
          const patient = PasienPasienDB[idx];
          if (!patient) return;

          await sock.sendMessage(
            jid,
            {
              text: `🔍 *Mempersiapkan preview laporan ${patient.namaKucing}...*`,
            },
            { quoted: message },
          );

          // Mengirimkan preview media & rangkuman langsung ke JID pengirim (bot chat/grup staf)
          await sendPatientReportToOwner(sock, patient, jid);

          await sock.sendMessage(
            jid,
            {
              text: `👀 *Preview laporan untuk ${patient.namaKucing} telah ditampilkan di atas.*`,
              buttons: [
                { text: "🚀 Kirim Sekarang", id: `#EXEC_SEND_NOW_${idx}` },
                { text: "🔙 Kembali", id: "#KIRIM_OWNER" },
              ],
            },
            { quoted: message },
          );
          return;
        }

        // -------------------------------------------------------------------------
        // HANDLER TOMBOL EXECUTE KIRIM SEKARANG KE OWNER
        // -------------------------------------------------------------------------
        if (cleanText.startsWith("#EXEC_SEND_NOW_")) {
          const idx = parseInt(cleanText.replace("#EXEC_SEND_NOW_", ""));
          const patient = PasienPasienDB[idx];
          if (!patient) return;

          const ownerJid = `${patient.noHp}@s.whatsapp.net`;
          const sesi = getSesiSaatIni();
          const isObservasiOnly =
            patient.categories.length === 1 && patient.categories.includes(0);

          const getMissingTreatments = (p, s) => {
            const filledModules = (p.treatments || []).map((t) =>
              t.modul.toLowerCase().trim(),
            );
            const required = [
              "pip/pup/muntah",
              "sisa makanan",
              "makan",
              "minum",
              "kondisi pasien",
            ];

            if (s.kode === "PAGI") {
              required.push("suhu badan");
            }
            if (!isObservasiOnly) {
              required.push("infus");
            }

            return required.filter(
              (mod) => !filledModules.some((filled) => filled.includes(mod)),
            );
          };

          const missingTreatments = getMissingTreatments(patient, sesi);

          if (missingTreatments.length > 0) {
            const missingList = missingTreatments
              .map((m) => `• *${m.toUpperCase()}*`)
              .join("\n");
            await sock.sendMessage(
              jid,
              {
                text: `❌ *PENGIRIMAN DIBATALKAN* ❌\n\nLaporan untuk *${patient.namaKucing}* belum lengkap. Anda akan diarahkan untuk mengisi kekurangan treatment berikut:\n\n${missingList}`,
              },
              { quoted: message },
            );
            await sendTreatmentModuleMenu(idx);
            return;
          }

          await sock.sendMessage(
            jid,
            {
              text: `⏳ *Mempersiapkan dan mengirim laporan untuk ${patient.namaKucing} ke ${formatOwnerName(patient.namaOwner)}...*`,
            },
            { quoted: message },
          );

          // Jalankan pengiriman ke WhatsApp owner
          await sendPatientReportToOwner(sock, patient, ownerJid);

          patient.reportSent = true;
          saveData(PasienPasienDB);

          await sock.sendMessage(
            jid,
            {
              text: `✅ Laporan untuk *${patient.namaKucing}* telah berhasil dikirim ke owner.`,
              buttons: [
                { text: "📲 Kirim ke Owner Lain", id: "#KIRIM_OWNER" },
                { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
              ],
            },
            { quoted: message },
          );
          clearSession(jid);
          return;
        }

        // =========================================================================
        // HANDLER PROSES INTERAKTIF
        // =========================================================================
        if (userSessions[jid]) {
          const session = userSessions[jid];

          if (cleanText === "#BACK_TO_MODULE_MENU") {
            await sendTreatmentModuleMenu(session.data.targetIndex);
            return;
          }

          if (cleanText === "#MODUL_PIP_PUP") {
            setSession(jid, "WAITING_PIPPUP_MAIN_MENU", session.data);
            await sendPipPupMuntahMenu(session.data.patient, message);
            return;
          }

          // -------------------------------------------------------------------------
          // Tambah Pasien FLOW
          // -------------------------------------------------------------------------
          if (session.step === "WAITING_NAMA_OWNER") {
            setSession(jid, "WAITING_NAMA_KUCING", {
              ...session.data,
              namaOwner: cleanText,
            });
            await sock.sendMessage(
              jid,
              { text: "📝 *Registrasi Pasien (2/5)*\n\nKetik *Nama Kucing*:" },
              { quoted: message },
            );
            return;
          }

          if (session.step === "WAITING_NAMA_KUCING") {
            setSession(jid, "WAITING_NO_HP", {
              ...session.data,
              namaKucing: cleanText,
            });
            await sock.sendMessage(
              jid,
              {
                text: "📝 *Registrasi Pasien (3/5)*\n\nKetik *Nomor Telepon Owner*:",
              },
              { quoted: message },
            );
            return;
          }

          if (session.step === "WAITING_NO_HP") {
            let cleanedPhone = cleanText.replace(/[^0-9]/g, "");
            if (cleanedPhone.startsWith("0"))
              cleanedPhone = "62" + cleanedPhone.slice(1);

            setSession(jid, "WAITING_INFECTIOUS_STATUS", {
              ...session.data,
              noHp: cleanedPhone,
            });

            await sock.sendMessage(
              jid,
              {
                text: "📝 *Registrasi Pasien (4/5)*\n\nPilih Status Infeksius Pasien:",
                buttons: [
                  { text: "🏨 Pet Hotel", id: "#STATUS_PET_HOTEL" },
                  { text: "🔴 Infeksius", id: "#STATUS_INF_YES" },
                  { text: "🟢 Non-Infeksius", id: "#STATUS_INF_NO" },
                ],
              },
              { quoted: message },
            );
            return;
          }

          if (session.step === "WAITING_INFECTIOUS_STATUS") {
            const isHotel = cleanText === "#STATUS_PET_HOTEL";
            const isInf = cleanText === "#STATUS_INF_YES";

            setSession(jid, "WAITING_DISEASE_CATEGORY_BUTTON", {
              ...session.data,
              isInfectious: isInf,
              isPetHotel: isHotel,
              categories: [],
            });

            await sendCategorySelectionMenu(userSessions[jid], message);
            return;
          }

          if (session.step === "WAITING_DISEASE_CATEGORY_BUTTON") {
            if (cleanText.startsWith("#CAT_")) {
              const selectedCategoryIndex = parseInt(
                cleanText.replace("#CAT_", ""),
              );
              const existingIndex = session.data.categories.indexOf(
                selectedCategoryIndex,
              );
              if (existingIndex > -1) {
                session.data.categories.splice(existingIndex, 1);
              } else {
                session.data.categories.push(selectedCategoryIndex);
              }
              await sendCategorySelectionMenu(session, message);
              return;
            }

            if (cleanText === "#FINISH_Tambah_Pasien") {
              // 1. Jika belum memilih kategori sama sekali, beri default 0 (Observasi)
              if (
                !session.data.categories ||
                session.data.categories.length === 0
              ) {
                session.data.categories = [0];
              }

              // 2. Tentukan ID unik dan Tanggal
              session.data.idPasien = `OPN-${Math.floor(1000 + Math.random() * 9000)}`;
              session.data.tanggalWaktu = new Date().toLocaleString("id-ID", {
                timeZone: "Asia/Jakarta",
              });

              // 3. (OPSIONAL/DIANJURKAN) Konversi ID Angka menjadi Teks Kategori agar JSON mudah dibaca
              const namaKategoriList = session.data.categories.map(
                (catId) => CATEGORIES_MAP[catId] || "Observasi Umum",
              );

              // 4. Susun struktur Object Pasien yang fix untuk disimpan ke JSON
              const dataPasienBaru = {
                idPasien: session.data.idPasien,
                tanggalWaktu: session.data.tanggalWaktu,
                namaOwner: session.data.namaOwner,
                namaKucing: session.data.namaKucing,
                noHp: session.data.noHp,
                isInfectious: session.data.isInfectious,
                isPetHotel: session.data.isPetHotel,
                categories: session.data.categories, // Menyimpan ID [1, 2, 3]
                categoriesNama: namaKategoriList, // Menyimpan Nama ["Muka", "Mata", "Hidung"]
                treatments: [],
              };

              // 5. Simpan ke database JSON
              PasienPasienDB.push(dataPasienBaru);
              saveData(PasienPasienDB);
              clearSession(jid);

              const daftarKategoriText = namaKategoriList
                .map((nama) => `• ${nama}`)
                .join("\n");

              await sock.sendMessage(
                jid,
                {
                  text: `🎉 *DATA PASIEN BERHASIL DISIMPAN!*\n\nID: ${dataPasienBaru.idPasien}\nOwner: ${dataPasienBaru.namaOwner}\nKucing: ${dataPasienBaru.namaKucing}\nStatus: ${dataPasienBaru.isInfectious ? "🔴 Infeksius" : "🟢 Non-Infeksius"}\n\n*Tubuh Yang Dipantau Progressnya:*\n${daftarKategoriText}`,
                  buttons: [
                    { text: "➕ Tambah Pasien Lagi", id: "#Tambah_Pasien" },
                    { text: "💊 Ke Menu Treatment", id: "#TREATMENT" },
                  ],
                },
                { quoted: message },
              );
              return;
            }
            if (cleanText === "#FINISH_Tambah_Pasien") {
              // 1. Jika belum memilih kategori sama sekali, beri default 0 (Observasi)
              if (
                !session.data.categories ||
                session.data.categories.length === 0
              ) {
                session.data.categories = [0];
              }

              // 2. Tentukan ID unik dan Tanggal
              session.data.idPasien = `OPN-${Math.floor(1000 + Math.random() * 9000)}`;
              session.data.tanggalWaktu = new Date().toLocaleString("id-ID", {
                timeZone: "Asia/Jakarta",
              });

              // 3. (OPSIONAL/DIANJURKAN) Konversi ID Angka menjadi Teks Kategori agar JSON mudah dibaca
              const namaKategoriList = session.data.categories.map(
                (catId) => CATEGORIES_MAP[catId] || "Observasi Umum",
              );

              // 4. Susun struktur Object Pasien yang fix untuk disimpan ke JSON
              const dataPasienBaru = {
                idPasien: session.data.idPasien,
                tanggalWaktu: session.data.tanggalWaktu,
                namaOwner: session.data.namaOwner,
                namaKucing: session.data.namaKucing,
                noHp: session.data.noHp,
                isInfectious: session.data.isInfectious,
                isPetHotel: session.data.isPetHotel,
                categories: session.data.categories, // Menyimpan ID [1, 2, 3]
                categoriesNama: namaKategoriList, // Menyimpan Nama ["Muka", "Mata", "Hidung"]
                treatments: [],
              };

              // 5. Simpan ke database JSON
              PasienPasienDB.push(dataPasienBaru);
              saveData(PasienPasienDB);
              clearSession(jid);

              const daftarKategoriText = namaKategoriList
                .map((nama) => `• ${nama}`)
                .join("\n");

              await sock.sendMessage(
                jid,
                {
                  text: `🎉 *DATA PASIEN BERHASIL DISIMPAN!*\n\nID: ${dataPasienBaru.idPasien}\nOwner: ${dataPasienBaru.namaOwner}\nKucing: ${dataPasienBaru.namaKucing}\nStatus: ${dataPasienBaru.isInfectious ? "🔴 Infeksius" : "🟢 Non-Infeksius"}\n\n*Tubuh Yang Dipantau Progressnya:*\n${daftarKategoriText}`,
                  buttons: [
                    { text: "➕ Tambah Pasien Lagi", id: "#Tambah_Pasien" },
                    { text: "💊 Ke Menu Treatment", id: "#TREATMENT" },
                  ],
                },
                { quoted: message },
              );
              return;
            }
          }

          // -------------------------------------------------------------------------
          // MODUL TREATMENT
          // -------------------------------------------------------------------------
          if (session.step === "SELECT_TREATMENT_MODULE") {
            const selectedModulKey = cleanText;

            if (selectedModulKey === "#MODUL_PIP_PUP") {
              setSession(jid, "WAITING_PIPPUP_MAIN_MENU", session.data);
              await sendPipPupMuntahMenu(session.data.patient, message);
              return;
            }

            if (selectedModulKey === "#MODUL_SISA_MAKANAN") {
              setSession(jid, "WAITING_SISA_MAKANAN_PHOTO", session.data);
              await sock.sendMessage(
                jid,
                {
                  text: "🍲 *SISA MAKANAN (Wajib Foto)*\n\n📸 Silakan kirim *Foto Sisa Makanan* Pasien:",
                  buttons: [{ text: "🔙 Kembali", id: "#BACK_TO_MODULE_MENU" }],
                },
                { quoted: message },
              );
              return;
            }

            if (selectedModulKey === "#MODUL_MAKAN") {
              setSession(jid, "WAITING_MAKAN_VIDEO", session.data);
              await sock.sendMessage(
                jid,
                {
                  text: "🍽️ *MAKAN (Wajib Video)*\n\n🎥 Silakan kirim *Video Pasien sedang Makan*:",
                  buttons: [{ text: "🔙 Kembali", id: "#BACK_TO_MODULE_MENU" }],
                },
                { quoted: message },
              );
              return;
            }

            if (selectedModulKey === "#MODUL_MINUM") {
              setSession(jid, "WAITING_MINUM_INPUT", session.data);
              await sock.sendMessage(
                jid,
                {
                  text: "🥤 *MINUM (Opsional)*\n\nKlik tombol *Minum Normal* atau langsung *Kirim Video Minum* Pasien:",
                  buttons: [
                    { text: "🥤 Minum Normal", id: "#MINUM_NORMAL" },
                    { text: "🔙 Kembali", id: "#BACK_TO_MODULE_MENU" },
                  ],
                },
                { quoted: message },
              );
              return;
            }

            if (selectedModulKey === "#MODUL_SUHU") {
              setSession(jid, "WAITING_SUHU_PHOTO", session.data);
              await sock.sendMessage(
                jid,
                {
                  text: "🌡️ *SUHU BADAN (Wajib Foto + Caption Suhu)*\n\n📸 Silakan kirim *Foto Thermometer* dan isi *angka suhunya pada caption foto* (Contoh: `38.9`):",
                  buttons: [{ text: "🔙 Kembali", id: "#BACK_TO_MODULE_MENU" }],
                },
                { quoted: message },
              );
              return;
            }

            if (selectedModulKey === "#MODUL_INFUS") {
              setSession(jid, "WAITING_INFUS_STATUS", session.data);
              await sock.sendMessage(
                jid,
                {
                  text: "💉 *INFUS*\n\nApakah Pasien menggunakan infus?",
                  buttons: [
                    { text: "✅ Ada Infus", id: "#INFUS_ADA" },
                    { text: "❌ Tidak Ada Infus", id: "#INFUS_TIDAK" },
                    { text: "🔙 Kembali", id: "#BACK_TO_MODULE_MENU" },
                  ],
                },
                { quoted: message },
              );
              return;
            }

            if (selectedModulKey === "#MODUL_KONDISI") {
              setSession(jid, "WAITING_KONDISI_Pasien", session.data);
              await sock.sendMessage(
                jid,
                {
                  text: "🩺 *Kondisi Pasien*\n\nPilih kondisi fisik Pasien:",
                  buttons: [
                    { text: "🏃 Aktif", id: "#KONDISI_AKTIF" },
                    { text: "⚖️ Stabil", id: "#KONDISI_STABIL" },
                    { text: "🥀 Lemas", id: "#KONDISI_LEMAS" },
                    { text: "🔙 Kembali", id: "#BACK_TO_MODULE_MENU" },
                  ],
                },
                { quoted: message },
              );
              return;
            }

            if (selectedModulKey === "#MODUL_OBAT") {
              setSession(jid, "WAITING_GENERIC_TEXT", {
                ...session.data,
                selectedModulName: "Treatment Obat",
              });
              await sock.sendMessage(
                jid,
                {
                  text: "💊 Ketik keterangan *Treatment Obat* yang diberikan:",
                  buttons: [{ text: "🔙 Kembali", id: "#BACK_TO_MODULE_MENU" }],
                },
                { quoted: message },
              );
              return;
            }
            if (selectedModulKey === "#MODUL_INJEKSI") {
              setSession(jid, "WAITING_INJEKSI_STATUS", session.data);
              await sock.sendMessage(
                jid,
                {
                  text: "💉 *INJEKSI PASIEN*\n\nPilih status injeksi:",
                  buttons: [
                    { text: "💉 Injeksi", id: "#INJEKSI_ADA" },
                    { text: "❌ Tidak Ada Injeksi", id: "#INJEKSI_TIDAK" },
                    { text: "🔙 Kembali", id: "#BACK_TO_MODULE_MENU" },
                  ],
                },
                { quoted: message },
              );
              return;
            }
            if (selectedModulKey === "#MODUL_PESAN_DOKTER") {
              setSession(jid, "WAITING_GENERIC_TEXT", {
                ...session.data,
                selectedModulName: "Pesan Dokter",
              });
              await sock.sendMessage(
                jid,
                {
                  text: `🩺 Ketik *Pesan Dokter* untuk pasien *${session.data.patient.namaKucing}*:`,
                  buttons: [{ text: "🔙 Kembali", id: "#BACK_TO_MODULE_MENU" }],
                },
                { quoted: message },
              );
              return;
            }
          }

          // PIP/PUP/MUNTAH HANDLING
          if (session.step === "WAITING_PIPPUP_MAIN_MENU") {
            // 1. KATEGORI PIP
            if (cleanText === "#PIPPUP_MENU_PIP") {
              setSession(jid, "WAITING_PIPPUP_SUB_OPTION", session.data);
              const patient = PasienPasienDB[session.data.targetIndex];

              await sock.sendMessage(
                jid,
                {
                  text: "💧 *DOKUMENTASI PIP*\n\nPilih kondisi PIP Pasien:",
                  buttons: [
                    {
                      text: getButtonText(
                        patient,
                        "Pip normal",
                        "💧 PIP Normal",
                      ),
                      id: "#SUB_PIP_NORMAL",
                    },
                    {
                      text: getButtonText(
                        patient,
                        "Pip berdarah",
                        "🩸 PIP Berdarah",
                      ),
                      id: "#SUB_PIP_BERDARAH",
                    },
                    {
                      text: getButtonText(patient, "tidak pip", "❌ Tidak PIP"),
                      id: "#SUB_NO_PIP",
                    },
                    { text: "🔙 Kembali", id: "#MODUL_PIP_PUP" },
                  ],
                },
                { quoted: message },
              );
              return;
            }

            // 2. KATEGORI PUP
            if (cleanText === "#PIPPUP_MENU_PUP") {
              setSession(jid, "WAITING_PIPPUP_SUB_OPTION", session.data);
              const patient = PasienPasienDB[session.data.targetIndex];

              await sock.sendMessage(
                jid,
                {
                  text: "💩 *DOKUMENTASI PUP*\n\nPilih kondisi PUP Pasien:",
                  buttons: [
                    {
                      text: getButtonText(
                        patient,
                        "Pup normal",
                        "💩 PUP Normal",
                      ),
                      id: "#SUB_PUP_NORMAL",
                    },
                    {
                      text: getButtonText(
                        patient,
                        "Pup berdarah",
                        "🩸 PUP Berdarah",
                      ),
                      id: "#SUB_PUP_BERDARAH",
                    },
                    {
                      text: getButtonText(patient, "Pup pasta", "🟡 PUP Pasta"),
                      id: "#SUB_PUP_PASTA",
                    },
                    {
                      text: getButtonText(patient, "Pup diare", "⚠️ PUP Diare"),
                      id: "#SUB_PUP_DIARE",
                    },
                    {
                      text: getButtonText(patient, "tidak pup", "❌ Tidak PUP"),
                      id: "#SUB_NO_PUP",
                    },
                    { text: "🔙 Kembali", id: "#MODUL_PIP_PUP" },
                  ],
                },
                { quoted: message },
              );
              return;
            }

            // 3. KATEGORI MUNTAH
            if (cleanText === "#PIPPUP_MENU_MUNTAH") {
              setSession(jid, "WAITING_PIPPUP_SUB_OPTION", session.data);
              const patient = PasienPasienDB[session.data.targetIndex];

              await sock.sendMessage(
                jid,
                {
                  text: "🤮 *DOKUMENTASI MUNTAH*\n\nPilih jenis muntahan Pasien:",
                  buttons: [
                    {
                      text: getButtonText(
                        patient,
                        "Muntah pakan",
                        "🥩 Muntah Pakan",
                      ),
                      id: "#SUB_MUNTAH_PAKAN",
                    },
                    {
                      text: getButtonText(
                        patient,
                        "Muntah bulu",
                        "🪶 Muntah Bulu",
                      ),
                      id: "#SUB_MUNTAH_BULU",
                    },
                    {
                      text: getButtonText(
                        patient,
                        "Muntah busa",
                        "🫧 Muntah Busa",
                      ),
                      id: "#SUB_MUNTAH_BUSA",
                    },
                    { text: "🔙 Kembali", id: "#MODUL_PIP_PUP" },
                  ],
                },
                { quoted: message },
              );
              return;
            }

            // 4. KATEGORI PIP & PUP
            if (cleanText === "#PIPPUP_MENU_PIPPUP") {
              setSession(jid, "WAITING_PIPPUP_SUB_OPTION", session.data);
              await sock.sendMessage(
                jid,
                {
                  text: "💧💩 *DOKUMENTASI PIP & PUP*\n\nPilih kondisi kombinasi:",
                  buttons: [
                    { text: "✅ Normal Semua", id: "#SUB_PIPPUP_NORMAL_SEMUA" },
                    { text: "⚠️ Kondisi Khusus", id: "#SUB_PIPPUP_KHUSUS" },
                    { text: "🔙 Kembali", id: "#MODUL_PIP_PUP" },
                  ],
                },
                { quoted: message },
              );
              return;
            }
          }

          if (session.step === "WAITING_PIPPUP_SUB_OPTION") {
            const subMap = {
              // PIP
              "#SUB_PIP_NORMAL": { type: "pip", value: "Pip normal" },
              "#SUB_PIP_BERDARAH": { type: "pip", value: "Pip berdarah" },
              "#SUB_NO_PIP": { type: "pip", value: "tidak pip" },

              // PUP
              "#SUB_PUP_NORMAL": { type: "pup", value: "Pup normal" },
              "#SUB_PUP_BERDARAH": { type: "pup", value: "Pup berdarah" },
              "#SUB_PUP_PASTA": { type: "pup", value: "Pup pasta" },
              "#SUB_PUP_DIARE": { type: "pup", value: "Pup diare" },
              "#SUB_NO_PUP": { type: "pup", value: "tidak pup" },

              // MUNTAH
              "#SUB_MUNTAH_PAKAN": { type: "muntah", value: "Muntah pakan" },
              "#SUB_MUNTAH_BULU": { type: "muntah", value: "Muntah bulu" },
              "#SUB_MUNTAH_BUSA": { type: "muntah", value: "Muntah busa" },

              // PIP & PUP
              "#SUB_PIPPUP_NORMAL_SEMUA": {
                type: "pippup_normal",
                value: "Pip Pup Normal",
              },
              "#SUB_PIPPUP_KHUSUS": {
                type: "pippup_khusus",
                value: "Kondisi Khusus",
              },
            };

            const selectedOption = subMap[cleanText];
            if (selectedOption) {
              if (selectedOption.type === "pippup_khusus") {
                setSession(jid, "WAITING_PIPPUP_KHUSUS_TEXT", {
                  ...session.data,
                  subType: selectedOption.type,
                  subValue: selectedOption.value,
                });
                await sock.sendMessage(
                  jid,
                  {
                    text: `⚠️ *KONDISI KHUSUS PIP & PUP*\n\nSilakan ketik penjelasan khusus terlebih dahulu (contoh: *pip berdarah dan pup cair*):`,
                  },
                  { quoted: message },
                );
                return;
              }

              setSession(jid, "WAITING_PIPPUP_MEDIA", {
                ...session.data,
                subType: selectedOption.type,
                subValue: selectedOption.value,
              });

              await sock.sendMessage(
                jid,
                {
                  text: `📸 Kirim *Foto / Video* bukti untuk status *${selectedOption.value}*:`,
                  buttons: [{ text: "🔙 Kembali", id: "#MODUL_PIP_PUP" }],
                },
                { quoted: message },
              );
              return;
            }
          }

          // HANDLER TEKS PENJELASAN KHUSUS PIP & PUP
          if (session.step === "WAITING_PIPPUP_KHUSUS_TEXT") {
            setSession(jid, "WAITING_PIPPUP_MEDIA", {
              ...session.data,
              penjelasanKhusus: cleanText,
            });

            await sock.sendMessage(
              jid,
              {
                text: `📸 Penjelasan dicatat: *${cleanText}*\n\nSekarang silakan kirim *Foto atau Video* bukti pendukungnya:`,
                buttons: [{ text: "🔙 Kembali", id: "#MODUL_PIP_PUP" }],
              },
              { quoted: message },
            );
            return;
          }

          // HANDLER SIMPAN MEDIA PIP/PUP/MUNTAH
          if (session.step === "WAITING_PIPPUP_MEDIA") {
            if (cleanText === "#MODUL_PIP_PUP") {
              setSession(jid, "WAITING_PIPPUP_MAIN_MENU", session.data);
              await sendPipPupMuntahMenu(session.data.patient, message);
              return;
            }

            if (!isImage && !isVideo) {
              await sock.sendMessage(
                jid,
                {
                  text: `⚠️ Mohon kirimkan *Foto atau Video* bukti untuk pendokumentasian ini!`,
                },
                { quoted: message },
              );
              return;
            }

            const targetIndex = session.data.targetIndex;
            const target = PasienPasienDB[targetIndex];
            const currentType = session.data.subType; // 'pip', 'pup', 'muntah', 'pippup_normal', atau 'pippup_khusus'

            // =========================================================================
            // 🔄 LOGIKA REMOVAL / OVERWRITE DOKUMENTASI LAMA
            // =========================================================================
            // Cari index treatment PIP/PUP yang perlu dihapus dari DB
            const indicesToRemove = [];

            target.treatments.forEach((t, idx) => {
              if (t.modul === "PIP/PUP/Muntah") {
                // Jika input baru adalah PIP/PUP Kombinasi (Normal Semua / Khusus) -> Hapus semua PIP & PUP lama
                if (
                  currentType === "pippup_normal" ||
                  currentType === "pippup_khusus"
                ) {
                  if (
                    t.subType === "pip" ||
                    t.subType === "pup" ||
                    t.subType === "pippup_normal" ||
                    t.subType === "pippup_khusus"
                  ) {
                    indicesToRemove.push(idx);
                  }
                }
                // Jika input baru adalah PIP saja -> Hapus PIP lama, pippup_normal, dan pippup_khusus
                else if (currentType === "pip") {
                  if (
                    t.subType === "pip" ||
                    t.subType === "pippup_normal" ||
                    t.subType === "pippup_khusus"
                  ) {
                    indicesToRemove.push(idx);
                  }
                }
                // Jika input baru adalah PUP saja -> Hapus PUP lama, pippup_normal, dan pippup_khusus
                else if (currentType === "pup") {
                  if (
                    t.subType === "pup" ||
                    t.subType === "pippup_normal" ||
                    t.subType === "pippup_khusus"
                  ) {
                    indicesToRemove.push(idx);
                  }
                }
                // Jika input baru adalah Muntah -> Hapus Muntah lama
                else if (currentType === "muntah") {
                  if (t.subType === "muntah") {
                    indicesToRemove.push(idx);
                  }
                }
              }
            });

            // Hapus file media & pesan grup staf dari treatment yang bentrok (dibalik dari index terbesar agar splicing aman)
            for (let i = indicesToRemove.length - 1; i >= 0; i--) {
              const removeIdx = indicesToRemove[i];
              const oldTreatment = target.treatments[removeIdx];

              if (oldTreatment.mediaPath) {
                await safeUnlink(oldTreatment.mediaPath);
              }
              if (oldTreatment.groupMsgKey && JID_GRUP_STAF) {
                try {
                  await sock.sendMessage(JID_GRUP_STAF, {
                    delete: oldTreatment.groupMsgKey,
                  });
                } catch (e) {
                  console.error("Gagal menghapus pesan lama di grup staf:", e);
                }
              }

              target.treatments.splice(removeIdx, 1);
            }
            // =========================================================================

            const mediaBuffer = await downloadMediaMessage(
              message,
              "buffer",
              {},
              { logger, reuploadRequest: sock.updateMediaMessage },
            );
            const ext = isVideo ? "mp4" : "jpg";
            const savedPath = path.join(
              MEDIA_DIR,
              `pippup_${Date.now()}.${ext}`,
            );
            await fs.promises.writeFile(savedPath, mediaBuffer);

            const captionText = `${session.data.subValue} ${target.namaKucing.toLowerCase()} (${formatOwnerName(target.namaOwner).toLowerCase()})`;

            let groupMsgKey = null;
            if (JID_GRUP_STAF && JID_GRUP_STAF.endsWith("@g.us")) {
              const payload = { caption: captionText };
              if (isVideo) payload.video = mediaBuffer;
              else payload.image = mediaBuffer;
              const sentMsg = await sock.sendMessage(JID_GRUP_STAF, payload);
              groupMsgKey = sentMsg.key;
            }

            target.treatments.push({
              modul: "PIP/PUP/Muntah",
              subType: session.data.subType,
              subValue: session.data.subValue,
              penjelasanKhusus: session.data.penjelasanKhusus || null,
              keterangan: captionText,
              mediaPath: savedPath,
              mediaType: isVideo ? "video" : "image",
              groupMsgKey,
            });
            saveData(PasienPasienDB);

            await sock.sendMessage(
              jid,
              {
                text: `✅ *Dokumentasi ${session.data.subValue} Berhasil Dicatat!*`,
              },
              { quoted: message },
            );

            setSession(jid, "WAITING_PIPPUP_MAIN_MENU", session.data);
            await sendPipPupMuntahMenu(target, message);
            return;
          }

          // SUB-HANDLER: SISA MAKANAN
          if (session.step === "WAITING_SISA_MAKANAN_PHOTO") {
            if (!isImage) {
              await sock.sendMessage(
                jid,
                { text: "⚠️ *Harap kirimkan Foto Sisa Makanan!*" },
                { quoted: message },
              );
              return;
            }

            const targetIndex = session.data.targetIndex;
            const target = PasienPasienDB[targetIndex];

            const oldTreatmentIndex = target.treatments.findIndex(
              (t) => t.modul === "NAMA_MODUL",
            );
            if (oldTreatmentIndex > -1) {
              const oldTreatment = target.treatments[oldTreatmentIndex];
              if (oldTreatment.mediaPath)
                await safeUnlink(oldTreatment.mediaPath);
              if (oldTreatment.groupMsgKey)
                await sock.sendMessage(JID_GRUP_STAF, {
                  delete: oldTreatment.groupMsgKey,
                });
              target.treatments.splice(oldTreatmentIndex, 1);
            }

            const mediaBuffer = await downloadMediaMessage(
              message,
              "buffer",
              {},
              { logger, reuploadRequest: sock.updateMediaMessage },
            );
            const savedPath = path.join(
              MEDIA_DIR,
              `sisa_makanan_${Date.now()}.jpg`,
            );
            await fs.promises.writeFile(savedPath, mediaBuffer);

            const captionText = `sisa makanan ${target.namaKucing.toLowerCase()}(${formatOwnerName(target.namaOwner).toLowerCase()})`;

            let groupMsgKey = null;
            if (JID_GRUP_STAF && JID_GRUP_STAF.endsWith("@g.us")) {
              const sentMsg = await sock.sendMessage(JID_GRUP_STAF, {
                image: mediaBuffer,
                caption: captionText,
              });
              groupMsgKey = sentMsg.key;
            }

            target.treatments.push({
              modul: "Sisa Makanan",
              keterangan: "Foto Sisa Makanan",
              mediaPath: savedPath,
              mediaType: "image",
              groupMsgKey,
            });
            saveData(PasienPasienDB);

            await sock.sendMessage(
              jid,
              { text: "✅ *Foto Sisa Makanan Berhasil Dicatat!*" },
              { quoted: message },
            );
            await sendTreatmentModuleMenu(targetIndex);
            return;
          }

          // SUB-HANDLER: MAKAN (VIDEO -> PILIHAN TOMBOL METHOD)
          if (session.step === "WAITING_MAKAN_VIDEO") {
            if (!isVideo) {
              await sock.sendMessage(
                jid,
                { text: "⚠️ *Harap kirimkan Video Makan Pasien!*" },
                { quoted: message },
              );
              return;
            }

            await sock.sendMessage(
              jid,
              { text: "⏳ Mengunduh & memproses video makan..." },
              { quoted: message },
            );

            const mediaBuffer = await downloadMediaMessage(
              message,
              "buffer",
              {},
              { logger, reuploadRequest: sock.updateMediaMessage },
            );
            const rawPath = path.join(MEDIA_DIR, `raw_makan_${Date.now()}.mp4`);
            const savedPath = path.join(MEDIA_DIR, `makan_${Date.now()}.mp4`);

            await fs.promises.writeFile(rawPath, mediaBuffer);
            try {
              await cropVideoToMaxDuration(rawPath, savedPath, 10);
            } finally {
              await safeUnlink(rawPath);
            }

            // Simpan sementara videoPath di session data
            setSession(jid, "WAITING_MAKAN_METHOD_CHOICE", {
              ...session.data,
              tempVideoPath: savedPath,
            });

            // Tampilkan pilihan tombol metode makan
            await sock.sendMessage(
              jid,
              {
                text: "🍽️ *METODE MAKAN*\n\nSilakan pilih kondisi/metode makan Pasien:",
                buttons: [
                  { text: "🥣 Makan Sendiri", id: "#MAKAN_SENDIRI" },
                  { text: "💉 Dibantu Spet", id: "#MAKAN_SPET" },
                  { text: "🍲 Disediakan Makan", id: "#MAKAN_DISEDIAKAN" },
                ],
              },
              { quoted: message },
            );
            return;
          }

          // SUB-HANDLER: PILIHAN METODE MAKAN (SIMPAN DATA & KIRIM GRUP)
          if (session.step === "WAITING_MAKAN_METHOD_CHOICE") {
            const methodMap = {
              "#MAKAN_SENDIRI": "Makan Sendiri",
              "#MAKAN_SPET": "Dibantu Spet",
              "#MAKAN_DISEDIAKAN": "Disediakan Makan",
            };

            const selectedMethod = methodMap[cleanText];
            if (!selectedMethod) return;

            const targetIndex = session.data.targetIndex;
            const target = PasienPasienDB[targetIndex];
            const savedPath = session.data.tempVideoPath;

            // Hapus treatment makan lama jika ada
            const oldTreatmentIndex = target.treatments.findIndex(
              (t) => t.modul === "Makan",
            );
            if (oldTreatmentIndex > -1) {
              const oldTreatment = target.treatments[oldTreatmentIndex];
              if (oldTreatment.mediaPath) {
                await safeUnlink(oldTreatment.mediaPath);
              }
              if (oldTreatment.groupMsgKey) {
                await sock.sendMessage(JID_GRUP_STAF, {
                  delete: oldTreatment.groupMsgKey,
                });
              }
              target.treatments.splice(oldTreatmentIndex, 1);
            }

            const captionText = `${target.namaKucing.toLowerCase()} ${selectedMethod.toLowerCase()}`;

            let groupMsgKey = null;
            if (JID_GRUP_STAF && JID_GRUP_STAF.endsWith("@g.us")) {
              const sentMsg = await sock.sendMessage(JID_GRUP_STAF, {
                video: await fs.promises.readFile(savedPath),
                caption: captionText,
              });
              groupMsgKey = sentMsg.key;
            }

            // Simpan data treatment ke database
            target.treatments.push({
              modul: "Makan",
              keterangan: selectedMethod,
              mediaPath: savedPath,
              mediaType: "video",
              groupMsgKey,
            });
            saveData(PasienPasienDB);

            await sock.sendMessage(
              jid,
              {
                text: `✅ *Status Makan (${selectedMethod}) Berhasil Dicatat!*`,
              },
              { quoted: message },
            );

            // Kembali otomatis ke menu modul treatment
            await sendTreatmentModuleMenu(targetIndex);
            return;
          }

          // SUB-HANDLER: MINUM
          if (session.step === "WAITING_MINUM_INPUT") {
            const targetIndex = session.data.targetIndex;
            const target = PasienPasienDB[targetIndex];

            const oldTreatmentIndex = target.treatments.findIndex(
              (t) => t.modul === "Minum",
            );
            if (oldTreatmentIndex > -1) {
              const oldTreatment = target.treatments[oldTreatmentIndex];
              if (oldTreatment.mediaPath) {
                await safeUnlink(oldTreatment.mediaPath);
              }
              if (oldTreatment.groupMsgKey) {
                await sock.sendMessage(JID_GRUP_STAF, {
                  delete: oldTreatment.groupMsgKey,
                });
              }
              target.treatments.splice(oldTreatmentIndex, 1);
            }

            if (cleanText === "#MINUM_NORMAL") {
              target.treatments.push({
                modul: "Minum",
                keterangan: "Minum Normal",
              });
              saveData(PasienPasienDB);
              await sock.sendMessage(
                jid,
                { text: "✅ Status *Minum Normal* Berhasil Dicatat!" },
                { quoted: message },
              );
              await sendTreatmentModuleMenu(targetIndex);
              return;
            }

            if (isVideo) {
              await sock.sendMessage(
                jid,
                { text: "⏳ Mengunduh & memproses video minum..." },
                { quoted: message },
              );

              const mediaBuffer = await downloadMediaMessage(
                message,
                "buffer",
                {},
                { logger, reuploadRequest: sock.updateMediaMessage },
              );
              const rawPath = path.join(
                MEDIA_DIR,
                `raw_minum_${Date.now()}.mp4`,
              );
              const savedPath = path.join(MEDIA_DIR, `minum_${Date.now()}.mp4`);

              await fs.promises.writeFile(rawPath, mediaBuffer);
              try {
                await cropVideoToMaxDuration(rawPath, savedPath, 10);
              } finally {
                await safeUnlink(rawPath);
              }

              const captionText = `${target.namaKucing.toLowerCase()}(${formatOwnerName(target.namaOwner).toLowerCase()}) minum normal`;

              let groupMsgKey = null;
              if (JID_GRUP_STAF && JID_GRUP_STAF.endsWith("@g.us")) {
                const sentMsg = await sock.sendMessage(JID_GRUP_STAF, {
                  video: await fs.promises.readFile(savedPath),
                  caption: captionText,
                });
                groupMsgKey = sentMsg.key;
              }

              target.treatments.push({
                modul: "Minum",
                keterangan: "Minum Normal",
                mediaPath: savedPath,
                mediaType: "video",
                groupMsgKey,
              });
              saveData(PasienPasienDB);

              await sock.sendMessage(
                jid,
                { text: "✅ *Video Minum Berhasil Dicatat!*" },
                { quoted: message },
              );
              await sendTreatmentModuleMenu(targetIndex);
              return;
            }
          }

          // SUB-HANDLER: SUHU BADAN (FOTO + CAPTION TEKS SUHU)
          if (session.step === "WAITING_SUHU_PHOTO") {
            // Ambil teks caption
            const captionText = text || cleanText || "";

            // Ekstrak angka (mendukung desimal dengan koma atau titik)
            const extractedNum = captionText
              .replace(/,/g, ".")
              .match(/\d+(\.\d+)?/);
            const suhuVal = extractedNum ? parseFloat(extractedNum[0]) : null;

            // Validasi: Pastikan angka ditemukan dan berada dalam rentang suhu tubuh wajar (misal: 30 - 45 °C)
            if (!suhuVal || isNaN(suhuVal) || suhuVal < 30 || suhuVal > 45) {
              await sock.sendMessage(jid, {
                text: "⚠️ **Format suhu tidak valid!**\n\nMohon kirimkan foto thermometer *beserta caption* angka suhunya yang jelas (contoh: 36,5).",
              });
              return; // Hentikan proses, jangan ubah/lanjutkan state
            }

            if (!isImage) {
              await sock.sendMessage(
                jid,
                {
                  text: "⚠️ *Harap kirimkan Foto Thermometer beserta caption angka suhunya!* (Contoh: `38.9`)",
                },
                { quoted: message },
              );
              return;
            }

            if (!suhuVal) {
              await sock.sendMessage(
                jid,
                {
                  text: "⚠️ *Harap masukkan angka suhu pada caption foto!* (Contoh kirim foto dengan caption: `38.9`)",
                },
                { quoted: message },
              );
              return;
            }
            const targetIndex = session.data.targetIndex;
            const target = PasienPasienDB[targetIndex];

            // Hapus data treatment suhu lama jika ada
            const oldTreatmentIndex = target.treatments.findIndex(
              (t) => t.modul === "Suhu Badan",
            );
            if (oldTreatmentIndex > -1) {
              const oldTreatment = target.treatments[oldTreatmentIndex];
              if (oldTreatment.mediaPath) {
                await safeUnlink(oldTreatment.mediaPath);
              }
              if (oldTreatment.groupMsgKey) {
                await sock.sendMessage(JID_GRUP_STAF, {
                  delete: oldTreatment.groupMsgKey,
                });
              }
              target.treatments.splice(oldTreatmentIndex, 1);
            }

            const mediaBuffer = await downloadMediaMessage(
              message,
              "buffer",
              {},
              { logger, reuploadRequest: sock.updateMediaMessage },
            );
            const savedPath = path.join(MEDIA_DIR, `suhu_${Date.now()}.jpg`);
            await fs.promises.writeFile(savedPath, mediaBuffer);

            const captionGrup = `suhu ${suhuVal}°C - ${target.namaKucing.toLowerCase()} (${formatOwnerName(target.namaOwner).toLowerCase()})`;

            let groupMsgKey = null;
            if (JID_GRUP_STAF && JID_GRUP_STAF.endsWith("@g.us")) {
              const sentMsg = await sock.sendMessage(JID_GRUP_STAF, {
                image: mediaBuffer,
                caption: captionGrup,
              });
              groupMsgKey = sentMsg.key;
            }

            // Simpan angka suhu ke keterangan
            target.treatments.push({
              modul: "Suhu Badan",
              keterangan: suhuVal,
              mediaPath: savedPath,
              mediaType: "image",
              groupMsgKey,
            });
            saveData(PasienPasienDB);

            await sock.sendMessage(
              jid,
              {
                text: `✅ *Foto Suhu Badan (${suhuVal}°C) Berhasil Dicatat!*`,
              },
              { quoted: message },
            );
            await sendTreatmentModuleMenu(targetIndex);
            return;
          }

          // =========================================================================
          // HANDLER MODUL PROGRESS PASIEN
          // =========================================================================
          if (cleanText === "#MODUL_PROGRESS_DISEASE") {
            const patient = session.data.patient;
            const categoriesNama = patient.categoriesNama || [];

            if (
              categoriesNama.length === 0 ||
              (categoriesNama.length === 1 &&
                categoriesNama[0] === "Observasi Umum")
            ) {
              await sock.sendMessage(
                jid,
                {
                  text: `⚠️ Pasien *${patient.namaKucing}* tidak memiliki daftar pemantauan bagian tubuh khusus (Observasi Umum).`,
                  buttons: [{ text: "🔙 Kembali", id: "#BACK_TO_MODULE_MENU" }],
                },
                { quoted: message },
              );
              return;
            }

            const categoryButtons = categoriesNama.map((namaKategori) => {
              const isFilled = (patient.treatments || []).some(
                (t) =>
                  t.modul === "Dokumentasi Progress" &&
                  t.bodyPart === namaKategori &&
                  t.uploud === "success",
              );

              return {
                text: `${isFilled ? "✅" : ""}${namaKategori}`,
                id: `#PROGRESS_PART_${namaKategori.toUpperCase()}`,
              };
            });

            categoryButtons.push({
              text: "🔙 Kembali ke Menu Modul",
              id: "#BACK_TO_MODULE_MENU",
            });

            setSession(
              jid,
              "WAITING_PROGRESS_BODY_PART_SELECTION",
              session.data,
            );

            await sock.sendMessage(
              jid,
              {
                text: `🩺 *DOKUMENTASI PROGRESS PASIEN (${patient.namaKucing})*\n\nPilih bagian tubuh yang ingin didokumentasikan progressnya:`,
                buttons: categoryButtons,
              },
              { quoted: message },
            );
            return;
          }

          // =========================================================================
          // HANDLER SELEKSI BAGIAN TUBUH UNTUK PROGRESS PASIEN
          // =========================================================================
          if (session.step === "WAITING_PROGRESS_BODY_PART_SELECTION") {
            if (cleanText.startsWith("#PROGRESS_PART_")) {
              const selectedPartRaw =
                cleanText.replace("#PROGRESS_PART_", "") || "";
              const patient = session.data.patient;
              const matchedPart =
                (patient?.categoriesNama || []).find(
                  (cat) =>
                    (cat || "").toUpperCase() === selectedPartRaw.toUpperCase(),
                ) || selectedPartRaw;

              // Simpan organ yang dipilih
              setSession(jid, "WAITING_PROGRESS_TIMING_SELECTION", {
                ...session.data,
                selectedBodyPart: matchedPart,
              });
              const filterType = cleanText.replace("#TREATMENT_FILTER_", "");

              const targetIndex = session.data.targetIndex;
              const treatmentsList = PasienPasienDB[targetIndex].treatments;
              const treatmentIndexBefore = treatmentsList.findIndex(
                (t) =>
                  t.bodyPart === matchedPart &&
                  t.stage === "Sebelum dibersihkan" &&
                  t.modul === "Dokumentasi Progress",
              );
              const treatmentIndexAfter = treatmentsList.findIndex(
                (t) =>
                  t.bodyPart === matchedPart &&
                  t.stage === "Sesudah dibersihkan" &&
                  t.modul === "Dokumentasi Progress",
              );
              const dataBefore =
                PasienPasienDB[targetIndex].treatments[treatmentIndexBefore] ||
                "";
              const dataAfter =
                PasienPasienDB[targetIndex].treatments[treatmentIndexAfter] ||
                "";
              const hasDoneBefore =
                dataBefore.stage === "Sebelum dibersihkan" ? "✅" : "";
              const hasDoneAfter =
                dataAfter.stage === "Sesudah dibersihkan" ? "✅" : "";

              const displayPart = (matchedPart || "").toUpperCase();

              await sock.sendMessage(
                jid,
                {
                  text: `🩺 *DOKUMENTASI PROGRESS: ${displayPart} (${patient.namaKucing})*\n\nPilih opsi kondisi dokumentasi:`,
                  buttons: [
                    {
                      text: `⏳ Sebelum Dibersihkan ${hasDoneBefore}`,
                      id: "#PROGRESS_BEFORE",
                    },
                    {
                      text: `✨ Sesudah Dibersihkan ${hasDoneAfter}`,
                      id: "#PROGRESS_AFTER",
                    },
                    {
                      text: "🔙 Kembali Pilih Organ",
                      id: "#MODUL_PROGRESS_DISEASE",
                    },
                  ],
                },
                { quoted: message },
              );
              return;
            }
          }

          // =========================================================================
          // HANDLER PILIHAN SEBELUM / SESUDAH / KEMBALI
          // =========================================================================
          if (session.step === "WAITING_PROGRESS_TIMING_SELECTION") {
            if (cleanText === "#MODUL_PROGRESS_DISEASE") {
              // Jika memilih Kembali, arahkan ulang ke daftar pilih organ
              delete session.data.selectedBodyPart;
              // Panggil ulang menu modul progress pasien
              cleanText = "#MODUL_PROGRESS_DISEASE";
            } else if (
              cleanText === "#PROGRESS_BEFORE" ||
              cleanText === "#PROGRESS_AFTER"
            ) {
              const isBefore = cleanText === "#PROGRESS_BEFORE";
              const timingLabel = isBefore
                ? "Sebelum Dibersihkan"
                : "Sesudah Dibersihkan";
              const timingCode = isBefore
                ? "Sebelum dibersihkan"
                : "Sesudah dibersihkan";

              setSession(jid, "WAITING_PROGRESS_MEDIA", {
                ...session.data,
                progressTiming: timingCode,
                progressTimingLabel: timingLabel,
              });

              await sock.sendMessage(
                jid,
                {
                  text: `📸 *Progress ${session.data.selectedBodyPart} - ${timingLabel} (${session.data.patient.namaKucing})*\n\nSilakan kirimkan *Foto atau Video* kondisi organ *${session.data.selectedBodyPart}* (${timingLabel.toLowerCase()}):`,
                  buttons: [
                    { text: "🔙 Kembali", id: "#PROGRESS_RESELECT_TIMING" },
                  ],
                },
                { quoted: message },
              );
              return;
            }
          }

          // 2. Saat User Mengirim Media (Foto/Video)
          if (session.step === "WAITING_PROGRESS_MEDIA") {
            if (!isImage && !isVideo) {
              await sock.sendMessage(
                jid,
                { text: "⚠️ Mohon kirimkan bukti berupa Foto atau Video!" },
                { quoted: message },
              );
              return;
            }

            const targetIndex = session.data.targetIndex;
            const target = PasienPasienDB[targetIndex];
            const stage = session.data.progressTiming;
            const bodyPart = session.data.selectedBodyPart;

            const mediaBuffer = await downloadMediaMessage(
              message,
              "buffer",
              {},
              { logger, reuploadRequest: sock.updateMediaMessage },
            );

            const ext = isVideo ? "mp4" : "jpg";
            const savedPath = path.join(
              MEDIA_DIR,
              `progress_${bodyPart}_${stage}_${Date.now()}.${ext}`,
            );
            await fs.promises.writeFile(savedPath, mediaBuffer);

            const captionGrup = `${bodyPart} ${target.namaKucing} ${stage}`;

            let groupMsgKey = null;
            if (JID_GRUP_STAF && JID_GRUP_STAF.endsWith("@g.us")) {
              const payload = { caption: captionGrup };
              if (isVideo) payload.video = mediaBuffer;
              else payload.image = mediaBuffer;

              try {
                const sentMsg = await sock.sendMessage(JID_GRUP_STAF, payload);
                groupMsgKey = sentMsg.key;
              } catch (err) {
                console.error(
                  "❌ Gagal mengirim progress pasien ke grup staf:",
                  err,
                );
              }
            }

            // Hapus dokumentasi lama dengan organ & stage yang sama jika ada (Overwrite)
            target.treatments = target.treatments.filter(
              (t) =>
                !(
                  t.modul === "Dokumentasi Progress" &&
                  t.bodyPart === bodyPart &&
                  t.stage === stage
                ),
            );

            // Simpan treatment baru
            target.treatments.push({
              modul: "Dokumentasi Progress",
              bodyPart: bodyPart,
              stage: stage,
              keterangan: `${bodyPart} ${target.namaKucing} ${stage}`,
              mediaPath: savedPath,
              mediaType: isVideo ? "video" : "image",
              uploud: "pending",
            });

            const hasSebelum = target.treatments.some(
              (t) =>
                t.modul === "Dokumentasi Progress" &&
                t.bodyPart === bodyPart &&
                t.stage === "Sebelum dibersihkan",
            );
            const hasSesudah = target.treatments.some(
              (t) =>
                t.modul === "Dokumentasi Progress" &&
                t.bodyPart === bodyPart &&
                t.stage === "Sesudah dibersihkan",
            );

            // 3. JIKA KEDUA PROGRESS SUDAH TERISI, TAMBAHKAN PERINGKAT/KETERANGAN "uploud": "success" KE KEDUA TREATMENT TERSEBUT
            if (hasSebelum && hasSesudah) {
              target.treatments.forEach((t) => {
                if (
                  t.modul === "Dokumentasi Progress" &&
                  t.bodyPart === bodyPart &&
                  (t.stage === "Sebelum dibersihkan" ||
                    t.stage === "Sesudah dibersihkan")
                ) {
                  t.uploud = "success";
                }
              });
            }

            saveData(PasienPasienDB);

            await sock.sendMessage(
              jid,
              {
                text:
                  `✅ Berhasil menyimpan foto/video *${bodyPart}* *${target.namaKucing}* *${stage}*` +
                  (hasSebelum && hasSesudah
                    ? `\n🎉 *Progress ${bodyPart} Lengkap (Upload Success)!*`
                    : ""),
              },
              { quoted: message },
            );
            await sendTreatmentModuleMenu(targetIndex);
            return;
          }

          // SUB-HANDLER: INFUS
          if (session.step === "WAITING_INFUS_STATUS") {
            const targetIndex = session.data.targetIndex;
            if (cleanText === "#INFUS_TIDAK") {
              const target = PasienPasienDB[targetIndex];
              const oldTreatmentIndex = target.treatments.findIndex(
                (t) => t.modul === "Infus",
              );
              if (oldTreatmentIndex > -1) {
                const oldTreatment = target.treatments[oldTreatmentIndex];
                if (oldTreatment.mediaPath) {
                  await safeUnlink(oldTreatment.mediaPath);
                }
                if (oldTreatment.groupMsgKey) {
                  await sock.sendMessage(JID_GRUP_STAF, {
                    delete: oldTreatment.groupMsgKey,
                  });
                }
                target.treatments.splice(oldTreatmentIndex, 1);
              }

              target.treatments.push({
                modul: "Infus",
                keterangan: "Tidak Ada Infus",
              });
              saveData(PasienPasienDB);

              await sock.sendMessage(
                jid,
                { text: "✅ Status Infus dicatat: *Tidak Ada*" },
                { quoted: message },
              );
              await sendTreatmentModuleMenu(targetIndex);
              return;
            }

            if (cleanText === "#INFUS_ADA") {
              setSession(jid, "WAITING_INFUS_JALAN_STATUS", session.data);
              await sock.sendMessage(
                jid,
                {
                  text: "💉 *KONDISI INFUS*\n\nApakah tetesan infus berjalan lancar?",
                  buttons: [
                    { text: "▶️ Infus Jalan", id: "#INFUS_JALAN" },
                    { text: "⏹️ Tidak Jalan", id: "#INFUS_MACET" },
                    { text: "🔙 Kembali", id: "#BACK_TO_MODULE_MENU" },
                  ],
                },
                { quoted: message },
              );
              return;
            }
          }

          if (session.step === "WAITING_INFUS_JALAN_STATUS") {
            const targetIndex = session.data.targetIndex;
            if (cleanText === "#INFUS_JALAN") {
              setSession(jid, "WAITING_INFUS_VIDEO", session.data);
              await sock.sendMessage(
                jid,
                {
                  text: "🎥 *Kirim 1 Video Infus Jalan* sebagai bukti pengerjaan:",
                  buttons: [{ text: "🔙 Kembali", id: "#BACK_TO_MODULE_MENU" }],
                },
                { quoted: message },
              );
              return;
            } else if (cleanText === "#INFUS_MACET") {
              const target = PasienPasienDB[targetIndex];
              const oldTreatmentIndex = target.treatments.findIndex(
                (t) => t.modul === "Infus",
              );
              if (oldTreatmentIndex > -1) {
                const oldTreatment = target.treatments[oldTreatmentIndex];
                if (oldTreatment.mediaPath) {
                  await safeUnlink(oldTreatment.mediaPath);
                }
                if (oldTreatment.groupMsgKey) {
                  await sock.sendMessage(JID_GRUP_STAF, {
                    delete: oldTreatment.groupMsgKey,
                  });
                }
                target.treatments.splice(oldTreatmentIndex, 1);
              }

              target.treatments.push({
                modul: "Infus",
                keterangan: "Ada Infus (Tidak Jalan)",
              });
              saveData(PasienPasienDB);

              if (JID_GRUP_STAF && JID_GRUP_STAF.endsWith("@g.us")) {
                await sock.sendMessage(JID_GRUP_STAF, {
                  text: `infus macet untuk ${target.namaKucing.toLowerCase()}`,
                });
              }

              await sock.sendMessage(
                jid,
                { text: "✅ Status Infus dicatat: *Ada (Tidak Jalan)*" },
                { quoted: message },
              );
              await sendTreatmentModuleMenu(targetIndex);
              return;
            }
          }

          if (session.step === "WAITING_INFUS_VIDEO" && isVideo) {
            const targetIndex = session.data.targetIndex;
            const target = PasienPasienDB[targetIndex];

            const oldTreatmentIndex = target.treatments.findIndex(
              (t) => t.modul === "Infus",
            );
            if (oldTreatmentIndex > -1) {
              const oldTreatment = target.treatments[oldTreatmentIndex];
              if (oldTreatment.mediaPath) {
                await safeUnlink(oldTreatment.mediaPath);
              }
              if (oldTreatment.groupMsgKey) {
                await sock.sendMessage(JID_GRUP_STAF, {
                  delete: oldTreatment.groupMsgKey,
                });
              }
              target.treatments.splice(oldTreatmentIndex, 1);
            }

            await sock.sendMessage(
              jid,
              { text: "⏳ Mengunduh & memproses video infus..." },
              { quoted: message },
            );

            const mediaBuffer = await downloadMediaMessage(
              message,
              "buffer",
              {},
              { logger, reuploadRequest: sock.updateMediaMessage },
            );
            const rawPath = path.join(MEDIA_DIR, `raw_${Date.now()}.mp4`);
            const savedPath = path.join(MEDIA_DIR, `infus_${Date.now()}.mp4`);

            await fs.promises.writeFile(rawPath, mediaBuffer);
            try {
              await cropVideoToMaxDuration(rawPath, savedPath, 10);
            } finally {
              await safeUnlink(rawPath);
            }

            let groupMsgKey = null;
            if (JID_GRUP_STAF && JID_GRUP_STAF.endsWith("@g.us")) {
              const sentMsg = await sock.sendMessage(JID_GRUP_STAF, {
                video: await fs.promises.readFile(savedPath),
                caption: `infus jalan ${target.namaKucing.toLowerCase()}(${formatOwnerName(target.namaOwner).toLowerCase()})`,
              });
              groupMsgKey = sentMsg.key;
            }

            target.treatments.push({
              modul: "Infus",
              keterangan: "Ada Infus (Jalan)",
              mediaPath: savedPath,
              mediaType: "video",
              groupMsgKey,
            });
            saveData(PasienPasienDB);

            await sock.sendMessage(
              jid,
              { text: "✅ *Video Infus Jalan Berhasil Dicatat!*" },
              { quoted: message },
            );
            await sendTreatmentModuleMenu(targetIndex);
            return;
          }

          // SUB-HANDLER: INJEKSI
          if (session.step === "WAITING_INJEKSI_STATUS") {
            const targetIndex = session.data.targetIndex;
            const target = PasienPasienDB[targetIndex];

            if (cleanText === "#INJEKSI_TIDAK") {
              // Hapus treatment injeksi lama jika ada
              const oldIndex = target.treatments.findIndex(
                (t) => t.modul === "Injeksi",
              );
              if (oldIndex > -1) {
                const oldTreatment = target.treatments[oldIndex];
                if (Array.isArray(oldTreatment.videos)) {
                  for (const vid of oldTreatment.videos) {
                    if (vid.mediaPath) await safeUnlink(vid.mediaPath);
                    if (vid.groupMsgKey && JID_GRUP_STAF) {
                      try {
                        await sock.sendMessage(JID_GRUP_STAF, {
                          delete: vid.groupMsgKey,
                        });
                      } catch (e) {
                        console.error(
                          "Gagal menghapus pesan injeksi di grup:",
                          e,
                        );
                      }
                    }
                  }
                }
                target.treatments.splice(oldIndex, 1);
              }

              target.treatments.push({
                modul: "Injeksi",
                keterangan: "Tidak ada injeksi",
              });
              saveData(PasienPasienDB);

              await sock.sendMessage(
                jid,
                { text: "✅ Status *Tidak Ada Injeksi* berhasil dicatat!" },
                { quoted: message },
              );
              await sendTreatmentModuleMenu(targetIndex);
              return;
            }

            if (cleanText === "#INJEKSI_ADA") {
              setSession(jid, "WAITING_INJEKSI_VIDEO", {
                ...session.data,
                injeksiVideos: [],
              });
              await sock.sendMessage(
                jid,
                {
                  text: "🎥 *KIRIM VIDEO INJEKSI*\n\nSilakan kirimkan *Video Injeksi Pasien* beserta *penjelasannya pada caption video*!\n\n💡 *Bisa kirim lebih dari 1 video.* Jika sudah selesai mengirim semua video, tekan tombol *Selesai* di bawah.\n\n⚠️ *Dilarang mengirim foto!*",
                  buttons: [
                    {
                      text: "✅ Selesai Kirim Video",
                      id: "#FINISH_INJEKSI_VIDEO",
                    },
                  ],
                },
                { quoted: message },
              );
              return;
            }
          }

          if (session.step === "WAITING_INJEKSI_VIDEO") {
            const targetIndex = session.data.targetIndex;
            const target = PasienPasienDB[targetIndex];

            // Jika user menekan tombol Selesai Kirim Video
            if (cleanText === "#FINISH_INJEKSI_VIDEO") {
              const videos = session.data.injeksiVideos || [];
              if (videos.length === 0) {
                await sock.sendMessage(
                  jid,
                  {
                    text: "⚠️ *Belum ada video yang dikirim!* Kirimkan minimal 1 video injeksi terlebih dahulu.",
                  },
                  { quoted: message },
                );
                return;
              }

              // Gabungkan keterangan dari semua video
              const totalKeterangan = videos
                .map((v, i) => `${i + 1}. ${v.keterangan}`)
                .join("\n");

              // Hapus treatment injeksi lama jika ada
              const oldIndex = target.treatments.findIndex(
                (t) => t.modul === "Injeksi",
              );
              if (oldIndex > -1) {
                if (Array.isArray(target.treatments[oldIndex].videos)) {
                  for (const vid of target.treatments[oldIndex].videos) {
                    await safeUnlink(vid.mediaPath);
                  }
                }
                target.treatments.splice(oldIndex, 1);
              }

              target.treatments.push({
                modul: "Injeksi",
                keterangan: totalKeterangan,
                videos: videos, // Simpan daftar video
              });
              saveData(PasienPasienDB);

              await sock.sendMessage(
                jid,
                {
                  text: `✅ Berhasil menyimpan *${videos.length} Video Injeksi*!`,
                },
                { quoted: message },
              );
              await sendTreatmentModuleMenu(targetIndex);
              return;
            }

            // Validasi jika yang dikirim adalah foto
            if (isImage) {
              await sock.sendMessage(
                jid,
                {
                  text: "❌ *DILARANG KIRIM FOTO!*\n\nMohon kirimkan bukti berupa *VIDEO* injeksi beserta penjelasannya pada caption.",
                },
                { quoted: message },
              );
              return;
            }

            if (!isVideo) {
              await sock.sendMessage(
                jid,
                {
                  text: "⚠️ *Harap kirimkan VIDEO injeksi beserta penjelasan pada caption!*",
                },
                { quoted: message },
              );
              return;
            }

            const captionPenjelasan = text || cleanText || "";
            if (!captionPenjelasan) {
              await sock.sendMessage(
                jid,
                {
                  text: "⚠️ *Harap tuliskan penjelasan/nama obat pada caption video!*",
                },
                { quoted: message },
              );
              return;
            }

            await sock.sendMessage(
              jid,
              { text: "⏳ Mengunduh & memproses video..." },
              { quoted: message },
            );

            const mediaBuffer = await downloadMediaMessage(
              message,
              "buffer",
              {},
              { logger, reuploadRequest: sock.updateMediaMessage },
            );
            const rawPath = path.join(
              MEDIA_DIR,
              `raw_injeksi_${Date.now()}.mp4`,
            );
            const savedPath = path.join(MEDIA_DIR, `injeksi_${Date.now()}.mp4`);

            await fs.promises.writeFile(rawPath, mediaBuffer);
            try {
              await cropVideoToMaxDuration(rawPath, savedPath, 10);
            } finally {
              await safeUnlink(rawPath);
            }

            let groupMsgKey = null;
            if (JID_GRUP_STAF && JID_GRUP_STAF.endsWith("@g.us")) {
              const sentMsg = await sock.sendMessage(JID_GRUP_STAF, {
                video: await fs.promises.readFile(savedPath),
                caption: `injeksi ${target.namaKucing.toLowerCase()} - ${captionPenjelasan}`,
              });
              groupMsgKey = sentMsg.key;
            }

            // Masukkan ke array temporary sesi
            const updatedVideos = session.data.injeksiVideos || [];
            updatedVideos.push({
              keterangan: captionPenjelasan,
              mediaPath: savedPath,
              groupMsgKey,
            });

            setSession(jid, "WAITING_INJEKSI_VIDEO", {
              ...session.data,
              injeksiVideos: updatedVideos,
            });

            await sock.sendMessage(
              jid,
              {
                text: `✅ *Video ke-${updatedVideos.length} berhasil diterima!*\n\nKirim video lainnya atau klik tombol di bawah jika sudah selesai.`,
                buttons: [
                  {
                    text: "✅ Selesai Kirim Video",
                    id: "#FINISH_INJEKSI_VIDEO",
                  },
                ],
              },
              { quoted: message },
            );
            return;
          }

          if (session.step === "WAITING_KONDISI_Pasien") {
            const targetIndex = session.data.targetIndex;
            let kond = "Aktif";
            if (cleanText === "#KONDISI_STABIL") kond = "Stabil";
            if (cleanText === "#KONDISI_LEMAS") kond = "Lemas";

            const target = PasienPasienDB[targetIndex];
            const oldTreatmentIndex = target.treatments.findIndex(
              (t) => t.modul === "Kondisi Pasien",
            );
            if (oldTreatmentIndex > -1) {
              const oldTreatment = target.treatments[oldTreatmentIndex];
              if (oldTreatment.groupMsgKey) {
                await sock.sendMessage(JID_GRUP_STAF, {
                  delete: oldTreatment.groupMsgKey,
                });
              }
              target.treatments.splice(oldTreatmentIndex, 1);
            }

            target.treatments.push({
              modul: "Kondisi Pasien",
              keterangan: kond,
            });
            saveData(PasienPasienDB);

            await sock.sendMessage(
              jid,
              { text: `✅ Kondisi Pasien dicatat: *${kond}*` },
              { quoted: message },
            );
            await sendTreatmentModuleMenu(targetIndex);
            return;
          }

          // SUB-HANDLER: TEKS GENERIK (Treatment Obat & Pesan Dokter)
          if (session.step === "WAITING_GENERIC_TEXT") {
            const targetIndex = session.data.targetIndex;
            const target = PasienPasienDB[targetIndex];
            const modulName = session.data.selectedModulName;

            const oldIndex = target.treatments.findIndex(
              (t) => t.modul === modulName,
            );
            if (oldIndex > -1) {
              target.treatments.splice(oldIndex, 1);
            }

            target.treatments.push({
              modul: modulName,
              keterangan: cleanText,
            });
            saveData(PasienPasienDB);

            await sock.sendMessage(
              jid,
              { text: `✅ *${modulName}* berhasil dicatat!` },
              { quoted: message },
            );
            await sendTreatmentModuleMenu(targetIndex);
            return;
          }
        }
      } catch (err) {
        console.error("❌ Terjadi kesalahan saat memproses pesan:", err);
      }
    }
  });
};

// =========================================================================
// EKSEKUSI APLIKASI
// // =========================================================================
// console.log("🧪 Memulai pembersihan awal...");
// clearMediaFolder();
// resetDailyTreatments();

connectToWhatsApp();
