const express = require('express');
const axios = require('axios');
const cors = require('cors');

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
// 1. 接收 LINE 官方帳號的訊息，轉發給 Dify (AI 顧問對話)
// ==========================================
app.post('/webhook', async (req, res) => {
    // LINE 的要求：收到任何 webhook 都必須先回傳 HTTP 200 OK，否則 LINE 會視為失敗並重試
    res.status(200).send('OK');
    
    const events = req.body.events;
    // 如果沒有事件或事件為空，直接結束
    if (!events || events.length === 0) return;

    for (const event of events) {
        // 只處理文字訊息
        if (event.type === 'message' && event.message.type === 'text') {
            try {
                // 將收到的文字訊息發送給 Dify API (Agent 大腦)
                const difyRes = await axios.post(`${DIFY_API_URL}/chat-messages`, {
                    inputs: {},
                    query: event.message.text,
                    response_mode: "streaming", // Agent 必須使用 streaming (串流) 模式
                    user: event.source.userId // 使用 LINE 使用者的 UID 來區分不同對話
                }, {
                    headers: { 
                        'Authorization': `Bearer ${DIFY_API_KEY}`, 
                        'Content-Type': 'application/json' 
                    },
                    responseType: 'stream' // 告訴 axios 我們預期收到串流資料
                });

                // 因為 Dify 是一段一段回傳，我們需要把它組裝成完整的字串
                const fullAnswer = await new Promise((resolve, reject) => {
                    let answer = '';
                    let buffer = '';
                    difyRes.data.on('data', (chunk) => {
                        buffer += chunk.toString();
                        let boundary = buffer.indexOf('\n');
                        while (boundary !== -1) {
                            let line = buffer.slice(0, boundary).trim();
                            buffer = buffer.slice(boundary + 1);
                            // Dify 串流格式為 "data: {JSON}"
                            if (line.startsWith('data: ')) {
                                try {
                                    let data = JSON.parse(line.slice(6));
                                    // 將每次回傳的一小段文字拼接到 answer 中
                                    if ((data.event === 'agent_message' || data.event === 'message') && data.answer) {
                                        answer += data.answer;
                                    }
                                } catch (e) {
                                    // 忽略無法解析的 JSON 片段
                                }
                            }
                            boundary = buffer.indexOf('\n');
                        }
                    });
                    difyRes.data.on('end', () => resolve(answer));
                    difyRes.data.on('error', (err) => reject(err));
                });

                // 如果 AI 沒有給出答案，就不回傳訊息 (避免 LINE 報錯)
                if (!fullAnswer) return;

                // 將完整的回答回傳給 LINE 使用者 (Reply Message，不扣額度)
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
// 2. 接收 LIFF 表單送出的資料 (寫入試算表 + 主動發送明細給客戶)
// ==========================================
app.post('/api/submit-inquiry', async (req, res) => {
    // 1. 收到表單資料後，立刻回傳成功給前端 (讓 LIFF 表單能瞬間關閉視窗)
    res.status(200).json({ success: true, message: "資料已接收" });
    
    // 從請求中解構出客戶填寫的欄位
    const { lineUid, lineName, company, contactName, painpoints, budget } = req.body;

    // 2. 將資料轉發到 Google Apps Script (GAS) 寫入試算表
    // 這是背景作業，不會卡住前面的流程
    if (GAS_URL) {
        axios.post(GAS_URL, req.body, { headers: { 'Content-Type': 'application/json' } })
             .catch(err => console.error("GAS 寫入失敗:", err.message));
    }

    // 3. 【全新回執功能】主動推播明細給客戶
    // 檢查是否有拿到真實的 LINE UID，排除預覽模式的假資料
    if (lineUid && lineUid !== "preview-user-123") {
        try {
            // 組裝準備發給客戶的確認訊息內容
            const receiptMsg = `✅ 【DG 數位引力】需求已收妥！\n\n${contactName} 您好，感謝您的填寫。我們已收到您的評估需求，以下是您的資料明細：\n\n🏢 企業名稱：${company}\n🎯 核心痛點：${painpoints || '無'}\n💰 預計預算：${budget}\n\n🤖 我們的資深 AI 架構師已收到通知，將會盡快為您評估並主動與您聯繫！`;

            // 使用 LINE Push Message API 主動發送訊息 (注意：這個會扣 LINE OA 的訊息額度)
            await axios.post('https://api.line.me/v2/bot/message/push', {
                to: lineUid, // 指定發送給剛剛填寫表單的使用者
                messages: [{ type: 'text', text: receiptMsg }]
            }, {
                headers: { 
                    'Content-Type': 'application/json', 
                    'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` 
                }
            });
            console.log("回執訊息已成功發送給 UID:", lineUid);
        } catch (error) {
            // 如果發送失敗 (例如 Token 錯誤或 UID 不存在)，把詳細錯誤印到 Zeabur Logs 方便追查
            console.error("回傳明細失敗:", error.response ? JSON.stringify(error.response.data) : error.message);
        }
    } else {
        console.log("未收到有效 LINE UID 或處於預覽模式，略過發送回執訊息。");
    }
});

// 設定伺服器監聽的 Port (Zeabur 會自動提供 process.env.PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`老闆，DG 數位引力系統已成功啟動！正在監聽 Port ${PORT}`));
