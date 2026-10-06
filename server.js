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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6L3iwvouEq-l5shid2D11Y6XAPKzBn_mOT7QrEubSYJog';
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

// Endpoint 1: AI Prompt
app.get('/api/ai', checkRateLimit, async (req, res) => {
    const prompt = req.query.prompt;
    if (!prompt || prompt.trim() === '') {
        recordErrorLog(req.originalUrl, 'Parameter prompt kosong', 400);
        return res.status(400).json({ success: false, message: 'Parameter prompt tidak boleh kosong!' });
    }

    try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();

        if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
            return res.json({
                success: true,
                author: SITE_CONFIG.siteName,
                prompt: prompt,
                result: data.candidates[0].content.parts[0].text,
                usage: { usedToday: req.keyInfo.count, remaining: req.keyInfo.limit - req.keyInfo.count, limit: req.keyInfo.limit }
            });
        } else {
            const errMsg = data.error ? data.error.message : 'Respons AI tidak valid.';
            recordErrorLog(req.originalUrl, errMsg, 500);
            return res.status(500).json({ success: false, message: `Gagal memproses AI: ${errMsg}` });
        }
    } catch (err) {
        recordErrorLog(req.originalUrl, err.message, 500);
        return res.status(500).json({ success: false, message: `Gagal memproses AI: ${err.message}` });
    }
});

// Endpoint 2: Fast Translate
app.get('/api/translate', checkRateLimit, async (req, res) => {
    const { text, to } = req.query;
    if (!text || text.trim() === '') {
        recordErrorLog(req.originalUrl, 'Parameter text kosong', 400);
        return res.status(400).json({ success: false, message: 'Parameter text tidak boleh kosong!' });
    }
    const targetLang = to || 'en';
    try {
        const gtxUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
        const response = await fetch(gtxUrl);
        const data = await response.json();

        if (data && data[0]) {
            const translatedText = data[0].map(item => item[0]).filter(Boolean).join('');
            return res.json({
                success: true,
                author: SITE_CONFIG.siteName,
                originalText: text,
                targetLanguage: targetLang,
                result: translatedText,
                usage: { usedToday: req.keyInfo.count, remaining: req.keyInfo.limit - req.keyInfo.count, limit: req.keyInfo.limit }
            });
        } else {
            recordErrorLog(req.originalUrl, 'Gagal mengambil data translator', 500);
            return res.status(500).json({ success: false, message: 'Gagal memproses terjemahan.' });
        }
    } catch (err) {
        recordErrorLog(req.originalUrl, err.message, 500);
        return res.status(500).json({ success: false, message: `Gagal memproses terjemahan: ${err.message}` });
    }
});

// Endpoint 3: Shortlink Bypass
app.get('/api/bypass', checkRateLimit, async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl || targetUrl.trim() === '') {
        recordErrorLog(req.originalUrl, 'Parameter url kosong', 400);
        return res.status(400).json({ success: false, message: 'Parameter url tidak boleh kosong!' });
    }

    try {
        const bypassResponse = await fetch('https://zennq.my.id/api/bypass', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': ZENNQ_API_KEY },
            body: JSON.stringify({ url: targetUrl })
        });
        const data = await bypassResponse.json();

        if (data && data.data && data.data.bypassedUrl) {
            return res.json({
                success: true,
                author: SITE_CONFIG.siteName,
                originalUrl: targetUrl,
                result: data.data.bypassedUrl,
                usage: { usedToday: req.keyInfo.count, remaining: req.keyInfo.limit - req.keyInfo.count, limit: req.keyInfo.limit }
            });
        } else {
            const errMsg = data.message || 'Gagal melewati shortlink.';
            recordErrorLog(req.originalUrl, errMsg, 500);
            return res.status(500).json({ success: false, message: `Gagal bypass URL: ${errMsg}` });
        }
    } catch (err) {
        recordErrorLog(req.originalUrl, err.message, 500);
        return res.status(500).json({ success: false, message: `Gagal memproses bypass: ${err.message}` });
    }
});

// Endpoint 4: API Kalkulator (/api/calc)
app.get('/api/calc', checkRateLimit, (req, res) => {
    let { angka1, op, angka2 } = req.query;

    if (angka1 === undefined || op === undefined || angka2 === undefined) {
        recordErrorLog(req.originalUrl, 'Parameter kalkulator tidak lengkap', 400);
        return res.status(400).json({ 
            success: false, 
            message: 'Parameter angka1, op (+, -, x, :), dan angka2 wajib diisi!' 
        });
    }

    const num1 = parseFloat(angka1);
    const num2 = parseFloat(angka2);

    if (isNaN(num1) || isNaN(num2)) {
        recordErrorLog(req.originalUrl, 'Format angka kalkulator tidak valid', 400);
        return res.status(400).json({ success: false, message: 'angka1 dan angka2 harus berupa angka yang valid!' });
    }

    let hasil = 0;

    switch (op) {
        case '+':
            hasil = num1 + num2;
            break;
        case '-':
            hasil = num1 - num2;
            break;
        case 'x':
        case 'X':
        case '*':
            hasil = num1 * num2;
            break;
        case ':':
        case '/':
            if (num2 === 0) {
                recordErrorLog(req.originalUrl, 'Pembagian dengan nol', 400);
                return res.status(400).json({ success: false, message: 'Kesalahan: Tidak dapat membagi angka dengan nol (0)!' });
            }
            hasil = num1 / num2;
            break;
        default:
            recordErrorLog(req.originalUrl, `Operator tidak dikenal: ${op}`, 400);
            return res.status(400).json({ 
                success: false, 
                message: 'Operator tidak valid! Gunakan "+" (tambah), "-" (kurang), "x" (kali), atau ":" (bagi).' 
            });
    }

    return res.json({
        success: true,
        author: SITE_CONFIG.siteName,
        operasi: `${num1} ${op} ${num2}`,
        result: hasil,
        usage: {
            usedToday: req.keyInfo.count,
            remaining: req.keyInfo.limit - req.keyInfo.count,
            limit: req.keyInfo.limit
        }
    });
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
