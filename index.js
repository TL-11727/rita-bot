 const http = require('http');
require('dotenv').config();
const { Telegraf } = require('telegraf');
const Groq = require("groq-sdk");
const axios = require('axios');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');
const gTTS = require('gtts');
const fs = require('fs');
const path = require('path');

// 1. KURULUMLAR
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Render Port Dinleyici (Cron-job buraya tıklar)
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('Rita is running with Cloud Brain!');
    res.end();
}).listen(process.env.PORT || 3000);

console.log("🌍 Render Portu ve Supabase Bağlantısı Aktif.");

// 2. SESİ YAZIYA ÇEVİRME (GROQ)
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

// 3. ANA YANIT VE BULUT HAFIZA FONKSİYONU
async function ritaYanitla(ctx, userId, mesaj) {
    try {
        // Supabase'den hafızayı çek
        let { data: kayit } = await supabase
            .from('hafiza')
            .select('messages')
            .eq('user_id', userId.toString())
            .maybeSingle();
        
        let history = (kayit && kayit.messages) ? kayit.messages : [
            { role: "system", content: "Sen Rita, elit bir Dil Koçusun. Kullanıcının ismi M, seviyesi A2. Bir sonraki ders LocalStorage. Her mesajda bir challenge ver." }
        ];

        history.push({ role: "user", content: mesaj });

        // Groq'tan yanıt al
        const completion = await groq.chat.completions.create({
            messages: history,
            model: "llama-3.3-70b-versatile",
        });

        const cevap = completion.choices[0].message.content;
        history.push({ role: "assistant", content: cevap });

        // Hafızayı Supabase'de güncelle
        await supabase.from('hafiza').upsert({ 
            user_id: userId.toString(), 
            messages: history 
        }, { onConflict: 'user_id' });

        // A. Yazılı mesajı gönder
        await ctx.reply(cevap);

        // B. Sesli mesajı oluştur ve gönder
        const sesDosyasiPath = path.join(__dirname, `rita_ses_${userId}.mp3`);
        const gtts = new gTTS(cevap, 'en');
        
        gtts.save(sesDosyasiPath, async function (err) {
            if (!err) {
                // Ses dosyası gönderilirken bir hata oluşursa botun çökmemesi için try-catch
                try {
                    await ctx.replyWithVoice({ source: sesDosyasiPath });
                    if (fs.existsSync(sesDosyasiPath)) fs.unlinkSync(sesDosyasiPath);
                } catch (vError) {
                    console.error("Ses gönderme hatası:", vError.message);
                }
            }
        });

    } catch (error) {
        console.error("❌ Rita Yanıt Hatası:", error.message);
        ctx.reply("I'm having a little trouble thinking right now. Can you try again?");
    }
}

// 4. TELEGRAM DİNLEYİCİLERİ
bot.on('voice', async (ctx) => {
    try {
        await ctx.reply("I'm listening to you... 🎧");
        const fileId = ctx.message.voice.file_id;
        const link = await ctx.telegram.getFileLink(fileId);
        const metin = await sesiYaziyaDok(link.href);
        console.log(`🎤 Duyulan: ${metin}`);
        await ritaYanitla(ctx, ctx.from.id, metin);
    } catch (e) {
        console.error("Ses işleme hatası:", e.message);
        ctx.reply("I couldn't process your voice. Could you try speaking again?");
    }
});

bot.on('text', (ctx) => ritaYanitla(ctx, ctx.from.id, ctx.message.text));

// 5. GÜVENLİ BAŞLATMA VE HATA YAKALAMA
bot.catch((err, ctx) => {
    console.error(`Ouch! Rita encountered an error for ${ctx.updateType}`, err);
});

bot.launch().then(() => {
    console.log("🚀 Rita: Telegram Botu Başarıyla Başlatıldı!");
}).catch((err) => {
    console.error("❌ Bot başlatılamadı:", err.message);
});

// Render'da düzgün kapanma için
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));