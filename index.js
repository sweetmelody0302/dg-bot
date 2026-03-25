const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 讀取老闆在 Zeabur 後台填寫的環境變數
// ==========================================
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const GAS_URL = process.env.GAS_URL;
// Dify 官方雲端版預設網址 (防呆機制，老闆不用填這個)
const DIFY_API_URL = 'https://api.dify.ai/v1'; 

// ==========================================
// 1. 接收 LINE 訊息並轉發給 Dify
// ==========================================
app.post('/webhook', async (req, res) => {
    // 收到 LINE 訊息先火速回 200 OK，避免 LINE Server 逾時重試
    res.status(200).send('OK');
    
    const events = req.body.events;
    if (!events || events.length === 0) return;

    for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            try {
                // 打給 Dify 大腦
                const difyRes = await axios.post(`${DIFY_API_URL}/chat-messages`, {
                    inputs: {},
                    query: event.message.text,
                    response_mode: "streaming", // CTO 修正：Agent 必須使用 streaming (串流) 模式
                    user: event.source.userId // 用 LINE UID 區分不同客人
                }, {
                    headers: { 
                        'Authorization': `Bearer ${DIFY_API_KEY}`, 
                        'Content-Type': 'application/json' 
                    },
                    responseType: 'stream' // 告訴 Axios 我們要接收串流資料
                });

                // 收集 Dify 像打字機一樣吐出來的每一個字
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
                                    // Agent 專屬的事件名稱，把 answer 碎片拼起來
                                    if ((data.event === 'agent_message' || data.event === 'message') && data.answer) {
                                        answer += data.answer;
                                    }
                                } catch (e) {
                                    // 忽略不完整的 JSON 碎片
                                }
                            }
                            boundary = buffer.indexOf('\n');
                        }
                    });
                    difyRes.data.on('end', () => resolve(answer));
                    difyRes.data.on('error', (err) => reject(err));
                });

                if (!fullAnswer) {
                    console.log("Dify 回傳空字串，可能是 RAG 知識庫沒有命中");
                    return; // 避免傳送空訊息給 LINE 導致報錯
                }

                // 將拼好的完整回答，回傳給 LINE 用戶
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
                // CTO 除錯雷達：把詳細的錯誤原因印出來，方便在 Zeabur Logs 抓蟲
                console.error('API 串接錯誤細節:', error.response ? JSON.stringify(error.response.data) : error.message);
            }
        }
    }
});

// ==========================================
// 2. 接收 LIFF 表單資料 (射後不理，打給 GAS)
// ==========================================
app.post('/api/submit-inquiry', (req, res) => {
    // 收到資料後秒回前端成功，讓客戶的手機畫面瞬間關閉，極致 UX！
    res.status(200).json({ success: true, message: "資料已接收" });
    
    // 背景射後不理，把資料往 Google Sheets 丟
    if (GAS_URL) {
        axios.post(GAS_URL, req.body, { headers: { 'Content-Type': 'application/json' } })
             .catch(err => console.error("GAS 寫入失敗:", err.message));
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`老闆，DG 數位引力系統已成功啟動！`));
