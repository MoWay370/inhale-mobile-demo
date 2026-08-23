// api/view.js
// 查詢端點：讀出 Redis 裡的訓練紀錄，給 dashboard.html 使用。
// 需要 HTTP Basic Auth（帳號 ibreath / 密碼 123）才能存取。
//
// 用法：
//   GET /api/view                     → 預設回傳最近 7 天的所有明細事件
//   GET /api/view?days=30             → 最近 30 天
//   GET /api/view?name=111            → 只看某個使用者（比對 name 欄位）
//   GET /api/view?best=1              → 額外附上所有使用者的 best:* 彙總表

import Redis from "ioredis";

const AUTH_USER = "ibreath";
const AUTH_PASS = "123";

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

function dateStrDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function checkAuth(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx === -1) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return user === AUTH_USER && pass === AUTH_PASS;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!checkAuth(req)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="i-Breath Dashboard"');
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const client = getRedis();
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
    const nameFilter = (req.query.name || "").trim();
    const wantBest = req.query.best === "1";

    const bucketKeys = [];
    for (let i = 0; i < days; i++) {
      bucketKeys.push(`logs:${dateStrDaysAgo(i)}`);
    }

    const lists = await Promise.all(
      bucketKeys.map((k) => client.lrange(k, 0, -1))
    );

    let records = [];
    lists.forEach((arr) => {
      arr.forEach((raw) => {
        try {
          records.push(JSON.parse(raw));
        } catch {
          // 忽略壞掉的資料列
        }
      });
    });

    if (nameFilter) {
      records = records.filter((r) => r.name === nameFilter);
    }

    records.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    let bestTable = null;
    if (wantBest) {
      const names = Array.from(new Set(records.map((r) => r.name).filter(Boolean)));
      const bestEntries = await Promise.all(
        names.map(async (n) => {
          const h = await client.hgetall(`best:${n}`);
          return [n, h];
        })
      );
      bestTable = Object.fromEntries(bestEntries);
    }

    return res.status(200).json({
      ok: true,
      count: records.length,
      records,
      best: bestTable,
    });
  } catch (err) {
    console.error("view.js error:", err);
    return res.status(500).json({ error: "internal error", message: String(err.message || err) });
  }
}
