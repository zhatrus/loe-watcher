const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const FormData = require('form-data'); // Потрібно для відправки фото

// --- НАЛАШТУВАННЯ ---
const STATE_FILE = 'state.json';
// Надійна адреса API, що повертає посилання на актуальний графік
const API_URL = 'https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic'; 
const BASE_URL = 'https://poweron.loe.lviv.ua/'; 
const API_BASE_DOMAIN = 'https://api.loe.lviv.ua';

// Токени з середовища GitHub Actions
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- ДОПОМІЖНІ ФУНКЦІЇ ---

// Завантаження/Збереження стану
let state = {};
if (fs.existsSync(STATE_FILE)) {
    try { state = JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { state = {}; }
}
function saveState(data) { fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2)); }

// Функція для відправки фото в Telegram
async function sendPhotoToTelegram(buffer, caption, silent = false) {
    try {
        // Axios не завжди добре працює з Buffer для multipart/form-data, тому використовуємо form-data
        const formData = new FormData();
        formData.append('photo', Buffer.from(buffer), { filename: 'schedule.jpg', contentType: 'image/jpeg' });
        formData.append('caption', caption);
        formData.append('parse_mode', 'Markdown');
        formData.append('disable_notification', silent ? 'true' : 'false');
        
        await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto?chat_id=${CHAT_ID}`,
            formData,
            { headers: formData.getHeaders() }
        );
        console.log('✅ Фото відправлено в Telegram');
    } catch (error) {
        console.error('❌ Помилка Telegram (sendPhoto):', error.response ? error.response.data : error.message);
    }
}

// Функція для відправки тексту
async function sendTextToTelegram(text, silent = false) {
    try {
        await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
            {
                chat_id: CHAT_ID,
                text: text,
                parse_mode: 'Markdown',
                disable_notification: silent,
            }
        );
        console.log('✅ Текст відправлено в Telegram');
    } catch (error) {
        console.error('❌ Помилка відправки тексту в Telegram:', error.response ? error.response.data : error.message);
    }
}

// Визначення, чи зараз "тихий" період (21:00–08:00 за київським часом)
function isQuietTime() {
    const now = new Date();
    const hourKyiv = Number(
        now.toLocaleString('en-US', {
            timeZone: 'Europe/Kyiv',
            hour: 'numeric',
            hour12: false,
        })
    );
    return hourKyiv >= 21 || hourKyiv < 8;
}

// Отримати дату за київським часом у форматі DD.MM.YYYY (із зсувом у днях)
function getKyivDateString(offsetDays = 0) {
    const now = new Date();
    const kyivNow = new Date(
        now.toLocaleString('en-US', {
            timeZone: 'Europe/Kyiv',
        })
    );
    kyivNow.setDate(kyivNow.getDate() + offsetDays);
    const dd = String(kyivNow.getDate()).padStart(2, '0');
    const mm = String(kyivNow.getMonth() + 1).padStart(2, '0');
    const yyyy = kyivNow.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
}

// --- ОСНОВНА ЛОГІКА ---

async function check() {
    try {
        console.log(`🔍 Перевірка API за адресою: ${API_URL}`);
        const quiet = isQuietTime();
        
        // 1. Отримуємо JSON з посиланням на графік
        const apiResponse = await axios.get(API_URL, {
             headers: { 
                'User-Agent': 'Mozilla/5.0 (compatible; LOEMonitorBot/1.0)',
             }
        });
        const apiData = apiResponse.data;
        
        // Хешуємо вміст API повністю, щоб відстежити будь-які зміни
        const apiContentString = JSON.stringify(apiData);

        if (apiContentString.length < 50) { 
             console.warn('⚠️ Отримано занадто коротку відповідь API. Можливо, сайт недоступний.');
             return;
        }
        
        // 2. Хешуємо вміст API
        const currentApiHash = crypto.createHash('md5').update(apiContentString).digest('hex');
        
        // 3. Порівнюємо з попереднім хешем
        if (state.apiHash !== currentApiHash) {
            console.log('🚨 Виявлено зміни у відповіді API!');
            
            // --- ПАРСИНГ JSON ---
            
            // Актуальний графік знаходиться тут: hydra:member[0].menuItems[0]
            const currentScheduleData = apiData?.['hydra:member']?.[0]?.menuItems?.[0];

            let imageUrl = null;
            let scheduleText = '';

            if (currentScheduleData) {
                // Формуємо повне посилання на картинку з ключа imageUrl
                const relativeUrl = currentScheduleData.imageUrl;
                if (relativeUrl && relativeUrl.includes('_GPV.png')) {
                    // Додаємо базовий домен
                    imageUrl = `${API_BASE_DOMAIN}${relativeUrl}`;
                }

                // Витягуємо чистий текст (з ключа rawHtml)
                const rawHtml = currentScheduleData.rawHtml || '';
                // Видаляємо теги <div>, <p>, <b> та замінюємо <br> на новий рядок
                scheduleText = rawHtml
                    .replace(/<\/?(div|p|b)>/g, '') 
                    .replace(/<br\s*\/?>/gi, '\n')
                    .trim();
            }
            
            // --- ЛОГІКА ВІДПРАВКИ ---

            if (imageUrl) {
                console.log(`🖼 Знайдено нове посилання: ${imageUrl}`);
                
                // 5. Завантажуємо та надсилаємо нову картинку
                const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
                const imageBuffer = imageResponse.data;
                
                // Формуємо підпис: заголовок залежить від дати в тексті + очищений текст
                const firstLine = (scheduleText.split('\n')[0] || '').trim();
                const dateMatch = firstLine.match(/(\d{2}\.\d{2}\.\d{4})/);
                const todayStr = getKyivDateString(0);
                const tomorrowStr = getKyivDateString(1);

                let title = '⚡️ **Новий графік відключень!**';
                if (dateMatch) {
                    const dateStr = dateMatch[1];
                    if (dateStr === todayStr) {
                        title = '⚡️ **Оновлення в графіку відключень!**';
                    } else if (dateStr === tomorrowStr) {
                        title = '⚡️ **Новий графік відключень!**';
                    }
                }

                let caption = `${title}\n\n${scheduleText}\n\n[Переглянути на сайті](${BASE_URL})`;
                await sendPhotoToTelegram(imageBuffer, caption, quiet);

            } else {
                // Якщо посилання не знайшли (наприклад, у випадку скасування відключень, коли imageUrl порожнє)
                let textCaption = `⚠️ **Оновлення (Тільки Текст)**:\n\n${scheduleText || 'Інформація про графік відсутня (можливо, ГПВ скасовано).'} \n\n[Перевірити на сайті](${BASE_URL})`;
                await sendTextToTelegram(textCaption, quiet);
                console.log('⚠️ Посилання на картинку не знайдено, надіслано текстовий вміст.');
            }
            
            // 6. Зберігаємо новий хеш API
            state.apiHash = currentApiHash;
            saveState(state);
        } else {
            console.log('😴 Змін у графіку немає.');
        }

    } catch (e) {
        console.error(`❌ Критична помилка під час перевірки API ${API_URL}:`, e.message);
        // При помилці більше не надсилаємо сповіщення в Telegram, лише логуємо.
    }
}

// Викликаємо основну функцію
check();
