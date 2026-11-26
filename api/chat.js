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
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              data: JSON.parse(raw)
            });
          } catch (e) {
            reject(new Error('সার্ভার রেসপন্স পড়া যায়নি'));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function detectMcqRequest({ message = '', chapter = '', isMcq = false }) {
  const text = `${message} ${chapter}`;
  return (
    Boolean(isMcq) ||
    (Boolean(chapter) && (text.includes('MCQ') || text.includes('"options"') || text.includes('JSON'))) ||
    (text.includes('MCQ') && text.includes('"options"') && text.includes('"ans"'))
  );
}

function repairStringLiterals(jsonLikeText) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonLikeText.length; i++) {
    const ch = jsonLikeText[i];

    if (escaped) {
      if (!/["\\/bfnrtu]/.test(ch)) {
        out = out.slice(0, -1) + '\\\\' + ch;
      } else {
        out += ch;
      }
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      if (!inString) {
        out += '\\\\';
      } else {
        out += ch;
        escaped = true;
      }
      continue;
    }

    if (ch === '"') {
      if (!inString) {
        inString = true;
        out += ch;
      } else {
        let j = i + 1;
        while (j < jsonLikeText.length && /\s/.test(jsonLikeText[j])) j++;
        const nextChar = jsonLikeText[j];
        if (
          nextChar === ':' ||
          nextChar === ',' ||
          nextChar === ']' ||
          nextChar === '}' ||
          j >= jsonLikeText.length
        ) {
          inString = false;
          out += ch;
        } else {
          out += '\\"';
        }
      }
      continue;
    }

    if (inString && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && jsonLikeText[i + 1] === '\n') i++;
      out += '\\n';
      continue;
    }

    out += ch;
  }

  if (inString) out += '"';
  return out;
}

function sanitizeMcqJson(rawText) {
  let cleaned = String(rawText || '')
    .replace(/```json|```/gi, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .trim();

  const firstObj = cleaned.indexOf('{');
  const firstArr = cleaned.indexOf('[');
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    const lastArr = cleaned.lastIndexOf(']');
    cleaned = lastArr > firstArr ? cleaned.slice(firstArr, lastArr + 1) : cleaned.slice(firstArr);
  } else if (firstObj !== -1) {
    const lastObj = cleaned.lastIndexOf('}');
    cleaned = lastObj > firstObj ? cleaned.slice(firstObj, lastObj + 1) : cleaned.slice(firstObj);
  }

  const candidate = repairStringLiterals(cleaned)
    .replace(/"\s+"/g, '", "')
    .replace(/,\s*([\]}])/g, '$1');

  try {
    const parsed = JSON.parse(candidate);
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.questions)
      ? parsed.questions
      : null;

    if (arr && arr.length > 0) {
      const validItems = arr
        .filter((item) => item && typeof item.q === 'string' && Array.isArray(item.options))
        .map((item) => {
          const opts = item.options.slice(0, 4).map((o) => String(o ?? '').trim());
          while (opts.length < 4) opts.push('কোনোটিই নয়');
          const ansNum = Number.isInteger(item.ans) && item.ans >= 0 && item.ans <= 3 ? item.ans : 0;
          return {
            q: item.q.trim(),
            options: opts,
            ans: ansNum,
            exp: String(item.exp ?? '').trim()
          };
        })
        .filter((item) => item.q.length > 0);

      if (validItems.length > 0) {
        return JSON.stringify(validItems);
      }
    }
  } catch (_) {}

  const objects = [];
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;

    if (c === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const piece = candidate.slice(objStart, i + 1).replace(/,\s*([\]}])/g, '$1');
        try {
          const obj = JSON.parse(piece);
          if (obj && typeof obj.q === 'string' && Array.isArray(obj.options)) {
            const opts = obj.options.slice(0, 4).map((o) => String(o ?? '').trim());
            while (opts.length < 4) opts.push('কোনোটিই নয়');
            objects.push({
              q: obj.q.trim(),
              options: opts,
              ans: Number.isInteger(obj.ans) && obj.ans >= 0 && obj.ans <= 3 ? obj.ans : 0,
              exp: String(obj.exp ?? '').trim()
            });
          }
        } catch (_) {}
        objStart = -1;
      }
    }
  }

  if (objects.length > 0) {
    return JSON.stringify(objects);
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, chapter, image, history = [], isMcq = false } = req.body || {};
  const apiKey = (process.env.GROQ_API_KEY || '').replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY সেট করা নেই। Vercel Settings-এ যোগ করো।' });
  }

  const mcqMode = detectMcqRequest({ message, chapter, isMcq });

  const systemInstruction = mcqMode
    ? `তুমি বাংলাদেশের নবম-দশম (SSC) শ্রেণির NCTB পাঠ্যবই অনুসারে একজন অভিজ্ঞ পদার্থবিজ্ঞান শিক্ষক (PhysiAI)।
তোমাকে অবশ্যই বৈধ JSON ফরম্যাটে উত্তর দিতে হবে। কোনো Markdown কোড ব্লক (\`\`\`), [H], [S], [E], [L] ট্যাগ বা অতিরিক্ত কোনো লেখা যোগ করবে না।
আউটপুট অবশ্যই নিচের JSON অবজেক্ট ফরম্যাটে হতে হবে:
{"questions":[{"q":"প্রশ্ন","options":["ক অপশন","খ অপশন","গ অপশন","ঘ অপশন"],"ans":0,"exp":"সঠিক ব্যাখ্যা"}]}`
    : `তুমি বাংলাদেশের নবম-দশম (SSC) শ্রেণির NCTB পাঠ্যবই অনুসারে একজন অভিজ্ঞ ও বন্ধুত্বপূর্ণ পদার্থবিজ্ঞান শিক্ষক (PhysiAI)।
তোমার কাজ:
1. সহজ, প্রাঞ্জল ও শুদ্ধ বাংলায় ধাপে ধাপে পদার্থবিজ্ঞানের বিষয় ও গাণিতিক সমস্যা বুঝিয়ে দেওয়া।
2. উত্তর সাজানোর জন্য এই বিশেষ ফরম্যাট ব্যবহার করবে (কোনো Markdown ** বা # ব্যবহার করবে না):
   - মূল শিরোনামের লাইনের শুরুতে [H] লিখবে। (যেমন: [H] প্রদত্ত তথ্য ও সূত্র)
   - উপ-শিরোনামের শুরুতে [S] লিখবে।
   - গাণিতিক সূত্র বা সমীকরণের লাইনের শুরুতে [E] লিখবে। (যেমন: [E] v = u + at)
   - পয়েন্ট বা বুলেট লিস্টের শুরুতে [L] লিখবে।
3. গাণিতিক সমস্যায় অবশ্যই 'দেওয়া আছে', 'আমরা জানি', মান বসানো এবং শেষে সঠিক এককসহ উত্তর লিখবে।`;

  let promptText = message || '';
  if (chapter && !promptText.includes(chapter)) {
    promptText = `[অধ্যায়: ${chapter}]\n${promptText}`;
  }
  if (isMcq && !promptText.trim()) {
    promptText = `${chapter ? chapter + ' অধ্যায়ের' : 'নবম-দশম পদার্থবিজ্ঞানের'} ওপর ২৫টিি গুরুত্বপূর্ণ MCQ প্রশ্ন তৈরি করো (উত্তর ও ব্যাখ্যাসহ)।`;
  }
  if (mcqMode) {
    promptText += `\n\nগুরুত্বপূর্ণ নির্দেশনা: উত্তরটি অবশ্যই {"questions": [...]} আকারের valid JSON object হিসেবে দেবে।`;
  }

  const messages = [{ role: 'system', content: systemInstruction }];
  if (!mcqMode) {
    for (const h of (Array.isArray(history) ? history : []).slice(-6)) {
      messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text });
    }
  }

  if (image) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: promptText || 'ছবির প্রশ্নটি সমাধান করে বুঝিয়ে দাও।' },
        { type: 'image_url', image_url: { url: image } }
      ]
    });
  } else {
    messages.push({ role: 'user', content: promptText });
  }

  const groqModels = image
    ? ['qwen/qwen3.8-27b', 'meta-llama/llama-4-scout-17b-16e-instruct']
    : ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];

  let lastError = '';
  for (const model of groqModels) {
    try {
      const host = ['api', 'groq', 'com'].join('.');
      const payload = {
        model,
        messages,
        temperature: mcqMode ? 0.35 : 0.5,
        max_tokens: 8192
      };
      if (mcqMode && !image) {
        payload.response_format = { type: 'json_object' };
      }

      const result = await postJson(
        host,
        '/openai/v1/chat/completions',
        { Authorization: 'Bearer ' + apiKey },
        payload
      );

      if (!result.ok || result.data.error) {
        lastError = result.data?.error?.message || `HTTP ${result.status}`;
        continue;
      }

      const rawReply = result.data?.choices?.at(0)?.message?.content;
      if (!rawReply) continue;

      if (mcqMode) {
        const cleanJson = sanitizeMcqJson(rawReply);
        if (!cleanJson) {
          lastError = 'মডেল থেকে বৈধ JSON পাওয়া যায়নি';
          continue;
        }
        return res.status(200).json({ reply: cleanJson });
      }

      return res.status(200).json({ reply: rawReply });
    } catch (err) {
      lastError = err.message;
    }
  }

  return res.status(500).json({ error: 'Groq API ত্রুটি: ' + lastError });
}
