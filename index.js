const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');

// --- НАЛАШТУВАННЯ ---
const STATE_FILE = 'state.json';
// ВИКОРИСТОВУЄМО АДРЕСУ, ЯКА ПОВЕРТАЄ ПОСИЛАННЯ НА КАРТИНКУ
const API_URL = 'https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic'; 
const BASE_URL = 'https://poweron.loe.lviv.ua/'; 
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- ДОПОМІЖНІ ФУНКЦІЇ ---

// Завантаження/Збереження стану
let state = {};
if (fs.existsSync(STATE_FILE)) {
    try { state = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { state = {}; }
}
function saveState(data) { fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Функція для відправки фото в Telegram
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

// Функція для відправки тексту (як запасний варіант)
async function sendTextToTelegram(text) {
    try {
        await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
            {
                chat_id: CHAT_ID,
                text: text,
                parse_mode: 'Markdown'
            }
        );
        console.log('✅ Текст відправлено в Telegram');
    } catch (error) {
        console.error('❌ Помилка відправки тексту в Telegram:', error.response ? error.response.data : error.message);
    }
}

// --- ОСНОВНА ЛОГІКА ---

async function check() {
    try {
        console.log(`🔍 Перевірка API за адресою: ${API_URL}`);
        
        // 1. Отримуємо JSON з посиланням на графік
        const apiResponse = await axios.get(API_URL, {
             headers: { 
                'User-Agent': 'Mozilla/5.0 (compatible; LOEMonitorBot/1.0)',
             }
        });
        const apiData = apiResponse.data;
        
        const apiContentString = typeof apiData === 'object' ? JSON.stringify(apiData) : apiData;

        // ТИМЧАСОВЕ ВИВЕДЕННЯ ВМІСТУ ДЛЯ НАЛАГОДЖЕННЯ:
        console.log('--- Отримано JSON ---');
        console.log(apiContentString);
        console.log('--------------------');

        if (apiContentString.length < 50) { 
             await sendTextToTelegram('⚠️ Отримано занадто коротку відповідь API. Можливо, сайт недоступний.');
             return;
        }
        
        // 2. Хешуємо вміст API (коли JSON зміниться, хеш зміниться)
        const currentApiHash = crypto.createHash('md5').update(apiContentString).digest('hex');
        
        // 3. Порівнюємо з попереднім хешем
        if (state.apiHash !== currentApiHash) {
            console.log('🚨 Виявлено зміни у відповіді API!');
            
            // 4. Шукаємо URL картинки (як правило, це буде посилання на .png)
            // Ми використаємо регулярний вираз для пошуку будь-якого https-посилання, що містить GPV
            const imageMatch = apiContentString.match(/(https?:\/\/[^\s"]*?GPV\.png)/);
            const imageUrl = imageMatch ? imageMatch[1] : null;

            if (imageUrl) {
                console.log(`🖼 Знайдено нове посилання: ${imageUrl}`);
                
                // 5. Завантажуємо та надсилаємо нову картинку
                const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
                const imageBuffer = imageResponse.data;

                let caption = `⚡️ **Новий графік відключень!**\n\n[Переглянути на сайті](${BASE_URL})`;
                await sendPhotoToTelegram(imageBuffer, caption);

            } else {
                // Якщо посилання не знайшли, відправляємо хоча б текст API (як запасний варіант)
                let textCaption = `⚡️ **Оновлення у графіку (текстове)**:\n\nОтримано нові дані API, але посилання на картинку не знайдено. Перевірте сайт:\n${BASE_URL}`;
                await sendTextToTelegram(textCaption);
                console.log('⚠️ Не вдалося витягти URL картинки, надіслано вміст API.');
            }
            
            // 6. Зберігаємо новий хеш API
            state.apiHash = currentApiHash;
            saveState(state);
        } else {
            console.log('😴 Змін у графіку немає.');
        }

    } catch (e) {
        console.error(`❌ Критична помилка під час перевірки API ${API_URL}:`, e.message);
        // Надсилаємо сповіщення про помилку, щоб знати, що монітор не працює
        await sendTextToTelegram(`🔴 **Помилка моніторингу LOE:** Скрипт не зміг перевірити графік. Деталі: ${e.message.substring(0, 150)}`);
        process.exit(1);
    }
}

check();