export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, chapter, image, history = [], isMcq = false } = req.body;
  const apiKey = (process.env.GEMINI_API_KEY || '').replace(/[^a-zA-Z0-9_-]/g, '');

  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY সেট করা নেই। Vercel Settings-এ গিয়ে Key যোগ করো।' });
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
4. যদি ব্যবহারকারী MCQ টেস্ট চায়, তবে নির্বাচিত অধ্যায় (বা পুরো বই) থেকে ৫টি মানসম্মত বোর্ড স্ট্যান্ডার্ড MCQ প্রশ্ন (ক, খ, গ, ঘ অপশনসহ) দেবে এবং একদম নিচে আলাদা করে সঠিক উত্তর ও সংক্ষিপ্ত ব্যাখ্যা দেবে।`;

  const contents = history.map(h => ({
    role: h.role === 'user' ? 'user' : 'model',
    parts: [{ text: h.text }]
  }));

  const userParts = [];
  if (image) {
    const base64Data = image.split(',').at(1);
    const mimeType = image.split(';').at(0).split(':').at(1);
    userParts.push({ inlineData: { mimeType, data: base64Data } });
  }

  let promptText = message || '';
  if (chapter) promptText = `[অধ্যায়: ${chapter}]\n${promptText}`;
  if (isMcq) promptText = `${chapter ? chapter + ' অধ্যায়ের' : 'নবম-দশম পদার্থবিজ্ঞানের'} ওপর ৫টি গুরুত্বপূর্ণ MCQ প্রশ্ন তৈরি করো (উত্তর ও ব্যাখ্যাসহ)।`;

  userParts.push({ text: promptText });
  contents.push({ role: 'user', parts: userParts });

  const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];
  let lastError = '';

  for (const model of models) {
    try {
      const endpoint = 'https://googleapis.com' + model + ':generateContent?key=' + apiKey;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents
        })
      });

      const data = await response.json();
      if (!response.ok || data.error) {
        lastError = data?.error?.message || `HTTP ${response.status}`;
        continue;
      }

      const reply = data?.candidates?.at(0)?.content?.parts?.at(0)?.text;
      if (reply) {
        return res.status(200).json({ reply });
      }
    } catch (err) {
      lastError = err?.cause?.message || err.message;
    }
  }

  return res.status(500).json({ error: 'API ত্রুটি: ' + lastError });
}
