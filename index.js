const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));

// 環境變數
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const DIFY_API_URL = process.env.DIFY_API_URL || 'https://api.dify.ai/v1';
const GAS_URL = process.env.GAS_URL;

// 1. 接收 LINE 訊息並轉發給 Dify
app.post('/webhook', async (req, res) => {
    res.status(200).send('OK'); // 先回 LINE 200，避免超時
    const events = req.body.events;
    if (!events || events.length === 0) return;

    for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            try {
                // 打給 Dify 大腦
                const difyRes = await axios.post(`${DIFY_API_URL}/chat-messages`, {
                    inputs: {},
                    query: event.message.text,
                    response_mode: "blocking",
                    conversation_id: "", 
                    user: event.source.userId
                }, {
                    headers: { 'Authorization': `Bearer ${DIFY_API_KEY}`, 'Content-Type': 'application/json' }
                });

                // 回傳給 LINE 用戶
                await axios.post('https://api.line.me/v2/bot/message/reply', {
                    replyToken: event.replyToken,
                    messages: [{ type: 'text', text: difyRes.data.answer }]
                }, {
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
                });
            } catch (error) {
                console.error('API Error:', error.message);
            }
        }
    }
});

// 2. 接收 LIFF 表單資料 (射後不理打給 GAS)
app.post('/api/submit-inquiry', (req, res) => {
    res.status(200).json({ success: true, message: "資料已接收" }); // 秒回前端，極致 UX
    if (GAS_URL) {
        axios.post(GAS_URL, req.body, { headers: { 'Content-Type': 'application/json' } })
             .catch(err => console.error("GAS 寫入失敗:", err.message));
    }
});

app.listen(process.env.PORT || 3000, () => console.log(`老闆，系統啟動中！`));
