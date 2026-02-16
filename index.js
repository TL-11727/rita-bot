const http = require('http');

http.createServer((req, res) => {
    res.write('Rita is running!');
    res.end();
}).listen(process.env.PORT || 3000);

console.log("🌍 Render Portu Aktif Edildi.");
require('dotenv').config();
const { Telegraf } = require('telegraf');
const Groq = require("groq-sdk");
const axios = require('axios');
const FormData = require('form-data');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const hafiza = {};

console.log("🚀 Rita: Sistem Başlatıldı. Yazılı Mod Aktif!");

// 1. SESİ YAZIYA ÇEVİRME (GROQ)
async function sesiYaziyaDok(fileUrl) {
    try {
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const form = new FormData();
        form.append('file', Buffer.from(response.data), { filename: 'voice.ogg', contentType: 'audio/ogg' });
        form.append('model', 'whisper-large-v3');

        const transcription = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
            headers: { ...form.getHeaders(), 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` }
        });
        return transcription.data.text;
    } catch (error) {
        console.error("❌ Groq Ses Hatası:", error.message);
        throw error;
    }
}

// 2. ANA YANIT FONKSİYONU (GÜNCELLENDİ: Sesli Yanıt Eklendi)
async function ritaYanitla(ctx, userId, mesaj) {
    if (!hafiza[userId]) {
        hafiza[userId] = [{ 
            role: "system", 
            content: "Sen Rita, elit bir Dil Koçusun. Kullanıcıya ismiyle (Rita/Ai) hitap et ve her mesajda bir challenge ver." 
        }];
    }
    hafiza[userId].push({ role: "user", content: mesaj });

    try {
        const completion = await groq.chat.completions.create({
            messages: hafiza[userId],
            model: "llama-3.3-70b-versatile",
        });

        const cevap = completion.choices[0].message.content;
        hafiza[userId].push({ role: "assistant", content: cevap });

        // A. Önce yazılı mesajı gönder
        await ctx.reply(cevap);

        // B. Şimdi cevabı sese dönüştür ve gönder (Ücretsiz gTTS)
        const gTTS = require('gtts');
        const fs = require('fs');
        const path = require('path');
        const sesDosyasiPath = path.join(__dirname, `rita_ses_${userId}.mp3`);
        
        const gtts = new gTTS(cevap, 'en'); // Dil: İngilizce
        
        gtts.save(sesDosyasiPath, async function (err) {
            if (err) {
                console.error("❌ Ses oluşturma hatası:", err);
            } else {
                await ctx.replyWithVoice({ source: sesDosyasiPath });
                // Gönderdikten sonra geçici dosyayı temizle
                if (fs.existsSync(sesDosyasiPath)) fs.unlinkSync(sesDosyasiPath);
                console.log("✅ Sesli mesaj gönderildi!");
            }
        });

        console.log("✅ İşlem tamamlandı!");

    } catch (error) {
        console.error("❌ Yanıt Hatası:", error.message);
    }
}

// 3. TELEGRAM DİNLEYİCİLERİ
bot.on('voice', async (ctx) => {
    try {
        await ctx.reply("Seni dinliyorum... 🎧");
        const fileId = ctx.message.voice.file_id;
        const link = await ctx.telegram.getFileLink(fileId);
        const metin = await sesiYaziyaDok(link.href);
        console.log(`🎤 Duyduğum: ${metin}`);
        await ritaYanitla(ctx, ctx.from.id, metin);
    } catch (e) {
        ctx.reply("Sesini işleyemedim, lütfen tekrar dener misin?");
    }
});

bot.on('text', (ctx) => ritaYanitla(ctx, ctx.from.id, ctx.message.text));

bot.launch();
