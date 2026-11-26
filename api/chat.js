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

  const startIdx = cleaned.indexOf('[');
  const endIdx = cleaned.lastIndexOf(']');
  if (startIdx !== -1) {
    cleaned = endIdx > startIdx ? cleaned.slice(startIdx, endIdx + 1) : cleaned.slice(startIdx);
  }

  let candidate = repairStringLiterals(cleaned)
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

  // Fallback: extract complete {...} objects if truncated
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

  return candidate;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, chapter, image, history = [], isMcq = false } = req.body || {};
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY সেট করা নেই।' });
  }

  const mcqMode = detectMcqRequest({ message, chapter, isMcq });

  const systemInstruction = `তুমি বাংলাদেশের নবম-দশম (SSC) শ্রেণির NCTB পাঠ্যবই অনুসারে একজন অভিজ্ঞ ও বন্ধুত্বপূর্ণ পদার্থবিজ্ঞান শিক্ষক (PhysiAI)।
তোমার কাজ:
1. সহজ, প্রাঞ্জল ও শুদ্ধ বাংলায় ধাপে ধাপে পদার্থবিজ্ঞানের বিষয় ও গাণিতিক সমস্যা বুঝিয়ে দেওয়া।
2. উত্তর সাজানোর জন্য এই বিশেষ ফরম্যাট ব্যবহার করবে (কোনো Markdown ** বা # ব্যবহার করবে না):
   - মূল শিরোনামের লাইনের শুরুতে [H] লিখবে। (যেমন: [H] প্রদত্ত তথ্য ও সূত্র)
   - উপ-শিরোনামের শুরুতে [S] লিখবে।
   - গাণিতিক সূত্র বা সমীকরণের লাইনের শুরুতে [E] লিখবে। (যেমন: [E] v = u + at)
   - পয়েন্ট বা বুলেট লিস্টের শুরুতে [L] লিখবে।
3. গাণিতিক সমস্যায় অবশ্যই 'দেওয়া আছে', 'আমরা জানি', মান বসানো এবং শেষে সঠিক এককসহ উত্তর লিখবে।
4. যদি ব্যবহারকারী MCQ টেস্ট চায়, তবে নির্বাচিত অধ্যায় (বা পুরো বই) থেকে ২৫টি মানসম্মত বোর্ড স্ট্যান্ডার্ড MCQ প্রশ্ন (ক, খ, গ, ঘ অপশনসহ) দেবে এবং সঠিক উত্তর ও সংক্ষিপ্ত ব্যাখ্যা দেবে।`;

  const contents = (Array.isArray(history) ? history : []).map((h) => ({
    role: h.role === 'user' ? 'user' : 'model',
    parts: [{ text: h.text }]
  }));

  const userParts = [];
  if (image && typeof image === 'string' && image.includes(',')) {
    const base64Data = image.split(',')[1];
    const mimeType = image.split(';')[0].split(':')[1];
    if (base64Data && mimeType) {
      userParts.push({ inlineData: { mimeType, data: base64Data } });
    }
  }

  let promptText = message || '';
  if (chapter && !promptText.includes(chapter)) {
    promptText = `[অধ্যায়: ${chapter}]\n${promptText}`;
  }
  if (isMcq && !promptText.trim()) {
    promptText = `${chapter ? chapter + ' অধ্যায়ের' : 'নবম-দশম পদার্থবিজ্ঞানের'} ওপর ২৫টি গুরুত্বপূর্ণ MCQ প্রশ্ন তৈরি করো (উত্তর ও ব্যাখ্যাসহ)।`;
  }

  userParts.push({ text: promptText });
  contents.push({ role: 'user', parts: userParts });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents,
          generationConfig: {
            temperature: mcqMode ? 0.35 : 0.7,
            maxOutputTokens: mcqMode ? 8192 : 4096,
            ...(mcqMode ? { responseMimeType: 'application/json' } : {})
          }
        })
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || 'Gemini API থেকে উত্তর আনতে সমস্যা হয়েছে।'
      });
    }

    const rawReply =
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p?.text || '')
        .join('')
        .trim() || '';

    if (!rawReply) {
      return res.status(200).json({ reply: 'দুঃখিত, উত্তর তৈরি করা যায়নি। আবার চেষ্টা করো।' });
    }

    const reply = mcqMode ? sanitizeMcqJson(rawReply) : rawReply;
    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: 'সার্ভার ত্রুটি: ' + err.message });
  }
}
