const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const crypto = require('crypto');

// Налаштування
const STATE_FILE = 'state.json';
const URL = 'https://poweron.loe.lviv.ua/';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Завантаження стану
let state = {};
if (fs.existsSync(STATE_FILE)) {
    try { state = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) {}
}

// Допоміжна функція: пауза (щоб не спамити запитами)
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
        console.error('❌ Помилка Telegram:', error.message);
    }
}

async function check() {
    try {
        console.log('🔍 Завантаження сторінки...');
        const { data: html } = await axios.get(URL, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LOEMonitorBot/1.0)' }
        });

        const $ = cheerio.load(html);
        const container = $('.power-off__current');

        // Знаходимо пари: картинка + підпис (дата)
        // В твоєму HTML йде <img> потім <div text> з датою.
        // Ми просто зберемо всі картинки в блоці
        const images = container.find('img').toArray();

        if (images.length === 0) {
            console.log('⚠️ Картинки не знайдено, можливо змінилась верстка.');
            return;
        }

        let hasChanges = false;

        for (const img of images) {
            let src = $(img).attr('src');
            let alt = $(img).attr('alt') || 'Графік';

            // Отримати дату з найближчого заголовка (спроба знайти контекст)
            // Шукаємо найближчий наступний div з текстом або попередній p
            let dateText = "Оновлення графіку ⚡️";

            // Логіка для твого HTML: після картинки йде div з класом power-off__text
            const nextDiv = $(img).parent().next('.power-off__text');
            if (nextDiv.length) {
                const dateB = nextDiv.find('b').first().text(); // "Графік ... на 25.11.2025"
                if (dateB) dateText = `📅 ${dateB}`;
            }

            if (!src) continue;
            if (!src.startsWith('http')) src = new URL(src, URL).href;

            // Качаємо картинку для хешування
            const imgResp = await axios.get(src, { responseType: 'arraybuffer' });
            const imgBuffer = imgResp.data;
            const hash = crypto.createHash('md5').update(imgBuffer).digest('hex');

            // Ключ для збереження (використовуємо alt або src як ідентифікатор)
            const key = alt; 

            if (state[key] !== hash) {
                console.log(`🚨 Зміна в ${key}! Відправляємо...`);
                await sendPhotoToTelegram(imgBuffer, `${dateText}\n\n🔗 ${URL}`);
                state[key] = hash;
                hasChanges = true;
                await sleep(2000); // Пауза між повідомленнями
            }
        }

        if (hasChanges) {
            fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
            console.log('💾 Стан оновлено.');
        } else {
            console.log('😴 Змін немає.');
        }

    } catch (e) {
        console.error('❌ Глобальна помилка:', e.message);
        process.exit(1);
    }
}

check();