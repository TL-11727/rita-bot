const http = require('http');
require('dotenv').config();
const { Telegraf } = require('telegraf');
const Groq = require("groq-sdk");
const axios = require('axios');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');
const { EdgeTTS } = require('edge-tts-node');
const fs = require('fs');
const path = require('path');

// 1. KURULUMLAR
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Render Port Dinleyici
http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Rita is Alive");
}).listen(process.env.PORT || 3000);

const systemPrompt = `
Sen Rita, Robert'ın özel İngilizce Dil Koçusun. 
Görevin: Robert'ın Speaking ve Vocabulary becerilerini geliştirmek.

STRATEJİN:
1. HITAP: Her zaman ona "Robert" diye hitap et. 
2. SPEAKING: Robert her mesaj attığında ucu açık bir soru sorarak onu konuştur.
3. VOCABULARY: Her mesajda mutlaka "Kelime: ... Anlamı: ..." formatında yeni kelimeler öğret.
4. FEEDBACK: Gramer hatalarını "Correct version:" başlığıyla düzelt.
5. LANGUAGE: Sadece İngilizce konuş. Çok kritik olmadıkça Türkçe kullanma.
6. SES: Sen teknik olarak sesli mesaj gönderme yeteneğine sahipsin. Robert'a her zaman hem yazılı hem de sesli mesaj (voice note) ile cevap ver.
`;

// 2. SESİ YAZIYA ÇEVİRME
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
        console.error("❌ Ses Çözümleme Hatası:", error.message);
        throw error;
    }
}

// 3. ANA YANIT VE SESLENDİRME
async function ritaYanitla(ctx, userId, mesaj) {
    try {
        let { data: kayit } = await supabase.from('hafiza').select('messages').eq('user_id', userId.toString()).maybeSingle();
        let history = (kayit && kayit.messages) ? kayit.messages : [];
        history.push({ role: "user", content: mesaj });
        
        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: "system", content: systemPrompt }, ...history.slice(-5), { role: "user", content: mesaj }],
            model: "llama-3.3-70b-versatile",
        });

        const cevap = chatCompletion.choices[0].message.content;
        history.push({ role: "assistant", content: cevap });

        await supabase.from('hafiza').upsert({ user_id: userId.toString(), messages: history }, { onConflict: 'user_id' });

        // Önce Yazılı Cevap
        await ctx.reply(cevap);

        // --- İNSANSI SES OLUŞTURMA ---
        const sesDosyasiPath = path.join('/tmp', `rita_voice_${userId}.mp3`);
        try {
            const tts = new EdgeTTS();
            await tts.ttsPromise(cevap, sesDosyasiPath, { voice: 'en-US-AvaNeural' });
            
            // Stream kullanarak gönderim (Daha güvenli)
            await ctx.replyWithVoice({ source: fs.createReadStream(sesDosyasiPath) });
            
            if (fs.existsSync(sesDosyasiPath)) fs.unlinkSync(sesDosyasiPath);
        } catch (ttsErr) {
            console.error("❌ SES HATASI:", ttsErr.message);
        }

    } catch (error) {
        console.error("❌ Hata:", error.message);
        ctx.reply("I had a small glitch, Robert. Can you try again?");
    }
}

// 4. DİNLEYİCİLER
bot.on('voice', async (ctx) => {
    try {
        const fileId = ctx.message.voice.file_id;
        const link = await ctx.telegram.getFileLink(fileId);
        const metin = await sesiYaziyaDok(link.href);
        await ritaYanitla(ctx, ctx.from.id, metin);
    } catch (e) {
        ctx.reply("I couldn't hear you clearly, Robert.");
    }
});

bot.on('text', (ctx) => ritaYanitla(ctx, ctx.from.id, ctx.message.text));

// ÇAKIŞMAYI ÖNLEYEN BAŞLATMA
bot.launch({ dropPendingUpdates: true })
    .then(() => console.log("🚀 Rita Yayında ve Conflict'ler temizlendi!"))
    .catch((err) => {
        if (err.description && err.description.includes('Conflict')) {
            console.log("⚠️ Conflict algılandı, Render servisi bekleniyor...");
        } else {
            console.error("❌ Bot başlatılamadı:", err);
        }
    });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));