const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// Налаштування
const STATE_FILE = 'state.json';
const URL_PAGE = 'https://poweron.loe.lviv.ua/';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Завантаження стану
let state = {};
if (fs.existsSync(STATE_FILE)) {
    try { state = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { state = {}; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendPhotoToTelegram(buffer, caption) {
    try {
        const formData = new FormData();
        const blob = new Blob([buffer]);
        formData.append('photo', blob, 'schedule.jpg');
        formData.append('caption', caption);

        await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto?chat_id=${CHAT_ID}`,
            formData,
            { headers: { 'Content-Type': 'multipart/form-data' } }
        );
        console.log('✅ Фото відправлено');
    } catch (error) {
        console.error('❌ Помилка Telegram:', error.response ? error.response.data : error.message);
    }
}

async function check() {
    try {
        console.log('🔍 Завантаження сторінки...');
        // Використовуємо звичайний User-Agent, як у браузера Chrome
        const { data: html } = await axios.get(URL_PAGE, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
            }
        });
        
        console.log(`📄 Отримано HTML довжиною: ${html.length} символів`);

        const $ = cheerio.load(html);
        
        // СТРАТЕГІЯ 2: Шукаємо ВСІ картинки, а потім фільтруємо
        // У твоєму прикладі картинки мають "GPV" в посиланні або "grafic" в alt
        let images = $('img').toArray();
        
        console.log(`🖼 Знайдено всього картинок на сторінці: ${images.length}`);

        // Фільтруємо ті, що схожі на графік
        const scheduleImages = images.filter(img => {
            const src = $(img).attr('src') || '';
            const alt = ($(img).attr('alt') || '').toLowerCase();
            
            // Умови пошуку:
            // 1. src містить "GPV" (видно з твого прикладу)
            // 2. alt містить "grafic"
            // 3. або просто це велика картинка png/jpg всередині посилання
            return src.includes('GPV') || alt.includes('grafic') || (src.includes('media') && src.endsWith('.png'));
        });

        if (scheduleImages.length === 0) {
            console.log('⚠️ Картинки графіку не відфільтровано. Виводжу перші 3 знайдені src для налагодження:');
            images.slice(0, 3).forEach(img => console.log('   ->', $(img).attr('src')));
            
            // Спробуємо "План Б": якщо верстка змінилась кардинально, шукаємо просто першу велику картинку в контенті
            // (можна розкоментувати, якщо попереднє не спрацює)
            return; 
        }

        console.log(`🎯 Відібрано цільових картинок: ${scheduleImages.length}`);

        let hasChanges = false;

        for (const img of scheduleImages) {
            let src = $(img).attr('src');
            // Очистка src (іноді бувають пробіли)
            src = src.trim();
            
            // Якщо посилання відносне (/media/...), робимо абсолютним
            if (!src.startsWith('http')) {
                // В твоєму прикладі src повний, але про всяк випадок:
                // Якщо src починається з /, додаємо домен api або сайту. 
                // В прикладі: https://api.loe.lviv.ua/media/...
                if (src.startsWith('/')) {
                     src = `https://poweron.loe.lviv.ua${src}`;
                }
            }

            console.log(`📥 Перевірка картинки: ${src}`);

            try {
                const imgResp = await axios.get(src, { responseType: 'arraybuffer' });
                const imgBuffer = imgResp.data;
                const hash = crypto.createHash('md5').update(imgBuffer).digest('hex');
                const key = src; // Використовуємо URL як унікальний ключ

                // Перевіряємо, чи змінився хеш
                if (state[key] !== hash) {
                    console.log(`🚨 Зміна виявлена! (Hash: ${hash})`);
                    
                    // Спробуємо знайти дату поруч з картинкою для підпису
                    // Піднімаємось до батьківського <a>, потім беремо наступний div з текстом
                    let caption = `⚡️ Оновлення графіку!\n\n🔗 ${URL_PAGE}`;
                    
                    await sendPhotoToTelegram(imgBuffer, caption);
                    
                    state[key] = hash;
                    hasChanges = true;
                    await sleep(3000); // Пауза, щоб телеграм не заблокував за спам
                } else {
                    console.log('   -> Без змін');
                }
            } catch (err) {
                console.error(`❌ Не вдалося завантажити картинку ${src}: ${err.message}`);
            }
        }

        if (hasChanges) {
            fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
            console.log('💾 Стан збережено.');
        } else {
            console.log('😴 Нових графіків немає.');
        }

    } catch (e) {
        console.error('❌ Критична помилка:', e.message);
        process.exit(1);
    }
}

check();