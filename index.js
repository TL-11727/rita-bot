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
    res.writeHead(200); // Sadece 200 OK kodu gönder
    res.end();         // Hiçbir metin gönderme (Çıkış 0 bayt olsun)
}).listen(process.env.PORT || 3000);

console.log("🌍 Render Portu ve Supabase Bağlantısı Aktif.");
const systemPrompt = `
Sen 7'nci Franco'nun özel İngilizce Dil Koçusun. 
Görevin: 7'nci Franco'nun Speaking (Konuşma) ve Vocabulary (Kelime) becerilerini geliştirmek.

STRATEJİN:
1. HITAP: Her zaman ona "7'nci Franco" diye hitap et.
2. SPEAKING: 7'nci Franco her mesaj attığında mutlaka ona ucu açık bir soru sorarak konuşmaya zorla. Kısa cevap verirse (Yes/No gibi), "Why?" veya "Can you explain more?" diyerek onu teşvik et.
3. VOCABULARY: Her konuşmada seviyesine uygun (A2-B1) 3 yeni kelimeyi cümle içinde kullan ve 7'nci Franco'dan bu kelimeleri kendi cümlelerinde kullanmasını iste.
4. FEEDBACK: Gramer hatalarını nazikçe düzelt. Cümlenin doğru halini mutlaka "Correct version:" başlığıyla belirt.
5. LANGUAGE: Sadece İngilizce konuş. Çok kritik bir durum olmadıkça Türkçe kullanma.
6. SES: Her zaman sesli mesaj (voice note) ile cevap ver.
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
            
        let history = (kayit && kayit.messages) ? kayit.messages : [];

        history.push({ role: "user", content: mesaj });
        
        // Groq'tan yanıt al (Hata Toleranslı Sistem)
    const models = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"];
    let chatCompletion;

    for (const modelId of models) {
        try {
            chatCompletion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: mesaj }
                ],
                model: modelId,
            });
            console.log(`✅ Mesaj ${modelId} ile başarıyla üretildi.`);
            break; // Başarılı olursa döngüden çık
        } catch (err) {
            console.error(`⚠️ ${modelId} hatası, yedeğe geçiliyor...`);
            if (modelId === models[models.length - 1]) throw err; // Son model de bittiyse hata ver
        }
    }
        const cevap = chatCompletion.choices[0].message.content;
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

bot.launch({
  dropPendingUpdates: true // Kuyrukta bekleyen eski mesajları ve takılı kalan bağlantıları siler
}).then(() => {
  console.log("🚀 Rita Telegram'a taptaze bir bağlantıyla bağlandı!");
});

// Render'da düzgün kapanma için
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));