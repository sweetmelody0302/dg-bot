const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 讀取環境變數
// ==========================================
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const GAS_URL = process.env.GAS_URL;
const DIFY_API_URL = 'https://api.dify.ai/v1'; 

// 🌟 【資安升級】讀取您剛剛在 Zeabur 設定的老闆密碼 (如果沒設定，預設為 dg888)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dg888';

// 🌟 【資安升級】建立「保全檢查站 (Middleware)」
// 只要是讀取機密資料的請求，都必須經過這裡檢查密碼
const checkAdminAuth = (req, res, next) => {
    // 從請求的「標頭(Headers)」中拿出密碼
    const providedPassword = req.headers['authorization'];
    
    // 核對密碼是否與 Zeabur 環境變數設定的一致
    if (!providedPassword || providedPassword !== `Bearer ${ADMIN_PASSWORD}`) {
        console.log("⚠️ 偵測到未授權的存取嘗試！");
        return res.status(401).json({ success: false, message: "密碼錯誤或未授權，拒絕存取機密資料！" });
    }
    next(); // 密碼正確，放行！
};

// 將對話紀錄傳送至 Google Sheets 的小幫手
async function saveChatToCloud(uid, sender, text) {
    if (!GAS_URL) return;
    try {
        await axios.post(GAS_URL, {
            action: "save_chat",
            lineUid: uid,
            sender: sender,
            message: text
        }, { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        console.error("儲存對話失敗:", e.message);
    }
}

// ==========================================
// 1. 接收 LINE 訊息 (公開區域，不需要密碼)
// ==========================================
app.post('/webhook', async (req, res) => {
    res.status(200).send('OK');
    const events = req.body.events;
    if (!events || events.length === 0) return;

    for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            try {
                const uid = event.source.userId;
                const userText = event.message.text;
                saveChatToCloud(uid, "客戶", userText);

                const difyRes = await axios.post(`${DIFY_API_URL}/chat-messages`, {
                    inputs: {}, query: userText, response_mode: "streaming", user: uid 
                }, { headers: { 'Authorization': `Bearer ${DIFY_API_KEY}`, 'Content-Type': 'application/json' }, responseType: 'stream' });

                const fullAnswer = await new Promise((resolve, reject) => {
                    let answer = ''; let buffer = '';
                    difyRes.data.on('data', (chunk) => {
                        buffer += chunk.toString(); let boundary = buffer.indexOf('\n');
                        while (boundary !== -1) {
                            let line = buffer.slice(0, boundary).trim(); buffer = buffer.slice(boundary + 1);
                            if (line.startsWith('data: ')) {
                                try {
                                    let data = JSON.parse(line.slice(6));
                                    if ((data.event === 'agent_message' || data.event === 'message') && data.answer) answer += data.answer;
                                } catch (e) {}
                            }
                            boundary = buffer.indexOf('\n');
                        }
                    });
                    difyRes.data.on('end', () => resolve(answer));
                    difyRes.data.on('error', (err) => reject(err));
                });

                if (!fullAnswer) return;
                saveChatToCloud(uid, "AI 顧問", fullAnswer);

                await axios.post('https://api.line.me/v2/bot/message/reply', {
                    replyToken: event.replyToken, messages: [{ type: 'text', text: fullAnswer }]
                }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } });
            } catch (error) { console.error('API 錯誤:', error.message); }
        }
    }
});

// ==========================================
// 2. 接收 LIFF 表單資料 (公開區域，給客戶填單用的，不需密碼)
// ==========================================
app.post('/api/submit-inquiry', async (req, res) => {
    res.status(200).json({ success: true, message: "資料已接收" });
    const { lineUid, lineName, company, contactName, painpoints, budget } = req.body;

    if (GAS_URL) axios.post(GAS_URL, req.body, { headers: { 'Content-Type': 'application/json' } }).catch(err => console.error("GAS 寫入失敗:", err.message));

    if (lineUid && lineUid !== "preview-user-123") {
        try {
            const receiptMsg = `✅ 【DG 數位引力】需求已收妥！\n\n${contactName} 您好，感謝您的填寫。我們已收到您的評估需求，以下是您的資料明細：\n\n🏢 企業名稱：${company}\n🎯 核心痛點：${painpoints || '無'}\n💰 預計預算：${budget}\n\n🤖 我們的資深 AI 架構師已收到通知，將會盡快為您評估並主動與您聯繫！`;
            await axios.post('https://api.line.me/v2/bot/message/push', {
                to: lineUid, messages: [{ type: 'text', text: receiptMsg }]
            }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } });
            saveChatToCloud(lineUid, "系統自動推播", "✅ 已發送需求確認回執信給客戶");
        } catch (error) { console.error("回傳明細失敗:", error.message); }
    }
});

// ==========================================
// 🌟 【全新】前端登入驗證 API
// 讓前端儀表板來核對密碼是否正確
// ==========================================
app.post('/api/verify-password', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.status(200).json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "密碼錯誤" });
    }
});

// ==========================================
// 3. 讀取客戶名單 🌟 (機密區域，加入 checkAdminAuth 保全檢查)
// ==========================================
app.get('/api/inquiries', checkAdminAuth, async (req, res) => {
    if (!GAS_URL) return res.status(500).json({ status: "error", error: "未設定 GAS 網址" });
    try {
        const response = await axios.get(GAS_URL);
        res.status(200).json(response.data);
    } catch (error) { res.status(500).json({ status: "error", error: "無法從 Google Sheets 讀取" }); }
});

// ==========================================
// 4. 讀取歷史對話 🌟 (機密區域，加入 checkAdminAuth 保全檢查)
// ==========================================
app.get('/api/chat-history', checkAdminAuth, async (req, res) => {
    const { uid } = req.query;
    if (!GAS_URL || !uid) return res.status(400).json({ success: false, message: "缺少必要參數" });
    try {
        const response = await axios.get(`${GAS_URL}?action=get_chat&uid=${uid}`);
        res.status(200).json(response.data);
    } catch (error) { res.status(500).json({ success: false, message: "讀取歷史對話失敗" }); }
});

// ==========================================
// 5. 老闆一鍵回覆 🌟 (機密操作，加入 checkAdminAuth 保全檢查)
// ==========================================
app.post('/api/reply', checkAdminAuth, async (req, res) => {
    const { lineUid, message } = req.body;
    if (!lineUid || !message) return res.status(400).json({ success: false, message: "資料不全" });
    try {
        await axios.post('https://api.line.me/v2/bot/message/push', {
            to: lineUid, messages: [{ type: 'text', text: message }]
        }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } });
        saveChatToCloud(lineUid, "老闆 (官方)", message);
        res.status(200).json({ success: true, message: "發送成功" });
    } catch (error) { res.status(500).json({ success: false, message: "發送失敗" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`老闆，DG 系統已啟動！正在監聽 Port ${PORT}`));
