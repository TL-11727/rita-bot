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
    res.end();
}).listen(process.env.PORT || 3000);

console.log("🌍 Rita Bulut Sunucusu ve Veri Tabanı Aktif.");

// ROBERT İÇİN ÖZEL SİSTEM MESAJI
const systemPrompt = `
Sen Rita, Robert'ın özel İngilizce Dil Koçusun. 
Görevin: Robert'ın Speaking ve Vocabulary becerilerini geliştirmek.

STRATEJİN:
1. HITAP: Her zaman ona "Robert" diye hitap et. 
2. SPEAKING: Robert her mesaj attığında ucu açık bir soru sorarak onu konuştur.
3. VOCABULARY: Her mesajda mutlaka "Kelime: ... Anlamı: ..." formatında yeni kelimeler öğret.
4. FEEDBACK: Gramer hatalarını "Correct version:" başlığıyla düzelt.
5. LANGUAGE: Sadece İngilizce konuş. Çok kritik olmadıkça Türkçe kullanma.
6. SES: Sen teknik olarak sesli mesaj gönderme yeteneğine sahipsin. Robert'a her zaman hem yazılı hem de sesli mesaj (voice note) ile cevap ver. Asla "ses atamam" deme.
`;

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
        console.error("❌ Ses Çözümleme Hatası:", error.message);
        throw error;
    }
}

// 3. ANA YANIT VE SESLENDİRME FONKSİYONU
async function ritaYanitla(ctx, userId, mesaj) {
    try {
        let { data: kayit } = await supabase.from('hafiza').select('messages').eq('user_id', userId.toString()).maybeSingle();
        let history = (kayit && kayit.messages) ? kayit.messages : [];
        history.push({ role: "user", content: mesaj });
        
        const models = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
        let chatCompletion;

        for (const modelId of models) {
            try {
                chatCompletion = await groq.chat.completions.create({
                    messages: [{ role: "system", content: systemPrompt }, ...history.slice(-5), { role: "user", content: mesaj }],
                    model: modelId,
                });
                break;
            } catch (err) {
                if (modelId === models[models.length - 1]) throw err;
            }
        }

        const cevap = chatCompletion.choices[0].message.content;
        history.push({ role: "assistant", content: cevap });

        // KELİME AYIKLAMA VE HAFIZA (SUPABASE)
        const kelimeMatch = cevap.match(/Kelime:\s*([a-zA-ZçÇğĞıİöÖşŞüÜ\s]+)/i);
        const anlamMatch = cevap.match(/Anlamı:\s*([^.\n]+)/i);

        if (kelimeMatch && anlamMatch) {
            await supabase.from('rita_sozluk').insert({
                user_id: userId.toString(),
                word: kelimeMatch[1].trim(),
                mean: anlamMatch[1].trim()
            });
        }

        await supabase.from('hafiza').upsert({ user_id: userId.toString(), messages: history }, { onConflict: 'user_id' });

        // Önce Yazılı Cevap
        await ctx.reply(cevap);

         
        // --- İNSANSI SES OLUŞTURMA ---
        const sesDosyasiPath = path.join('/tmp', `rita_voice_${userId}.mp3`);
        try {
            const tts = new EdgeTTS(); // Constructor hatasını yukarıdaki import düzeltecek
            
            // Metinden sesi oluştur
            await tts.ttsPromise(cevap, sesDosyasiPath, { voice: 'en-US-AvaNeural' });
            
            // Telegram'a gönder
            await ctx.replyWithVoice({ source: sesDosyasiPath });
            
            // Dosyayı sil
            if (fs.existsSync(sesDosyasiPath)) fs.unlinkSync(sesDosyasiPath);
        } catch (ttsErr) {
            console.error("❌ SES HATASI:", ttsErr.message);
            // Eğer buraya düşerse terminalde hatayı net görürüz
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

bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log("🚀 Rita (Robert'ın Koçu) Sesli ve Canlı!");
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));