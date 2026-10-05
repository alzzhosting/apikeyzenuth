const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Penanganan lokasi database sementara di Vercel
const DB_FILE = process.env.VERCEL 
    ? path.join('/tmp', 'database.json') 
    : path.join(__dirname, 'database.json');

let memoryDB = { keys: {} };

// Pengaturan Terpusat Aplikasi
const SITE_CONFIG = {
    siteName: 'Zenuth AI Engine',
    aiName: 'Zenuth AI',
    themeName: 'Liquid Glass Platform',
    defaultLimit: 100,                     // Batas limit per 24 jam
    resetWindowMs: 24 * 60 * 60 * 1000,     // Durasi 24 jam
    maxLogsToKeep: 50                      // Batas simpan log error
};

// API Key Google Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6L3iwvouEq-l5shid2D11Y6XAPKzBn_mOT7QrEubSYJog';

// Daftar Model Resmi yang Valid di v1beta
const GEMINI_MODELS = [
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
    'gemini-1.5-pro-latest'
];

const errorLogs = [];

/**
 * Fungsi untuk mencatat riwayat error ke sistem log
 */
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
    } catch (err) {
        // Fallback simpan di memori jika filesystem terisolasi
    }
}

/**
 * Middleware Rate Limiter & Auto Recovery Key
 */
function checkRateLimit(req, res, next) {
    const apiKey = req.query.apikey || req.body.apikey;

    if (!apiKey) {
        recordErrorLog(req.originalUrl, 'Akses ditolak: API Key tidak disertakan', 401);
        return res.status(401).json({ success: false, message: 'API Key dibutuhkan! Dapatkan key di menu Pengaturan.' });
    }

    const db = loadDB();
    let keyData = db.keys[apiKey];

    // Pemulihan otomatis jika key SAW- terhapus dari memori serverless
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

    // Reset limit otomatis 24 jam
    if (now - keyData.lastReset >= SITE_CONFIG.resetWindowMs) {
        keyData.count = 0;
        keyData.lastReset = now;
    }

    // Cek batas limit
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

// Endpoint Utama AI dengan Fallback Model Valid
app.get('/api/ai', checkRateLimit, async (req, res) => {
    const prompt = req.query.prompt;

    if (!prompt || prompt.trim() === '') {
        recordErrorLog(req.originalUrl, 'Parameter prompt kosong', 400);
        return res.status(400).json({ success: false, message: 'Parameter prompt tidak boleh kosong!' });
    }

    let aiReply = null;
    let lastErrorMessage = 'Tidak ada respons valid dari seluruh model.';

    // Mencoba model secara berurutan
    for (const model of GEMINI_MODELS) {
        try {
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
            
            const response = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            });

            const data = await response.json();

            if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
                aiReply = data.candidates[0].content.parts[0].text;
                break; // Keluar dari perulangan jika berhasil
            } else if (data.error) {
                lastErrorMessage = `Model ${model}: ${data.error.message}`;
            }
        } catch (err) {
            lastErrorMessage = `Model ${model} Exception: ${err.message}`;
        }
    }

    if (aiReply) {
        return res.json({
            success: true,
            author: SITE_CONFIG.aiName,
            prompt: prompt,
            result: aiReply,
            usage: {
                usedToday: req.keyInfo.count,
                remaining: req.keyInfo.limit - req.keyInfo.count,
                limit: req.keyInfo.limit
            }
        });
    } else {
        recordErrorLog(req.originalUrl, lastErrorMessage, 500);
        return res.status(500).json({
            success: false,
            author: SITE_CONFIG.aiName,
            message: `Gagal memproses AI: Server sedang padat. Silakan coba beberapa saat lagi.`
        });
    }
});

app.get('/api/logs', (req, res) => {
    return res.json({ success: true, totalLogs: errorLogs.length, logs: errorLogs });
});

app.listen(PORT, () => {
    console.log(`Server aktif di http://localhost:${PORT}`);
});

module.exports = app;
