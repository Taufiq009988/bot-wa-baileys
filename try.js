const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");

// Memory sementara
const userSessions = {};
const pasienOpnameDB = []; // Menyimpan list pasien opname

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const message of messages) {
      if (!message.message) continue;

      const jid = message.key.remoteJid;

      // Tangkap input teks biasa ATAU ID Tombol yang diklik user
      const text =
        message.message.conversation ||
        message.message.extendedTextMessage?.text ||
        message.message.buttonsResponseMessage?.selectedButtonId ||
        message.message.templateButtonReplyMessage?.selectedId ||
        "";

      const cleanText = text.trim();

      // =========================================================================
      // JALUR 1: HANDLER TOMBOL & PERINTAH UTAMA (Menggunakan ID '#')
      // =========================================================================

      // A. MENU UTAMA ("start", "menu", atau #MENU_UTAMA)
      if (cleanText.toLowerCase() === "start" || cleanText.toLowerCase() === "menu" || cleanText === "#MENU_UTAMA") {
        delete userSessions[jid];

        await sock.sendMessage(
          jid,
          {
            text: "🐾 *SELAMAT DATANG DI PETSHOP BOT* 🐾\n\nSilakan pilih menu layanan di bawah ini:",
            footer: "Sistem Manajemen Opname & Treatment",
            buttons: [
              { text: "🏥 OPNAME", id: "#OPNAME" },
              { text: "💊 TREATMENT", id: "#TREATMENT" },
              { text: "📲 KIRIM OWNER", id: "#KIRIM_OWNER" },
            ],
          },
          { quoted: message }
        );
      }

      // B. KLIK "🏥 OPNAME"
      else if (cleanText === "#OPNAME") {
        delete userSessions[jid];

        await sock.sendMessage(
          jid,
          {
            text: "🏥 *MENU MANAJEMEN OPNAME*\n\nSilakan pilih aksi opname pasien:",
            buttons: [
              { text: "➕ Add Opname", id: "#ADD_OPNAME" },
              { text: "✏️ Update Opname", id: "#UPDATE_OPNAME" },
              { text: "🗑️ Delete Opname", id: "#DELETE_OPNAME" },
              { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
            ],
          },
          { quoted: message }
        );
      }

      // C. KLIK "➕ Add Opname" -> MEMULAI FORM REGISTRASI
      else if (cleanText === "#ADD_OPNAME") {
        // Set state user ke Step 1
        userSessions[jid] = {
          step: "WAITING_NAMA_OWNER",
          data: {}
        };

        await sock.sendMessage(
          jid,
          {
            text: "📝 *REGISTRASI PASIEN OPNAME (Step 1/3)*\n\nSilakan ketik dan kirim *Nama Owner*:",
          },
          { quoted: message }
        );
      }

      // =========================================================================
      // JALUR 2: HANDLER FORM STEP-BY-STEP (Menangkap Ketikan Teks User)
      // =========================================================================
      else if (userSessions[jid]) {
        const session = userSessions[jid];

        // STEP 1: Terima Nama Owner -> Minta Nama Kucing
        if (session.step === "WAITING_NAMA_OWNER") {
          session.data.namaOwner = cleanText;
          session.step = "WAITING_NAMA_KUCING"; // Lanjut ke step berikutnya

          await sock.sendMessage(
            jid,
            {
              text: `✅ Nama Owner: *${cleanText}*\n\n📝 *REGISTRASI PASIEN (Step 2/3)*\nSilakan ketik dan kirim *Nama Kucing*:`,
            },
            { quoted: message }
          );
        }

        // STEP 2: Terima Nama Kucing -> Minta No HP/WA Owner
        else if (session.step === "WAITING_NAMA_KUCING") {
          session.data.namaKucing = cleanText;
          session.step = "WAITING_NO_HP"; // Lanjut ke step berikutnya

          await sock.sendMessage(
            jid,
            {
              text: `✅ Nama Kucing: *${cleanText}*\n\n📝 *REGISTRASI PASIEN (Step 3/3)*\nSilakan ketik *Nomor HP / WA Owner*:`,
            },
            { quoted: message }
          );
        }

        // STEP 3: Terima No HP -> Auto Generate Tanggal & ID -> Simpan Data
        else if (session.step === "WAITING_NO_HP") {
          session.data.noHp = cleanText;
          
          // Generate Otomatis Tanggal & ID Pasien
          const now = new Date();
          session.data.tanggalWaktu = now.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
          session.data.idPasien = `OPN-${Math.floor(1000 + Math.random() * 9000)}`;

          // Simpan ke database / array
          pasienOpnameDB.push({ ...session.data, status: "Active" });

          // Kirim Konfirmasi Sukses
          await sock.sendMessage(
            jid,
            {
              text: `🎉 *DATA PASIEN BERHASIL DISIMPAN!*\n\n` +
                    `🆔 *ID Pasien:* ${session.data.idPasien}\n` +
                    `👤 *Nama Owner:* ${session.data.namaOwner}\n` +
                    `🐾 *Nama Kucing:* ${session.data.namaKucing}\n` +
                    `📞 *No. Telepon:* ${session.data.noHp}\n` +
                    `📅 *Tgl & Waktu:* ${session.data.tanggalWaktu}\n\n` +
                    `*Total Pasien Opname Aktif:* ${pasienOpnameDB.length} pasien`,
              buttons: [
                { text: "➕ Add Pasien Lagi", id: "#ADD_OPNAME" },
                { text: "💊 Ke Menu Treatment", id: "#TREATMENT" },
                { text: "🏠 Menu Utama", id: "#MENU_UTAMA" },
              ],
            },
            { quoted: message }
          );

          // Reset/Hapus session karena registrasi sudah selesai
          delete userSessions[jid];
        }
      }
    }
  });
}

startBot();