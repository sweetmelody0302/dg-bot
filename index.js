const express = require('express');
const axios = require('axios');
const cors = require('cors'); // 處理跨網域請求，讓您的 Dashboard 可以順利連線

const app = express();
app.use(cors());
// 允許解析 JSON 格式的請求內容
app.use(express.json()); 
// 允許解析 URL-encoded 格式的請求內容
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 讀取 Zeabur 後台設定的環境變數 (靈魂注入)
// ==========================================
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const GAS_URL = process.env.GAS_URL;
const DIFY_API_URL = 'https://api.dify.ai/v1'; 

// ==========================================
// 🌟 【全新小幫手】將對話紀錄傳送至 Google Sheets 雲端儲存
// ==========================================
async function saveChatToCloud(uid, sender, text) {
    if (!GAS_URL) return; // 如果沒設定 GAS 網址就不執行
    try {
        await axios.post(GAS_URL, {
            action: "save_chat", // 告訴 GAS 這是要存對話的指令
            lineUid: uid,
            sender: sender,
            message: text
        }, { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        console.error("儲存對話失敗:", e.message);
    }
}

// ==========================================
// 1. 接收 LINE 官方帳號的訊息，轉發給 Dify (AI 顧問對話)
// ==========================================
app.post('/webhook', async (req, res) => {
    // 收到 LINE 訊息先火速回 200 OK，避免 LINE 逾時重試
    res.status(200).send('OK');
    
    const events = req.body.events;
    if (!events || events.length === 0) return;

    for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            try {
                const uid = event.source.userId;
                const userText = event.message.text;

                // 🌟 紀錄客戶說的話到 Google Sheets
                saveChatToCloud(uid, "客戶", userText);

                // 打給 Dify 大腦 (使用串流模式 Streaming)
                const difyRes = await axios.post(`${DIFY_API_URL}/chat-messages`, {
                    inputs: {},
                    query: userText,
                    response_mode: "streaming", 
                    user: uid 
                }, {
                    headers: { 
                        'Authorization': `Bearer ${DIFY_API_KEY}`, 
                        'Content-Type': 'application/json' 
                    },
                    responseType: 'stream' 
                });

                // 組裝 Dify 吐出來的碎片
                const fullAnswer = await new Promise((resolve, reject) => {
                    let answer = '';
                    let buffer = '';
                    difyRes.data.on('data', (chunk) => {
                        buffer += chunk.toString();
                        let boundary = buffer.indexOf('\n');
                        while (boundary !== -1) {
                            let line = buffer.slice(0, boundary).trim();
                            buffer = buffer.slice(boundary + 1);
                            if (line.startsWith('data: ')) {
                                try {
                                    let data = JSON.parse(line.slice(6));
                                    if ((data.event === 'agent_message' || data.event === 'message') && data.answer) {
                                        answer += data.answer;
                                    }
                                } catch (e) {}
                            }
                            boundary = buffer.indexOf('\n');
                        }
                    });
                    difyRes.data.on('end', () => resolve(answer));
                    difyRes.data.on('error', (err) => reject(err));
                });

                if (!fullAnswer) return;

                // 🌟 紀錄 AI 說的話到 Google Sheets
                saveChatToCloud(uid, "AI 顧問", fullAnswer);

                // 回傳給 LINE 客戶
                await axios.post('https://api.line.me/v2/bot/message/reply', {
                    replyToken: event.replyToken,
                    messages: [{ type: 'text', text: fullAnswer }]
                }, {
                    headers: { 
                        'Content-Type': 'application/json', 
                        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` 
                    }
                });
            } catch (error) {
                console.error('API 錯誤:', error.message);
            }
        }
    }
});

// ==========================================
// 2. 接收 LIFF 表單送出的資料 (寫入試算表 + 主動發送明細)
// ==========================================
app.post('/api/submit-inquiry', async (req, res) => {
    res.status(200).json({ success: true, message: "資料已接收" });
    const { lineUid, lineName, company, contactName, painpoints, budget } = req.body;

    // 寫入 Google Sheets (詢價名單)
    if (GAS_URL) {
        axios.post(GAS_URL, req.body, { headers: { 'Content-Type': 'application/json' } })
             .catch(err => console.error("GAS 寫入失敗:", err.message));
    }

    // 發送回執給客戶 (排除預覽訪客)
    if (lineUid && lineUid !== "preview-user-123") {
        try {
            const receiptMsg = `✅ 【DG 數位引力】需求已收妥！\n\n${contactName} 您好，感謝您的填寫。我們已收到您的評估需求，以下是您的資料明細：\n\n🏢 企業名稱：${company}\n🎯 核心痛點：${painpoints || '無'}\n💰 預計預算：${budget}\n\n🤖 我們的資深 AI 架構師已收到通知，將會盡快為您評估並主動與您聯繫！`;

            await axios.post('https://api.line.me/v2/bot/message/push', {
                to: lineUid,
                messages: [{ type: 'text', text: receiptMsg }]
            }, {
                headers: { 
                    'Content-Type': 'application/json', 
                    'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` 
                }
            });
            
            // 🌟 紀錄系統主動發送的回執信
            saveChatToCloud(lineUid, "系統自動推播", "✅ 已發送需求確認回執信給客戶");
            
            console.log("回執訊息已成功發送給 UID:", lineUid);
        } catch (error) {
            console.error("回傳明細失敗:", error.response ? JSON.stringify(error.response.data) : error.message);
        }
    }
});

// ==========================================
// 3. 提供 CRM 儀表板抓取「客戶名單」
// ==========================================
app.get('/api/inquiries', async (req, res) => {
    if (!GAS_URL) {
        return res.status(500).json({ status: "error", error: "未設定 GAS_URL 環境變數" });
    }
    
    try {
        const response = await axios.get(GAS_URL);
        res.status(200).json(response.data);
    } catch (error) {
        console.error("讀取名單失敗:", error.message);
        res.status(500).json({ status: "error", error: "無法從 Google Sheets 讀取資料" });
    }
});

// ==========================================
// 🌟 【全新功能】提供 CRM 儀表板讀取特定客戶的「完整雲端對話紀錄」
// ==========================================
app.get('/api/chat-history', async (req, res) => {
    const { uid } = req.query;
    if (!GAS_URL || !uid) return res.status(400).json({ success: false, message: "缺少必要參數" });
    
    try {
        // 向 GAS 請求該 UID 的專屬歷史對話 (帶上 action=get_chat 參數)
        const response = await axios.get(`${GAS_URL}?action=get_chat&uid=${uid}`);
        res.status(200).json(response.data);
    } catch (error) {
        console.error("讀取歷史對話失敗:", error.message);
        res.status(500).json({ success: false, message: "讀取歷史對話失敗" });
    }
});

// ==========================================
// 4. 提供 CRM 儀表板「一鍵回覆」功能
// ==========================================
app.post('/api/reply', async (req, res) => {
    const { lineUid, message } = req.body;
    
    if (!lineUid || !message) {
        return res.status(400).json({ success: false, message: "缺少 UID 或訊息內容，無法發送" });
    }

    try {
        // 大腦接到老闆從網頁打的字，直接用 LINE 官方帳號 Push 給客戶
        await axios.post('https://api.line.me/v2/bot/message/push', {
            to: lineUid,
            messages: [{ type: 'text', text: message }]
        }, {
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` 
            }
        });
        
        // 🌟 紀錄老闆親自說的話到 Google Sheets
        saveChatToCloud(lineUid, "老闆 (官方)", message);
        
        console.log(`老闆已成功從儀表板發送訊息給: ${lineUid}`);
        res.status(200).json({ success: true, message: "訊息已成功發送至客戶 LINE" });
    } catch (error) {
        console.error("發送回覆失敗:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, message: "發送失敗，請檢查 LINE OA 推播額度或 UID" });
    }
});

// 設定伺服器監聽的 Port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`老闆，DG 數位引力系統已成功啟動！正在監聽 Port ${PORT}`));
