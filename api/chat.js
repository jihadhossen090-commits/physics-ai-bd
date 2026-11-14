import https from 'node:https';

function postJson(hostname, path, headers, payloadObj) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(payloadObj);
    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers
        }
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              data: JSON.parse(raw)
            });
          } catch (e) {
            reject(new Error('সার্ভার রেসপন্স পড়া যায়নি'));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, chapter, image, history = [], isMcq = false, userApiKey = '' } = req.body;
  const apiKey = (userApiKey || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || '').replace(/[^a-zA-Z0-9_.-]/g, '');

  if (!apiKey) {
    return res.status(500).json({ error: 'API Key সেট করা নেই। নিচের 🔑 API Key বাটনে ক্লিক করে gsk_... Key যোগ করো।' });
  }

  const systemInstruction = `তুমি বাংলাদেশের নবম-দশম (SSC) শ্রেণির NCTB পাঠ্যবই অনুসারে একজন অভিজ্ঞ ও বন্ধুত্বপূর্ণ পদার্থবিজ্ঞান শিক্ষক (PhysiAI)।
তোমার কাজ:
1. সহজ, প্রাঞ্জল ও শুদ্ধ বাংলায় ধাপে ধাপে পদার্থবিজ্ঞানের বিষয় ও গাণিতিক সমস্যা বুঝিয়ে দেওয়া।
2. উত্তর সাজানোর জন্য এই বিশেষ ফরম্যাট ব্যবহার করবে (কোনো Markdown ** বা # ব্যবহার করবে না):
   - মূল শিরোনামের লাইনের শুরুতে [H] লিখবে। (যেমন: [H] প্রদত্ত তথ্য ও সূত্র)
   - উপ-শিরোনামের শুরুতে [S] লিখবে।
   - গাণিতিক সূত্র বা সমীকরণের লাইনের শুরুতে [E] লিখবে। (যেমন: [E] v = u + at)
   - পয়েন্ট বা বুলেট লিস্টের শুরুতে [L] লিখবে।
3. গাণিতিক সমস্যায় অবশ্যই 'দেওয়া আছে', 'আমরা জানি', মান বসানো এবং শেষে সঠিক এককসহ উত্তর লিখবে।
4. যদি ব্যবহারকারী MCQ টেস্ট চায়, তবে নির্বাচিত অধ্যায় (বা পুরো বই) থেকে ২৫টি মানসম্মত বোর্ড স্ট্যান্ডার্ড MCQ প্রশ্ন (ক, খ, গ, ঘ অপশনসহ) দেবে এবং একদম নিচে আলাদা করে সঠিক উত্তর ও সংক্ষিপ্ত ব্যাখ্যা দেবে।`;

  let promptText = message || '';
  if (chapter) promptText = `[অধ্যায়: ${chapter}]\n${promptText}`;
  if (isMcq) promptText = `${chapter ? chapter + ' অধ্যায়ের' : 'নবম-দশম পদার্থবিজ্ঞানের'} ওপর ২৫টি গুরুত্বপূর্ণ MCQ প্রশ্ন তৈরি করো (উত্তর ও ব্যাখ্যাসহ)।`;

  const messages = [{ role: 'system', content: systemInstruction }];
  for (const h of history.slice(-6)) {
    messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text });
  }

  if (image) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: promptText || 'ছবির প্রশ্নটি সমাধান করে বুঝিয়ে দাও।' },
        { type: 'image_url', image_url: { url: image } }
      ]
    });
  } else {
    messages.push({ role: 'user', content: promptText });
  }

  const groqModels = image
    ? ['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.2-11b-vision-preview']
    : ['llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.1-8b-instant'];

  let lastError = '';
  for (const model of groqModels) {
    try {
      const host = ['api', 'groq', 'com'].join('.');
      const result = await postJson(
        host,
        '/openai/v1/chat/completions',
        { Authorization: 'Bearer ' + apiKey },
        { model, messages, temperature: 0.5, max_tokens: 4096 }
      );

      if (!result.ok || result.data.error) {
        lastError = result.data?.error?.message || `HTTP ${result.status}`;
        continue;
      }

      const reply = result.data?.choices?.at(0)?.message?.content;
      if (reply) {
        return res.status(200).json({ reply });
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  return res.status(500).json({ error: 'Groq API ত্রুটি: ' + lastError });
}
