// api/log.js
// Vercel Serverless Function：接收前端上傳的事件，寫入 Redis
//
// 這個專案連的是 Vercel Marketplace 的 "Redis" 整合，
// 注入的環境變數是 REDIS_URL（不是 @vercel/kv 用的 KV_REST_API_URL/TOKEN），
// 所以這裡改用 ioredis 直接連線。
//
// 事前準備：
//   1. package.json 的 dependencies 要有 "ioredis"（不再需要 @vercel/kv）
//   2. Vercel 專案 Settings → Environment Variables 要有 REDIS_URL（已確認存在）
//
// 資料結構：
//   logs:YYYY-MM-DD   → List，這天所有事件的完整紀錄（原始明細，可回溯）
//   best:{使用者名稱}  → Hash，該使用者每個 key 的最新值（例如 balloon_best、angrybird_best）

import Redis from "ioredis";

// Serverless function 每次冷啟動會重新建立連線；用全域變數快取，
// 同一個 function instance 之後的請求可以重複使用同一條連線。
let redis;
function getRedis() {
  if (!redis) {
    if (!process.env.REDIS_URL) {
      throw new Error("Missing REDIS_URL environment variable");
    }
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
    });
  }
  return redis;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    // duration/series 是 type==="attempt"（單次呼吸波形）才會有的欄位
    const { name, type, game, key, value, ts, duration, series, deviceId, via } = body;

    if (!type) {
      return res.status(400).json({ error: "missing type" });
    }

    const record = {
      name: (name || "使用者").slice(0, 40),
      type,
      game: game || null,
      key: key || null,
      value: value ?? null,
      ts: Number.isFinite(ts) ? ts : Date.now(),
      duration: Number.isFinite(duration) ? duration : null,
      // 序列資料做上限保護，避免單筆過大（每點只留 t 秒數、f 流量、d 方向）
      series: Array.isArray(series) ? series.slice(0, 300) : null,
      deviceId: deviceId ? String(deviceId).slice(0, 20) : null,  // 裝置 ID（MAC 後6碼）
      via: via || null,                                            // 連線方式 usb / ble
    };

    const dateStr = new Date(record.ts).toISOString().slice(0, 10);
    const bucket = `logs:${dateStr}`;

    const client = getRedis();

    await client.rpush(bucket, JSON.stringify(record));

    if (record.type === "score" && record.key) {
      await client.hset(`best:${record.name}`, record.key, String(record.value));
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("log.js error:", err);
    return res.status(500).json({ error: "internal error", message: String(err.message || err) });
  }
}
