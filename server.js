const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// =========================================================================
// 1. PENGATURAN TERPUSAT & GEMINI API KEY
// =========================================================================
const SITE_CONFIG = {
    siteName: 'Zenuth AI Engine',
    aiName: 'Zenuth AI',
    themeName: 'Liquid Glass Platform',
    defaultLimit: 100,                     // Limit harian per API Key
    resetWindowMs: 24 * 60 * 60 * 1000,     // Durasi reset 24 jam (milidetik)
    maxLogsToKeep: 50                      // Batas simpan riwayat error log
};

// API Key Google Gemini
const GEMINI_API_KEY = 'AQ.Ab8RN6JOzUZtqxehiP4m7pQyNPand0a7eB79sG1acP0wauo1Fg';

// Array Penyimpan Log Error Server
const errorLogs = [];

/**
 * Fungsi untuk mencatat setiap error ke dalam riwayat log
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

// Middleware Express
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Management Database JSON Lokal
function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ keys: {} }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// =========================================================================
// 2. MIDDLEWARE CHECKER RATE LIMIT 24 JAM
// =========================================================================
function checkRateLimit(req, res, next) {
    const apiKey = req.query.apikey || req.body.apikey;

    if (!apiKey) {
        recordErrorLog(req.originalUrl, 'Akses ditolak: API Key tidak disertakan dalam request', 401);
        return res.status(401).json({ success: false, message: 'API Key dibutuhkan! Dapatkan key di menu Pengaturan.' });
    }

    const db = loadDB();
    const keyData = db.keys[apiKey];

    if (!keyData) {
        recordErrorLog(req.originalUrl, `API Key tidak terdaftar: ${apiKey}`, 403);
        return res.status(403).json({ success: false, message: 'API Key tidak valid atau belum terdaftar!' });
    }

    const now = Date.now();

    // Reset otomatis jika sudah melewati 24 jam
    if (now - keyData.lastReset >= SITE_CONFIG.resetWindowMs) {
        keyData.count = 0;
        keyData.lastReset = now;
    }

    // Cek jika limit harian sudah habis
    if (keyData.count >= keyData.limit) {
        const nextResetHours = Math.ceil((SITE_CONFIG.resetWindowMs - (now - keyData.lastReset)) / (1000 * 60 * 60));
        const errorMsg = `Limit harian habis (${keyData.limit}/${keyData.limit}) untuk key ${apiKey}. Reset dalam ${nextResetHours} jam.`;
        
        recordErrorLog(req.originalUrl, errorMsg, 429);
        return res.status(429).json({
            success: false,
            message: `Limit request harian (${keyData.limit}/${keyData.limit}) telah habis. Otomatis reset dalam ${nextResetHours} jam.`
        });
    }

    // Tambah jumlah pemakaian
    keyData.count += 1;
    saveDB(db);

    req.keyInfo = keyData;
    next();
}

// =========================================================================
// 3. ROUTE DAN ENDPOINT API
// =========================================================================

// Halaman Utama Dokumentasi
app.get('/', (req, res) => {
    res.render('docs', { config: SITE_CONFIG });
});

// Endpoint Membuat API Key Baru
app.post('/api/generate-key', (req, res) => {
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
});

// Endpoint Cek Status Limit API Key
app.get('/api/check-key', (req, res) => {
    const { apikey } = req.query;
    if (!apikey) {
        return res.json({ success: false, message: 'Parameter apikey diperlukan.' });
    }

    const db = loadDB();
    const keyData = db.keys[apikey];

    if (!keyData) {
        return res.json({ success: false, message: 'Key tidak ditemukan.' });
    }

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

// =========================================================================
// 4. ENDPOINT ZENUTH AI (INTEGRASI GOOGLE GEMINI)
// =========================================================================
app.get('/api/ai', checkRateLimit, async (req, res) => {
    const prompt = req.query.prompt;

    if (!prompt || prompt.trim() === '') {
        recordErrorLog(req.originalUrl, 'Parameter prompt kosong pada request AI', 400);
        return res.status(400).json({ success: false, message: 'Parameter prompt tidak boleh kosong!' });
    }

    try {
        // Pemanggilan REST API Google Gemini 2.5 Flash
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [
                    {
                        parts: [{ text: prompt }]
                    }
                ]
            })
        });

        const data = await response.json();

        // Cek jika respons dari Gemini berhasil
        if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
            const aiReply = data.candidates[0].content.parts[0].text;

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
            // Tangkap pesan error dari API Gemini jika ada
            const errMsg = data.error ? data.error.message : 'Gagal memperoleh respons valid dari engine Gemini.';
            recordErrorLog(req.originalUrl, `Gemini API Error: ${errMsg}`, 500);

            return res.status(500).json({
                success: false,
                author: SITE_CONFIG.aiName,
                message: `Gagal memproses AI: ${errMsg}`
            });
        }
    } catch (err) {
        recordErrorLog(req.originalUrl, `Server Exception: ${err.message}`, 500);
        return res.status(500).json({
            success: false,
            author: SITE_CONFIG.aiName,
            message: 'Terjadi kesalahan pada server saat menghubungkan ke AI.'
        });
    }
});

// Endpoint Mengambil Log Error
app.get('/api/logs', (req, res) => {
    return res.json({
        success: true,
        totalLogs: errorLogs.length,
        logs: errorLogs
    });
});

// Menjalankan Server
app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`${SITE_CONFIG.siteName} (${SITE_CONFIG.aiName}) Aktif di: http://localhost:${PORT}`);
    console.log(`=================================================`);
});
