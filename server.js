const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DB_FILE = process.env.VERCEL 
    ? path.join('/tmp', 'database.json') 
    : path.join(__dirname, 'database.json');

let memoryDB = { keys: {} };

const SITE_CONFIG = {
    siteName: 'apikeyzenuth',
    aiName: 'apikeyzenuth AI',
    themeName: 'Liquid Glass Platform',
    defaultLimit: 100,
    resetWindowMs: 24 * 60 * 60 * 1000,
    maxLogsToKeep: 50
};

const GROQ_API_KEY = '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';
const ZENNQ_API_KEY = 'zq_eu1maz2hkr3uv319ffp2jl0shohwj2lt';

const errorLogs = [];

function recordErrorLog(endpoint, message, statusCode = 400) {
    const newLog = {
        id: 'LOG-' + Date.now().toString(36).toUpperCase(),
        timestamp: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
        endpoint,
        message,
        statusCode
    };
    
    errorLogs.unshift(newLog);
    if (errorLogs.length > SITE_CONFIG.maxLogsToKeep) {
        errorLogs.pop();
    }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

function loadDB() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            fs.writeFileSync(DB_FILE, JSON.stringify(memoryDB, null, 2));
        }
        const data = fs.readFileSync(DB_FILE, 'utf-8');
        memoryDB = JSON.parse(data);
        return memoryDB;
    } catch (err) {
        return memoryDB;
    }
}

function saveDB(data) {
    memoryDB = data;
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (err) {}
}

function checkRateLimit(req, res, next) {
    const apiKey = req.query.apikey || req.body.apikey;

    if (!apiKey) {
        recordErrorLog(req.originalUrl, 'Akses ditolak: API Key tidak disertakan', 401);
        return res.status(401).json({ success: false, message: 'API Key dibutuhkan! Dapatkan key di menu Pengaturan.' });
    }

    const db = loadDB();
    let keyData = db.keys[apiKey];

    if (!keyData && apiKey.startsWith('SAW-')) {
        keyData = {
            key: apiKey,
            count: 0,
            limit: SITE_CONFIG.defaultLimit,
            createdAt: Date.now(),
            lastReset: Date.now()
        };
        db.keys[apiKey] = keyData;
        saveDB(db);
    }

    if (!keyData) {
        recordErrorLog(req.originalUrl, `API Key tidak terdaftar: ${apiKey}`, 403);
        return res.status(403).json({ success: false, message: 'API Key tidak valid!' });
    }

    const now = Date.now();

    if (now - keyData.lastReset >= SITE_CONFIG.resetWindowMs) {
        keyData.count = 0;
        keyData.lastReset = now;
    }

    if (keyData.count >= keyData.limit) {
        const nextResetHours = Math.ceil((SITE_CONFIG.resetWindowMs - (now - keyData.lastReset)) / (1000 * 60 * 60));
        recordErrorLog(req.originalUrl, `Limit harian habis untuk key: ${apiKey}`, 429);
        return res.status(429).json({
            success: false,
            message: `Limit request harian (${keyData.limit}/${keyData.limit}) telah habis. Otomatis reset dalam ${nextResetHours} jam.`
        });
    }

    keyData.count += 1;
    saveDB(db);

    req.keyInfo = keyData;
    next();
}

app.get('/', (req, res) => {
    res.render('docs', { config: SITE_CONFIG });
});

app.post('/api/generate-key', (req, res) => {
    try {
        const db = loadDB();
        const newKey = 'SAW-' + crypto.randomBytes(6).toString('hex').toUpperCase();

        db.keys[newKey] = {
            key: newKey,
            count: 0,
            limit: SITE_CONFIG.defaultLimit,
            createdAt: Date.now(),
            lastReset: Date.now()
        };

        saveDB(db);
        return res.json({ success: true, key: newKey, limit: SITE_CONFIG.defaultLimit });
    } catch (err) {
        recordErrorLog('/api/generate-key', err.message, 500);
        return res.status(500).json({ success: false, message: 'Gagal membuat API Key.' });
    }
});

app.get('/api/check-key', (req, res) => {
    const { apikey } = req.query;
    if (!apikey) return res.json({ success: false, message: 'Parameter apikey diperlukan.' });

    const db = loadDB();
    let keyData = db.keys[apikey];

    if (!keyData && apikey.startsWith('SAW-')) {
        keyData = {
            key: apikey,
            count: 0,
            limit: SITE_CONFIG.defaultLimit,
            createdAt: Date.now(),
            lastReset: Date.now()
        };
        db.keys[apikey] = keyData;
        saveDB(db);
    }

    if (!keyData) return res.json({ success: false, message: 'Key tidak ditemukan.' });

    const now = Date.now();
    if (now - keyData.lastReset >= SITE_CONFIG.resetWindowMs) {
        keyData.count = 0;
        keyData.lastReset = now;
        saveDB(db);
    }

    return res.json({
        success: true,
        key: keyData.key,
        used: keyData.count,
        remaining: keyData.limit - keyData.count,
        limit: keyData.limit
    });
});

// Endpoint AI
app.get('/api/ai', checkRateLimit, async (req, res) => {
    const prompt = req.query.prompt;
    if (!prompt || prompt.trim() === '') {
        recordErrorLog(req.originalUrl, 'Parameter prompt kosong', 400);
        return res.status(400).json({ success: false, message: 'Parameter prompt tidak boleh kosong!' });
    }

    try {
        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
            body: JSON.stringify({
                messages: [{ role: 'user', content: prompt }],
                model: 'openai/gpt-oss-120b',
                temperature: 1,
                max_completion_tokens: 2048,
                top_p: 1,
                stream: false,
                reasoning_effort: 'medium'
            })
        });
        const data = await groqResponse.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            return res.json({
                success: true,
                author: SITE_CONFIG.siteName,
                result: data.choices[0].message.content.trim(),
                usage: { usedToday: req.keyInfo.count, remaining: req.keyInfo.limit - req.keyInfo.count, limit: req.keyInfo.limit }
            });
        } else {
            return res.status(500).json({ success: false, message: 'Gagal memproses AI.' });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Endpoint Translate
app.get('/api/translate', checkRateLimit, async (req, res) => {
    const { text, to } = req.query;
    if (!text) return res.status(400).json({ success: false, message: 'Parameter text wajib diisi.' });
    try {
        const response = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(to || 'en')}&dt=t&q=${encodeURIComponent(text)}`);
        const data = await response.json();
        const translatedText = data[0].map(item => item[0]).filter(Boolean).join('');
        return res.json({ success: true, result: translatedText });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Endpoint Bypass
app.get('/api/bypass', checkRateLimit, async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ success: false, message: 'Parameter url wajib diisi.' });
    try {
        const response = await fetch('https://zennq.my.id/api/bypass', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': ZENNQ_API_KEY },
            body: JSON.stringify({ url })
        });
        const data = await response.json();
        return res.json({ success: true, result: data.data?.bypassedUrl || 'Gagal bypass' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Endpoint Calc
app.get('/api/calc', checkRateLimit, (req, res) => {
    let { angka1, op, angka2 } = req.query;
    const n1 = parseFloat(angka1), n2 = parseFloat(angka2);
    if (isNaN(n1) || isNaN(n2)) return res.status(400).json({ success: false, message: 'Angka tidak valid' });
    let hasil = 0;
    if (op === '+') hasil = n1 + n2;
    else if (op === '-') hasil = n1 - n2;
    else if (op === 'x' || op === '*') hasil = n1 * n2;
    else if (op === ':' || op === '/') hasil = n1 / n2;
    return res.json({ success: true, result: hasil });
});

// Endpoint Paraphrase
app.get('/api/paraphrase', checkRateLimit, async (req, res) => {
    const text = req.query.text;
    if (!text) return res.status(400).json({ success: false, message: 'Parameter text wajib diisi.' });
    try {
        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
            body: JSON.stringify({
                messages: [{ role: 'user', content: `Parafrase kalimat berikut:\n\n"${text}"` }],
                model: 'openai/gpt-oss-120b',
                temperature: 1,
                max_completion_tokens: 2048,
                stream: false
            })
        });
        const data = await groqResponse.json();
        return res.json({ success: true, result: data.choices[0].message.content.trim() });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Endpoint Story
app.get('/api/story', checkRateLimit, async (req, res) => {
    const topic = req.query.topic;
    if (!topic) return res.status(400).json({ success: false, message: 'Parameter topic wajib diisi.' });
    try {
        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
            body: JSON.stringify({
                messages: [{ role: 'user', content: `Buatkan cerpen bertema: "${topic}"` }],
                model: 'openai/gpt-oss-120b',
                temperature: 1,
                max_completion_tokens: 2048,
                stream: false
            })
        });
        const data = await groqResponse.json();
        return res.json({ success: true, result: data.choices[0].message.content.trim() });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Endpoint Character Story (CS SA-MP) Sesuai Gambar Referensi
app.get('/api/character-story', checkRateLimit, async (req, res) => {
    const { nama, tanggalLahir, asal, catatan, latarBelakang, vibe, bahasa, paragraf } = req.query;

    if (!nama || !tanggalLahir || !asal) {
        recordErrorLog(req.originalUrl, 'Parameter karakter tidak lengkap', 400);
        return res.status(400).json({ 
            success: false, 
            message: 'Parameter nama, tanggalLahir, dan asal wajib diisi sesuai form!' 
        });
    }

    const prompt = `Buatkan sebuah Character Story (CS) Roleplay SA-MP yang sangat imersif, mendalam, dan sesuai standar server roleplay berkualitas tinggi berdasarkan detail berikut:
- Nama Karakter (IC): ${nama}
- Tahun / Tanggal Lahir: ${tanggalLahir}
- Asal / Kewarganegaraan: ${asal}
- Latar Belakang Kehidupan: ${latarBelakang || 'Umum'}
- Vibe Kepribadian: ${vibe || 'Netral'}
- Bahasa Cerita: ${bahasa || 'Indonesia'}
- Jumlah Paragraf: ${paragraf || '4 Paragraf'}
- Catatan Tambahan / Alur Khusus: ${catatan || 'Tidak ada catatan khusus, kembangkan secara kreatif.'}

Pastikan struktur cerita rapi sesuai jumlah paragraf yang diminta.`;

    try {
        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
            body: JSON.stringify({
                messages: [{ role: 'user', content: prompt }],
                model: 'openai/gpt-oss-120b',
                temperature: 1,
                max_completion_tokens: 3000,
                top_p: 1,
                stream: false,
                reasoning_effort: 'medium'
            })
        });

        const data = await groqResponse.json();

        if (data.choices && data.choices[0] && data.choices[0].message) {
            return res.json({
                success: true,
                author: SITE_CONFIG.siteName,
                characterDetails: { nama, tanggalLahir, asal, latarBelakang, vibe, bahasa, paragraf, catatan },
                result: data.choices[0].message.content.trim(),
                usage: { usedToday: req.keyInfo.count, remaining: req.keyInfo.limit - req.keyInfo.count, limit: req.keyInfo.limit }
            });
        } else {
            const errMsg = data.error ? data.error.message : 'Gagal menghasilkan Character Story.';
            recordErrorLog(req.originalUrl, errMsg, 500);
            return res.status(500).json({ success: false, message: errMsg });
        }
    } catch (err) {
        recordErrorLog(req.originalUrl, err.message, 500);
        return res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/logs', (req, res) => {
    return res.json({ success: true, totalLogs: errorLogs.length, logs: errorLogs });
});

app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`${SITE_CONFIG.siteName} Aktif di: http://localhost:${PORT}`);
    console.log(`=================================================`);
});

module.exports = app;
