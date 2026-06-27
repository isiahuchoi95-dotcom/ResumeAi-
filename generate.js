import { Redis } from '@upstash/redis';

const FREE_LIMIT = 3;
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function getTodayKey(ip) {
  const today = new Date().toISOString().slice(0, 10);
  return `usage:${ip}:${today}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  const { prompt, plan } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  const isPro = plan === process.env.PRO_SECRET;

  if (!isPro) {
    const key = getTodayKey(ip);
    const used = parseInt(await redis.get(key) || '0');

    if (used >= FREE_LIMIT) {
      return res.status(429).json({
        error: 'limit_reached',
        message: `You've used all ${FREE_LIMIT} free generations today. Upgrade to Pro for unlimited access!`,
        used,
        limit: FREE_LIMIT,
        remaining: 0
      });
    }

    await redis.set(key, used + 1, { ex: 86400 });

    const newUsed = used + 1;
    const result = await callClaude(prompt);
    if (result.error) return res.status(500).json({ error: result.error });

    return res.status(200).json({
      result: result.text,
      used: newUsed,
      limit: FREE_LIMIT,
      remaining: FREE_LIMIT - newUsed
    });
  }

  const result = await callClaude(prompt);
  if (result.error) return res.status(500).json({ error: result.error });
  return res.status(200).json({ result: result.text, used: 0, limit: 999, remaining: 999 });
}

async function callClaude(prompt) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    if (data.error) return { error: data.error.message };
    return { text: data.content?.map(b => b.text || '').join('') || '' };
  } catch (err) {
    return { error: 'Failed to call Claude API' };
  }
}
