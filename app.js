let imgData = null;
let fs = 1;
const history = [];

function setFs(d) {
  fs = Math.min(1.5, Math.max(0.8, +(fs + d).toFixed(1)));
  document.documentElement.style.setProperty('--fs', fs);
}

function handleImg(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    imgData = e.target.result;
    document.getElementById('pvImg').src = imgData;
    document.getElementById('pv').style.display = 'flex';
  };
  reader.readAsDataURL(file);
}

function clearImg() {
  imgData = null;
  document.getElementById('file').value = '';
  document.getElementById('pv').style.display = 'none';
}

function askSample(q) {
  document.getElementById('inp').value = q;
  sendMsg();
}

function formatReply(text) {
  const lines = text.split('\n');
  let html = '';
  for (let line of lines) {
    const t = line.trim();
    if (!t) { html += '<div class="bk"></div>'; continue; }
    if (t.startsWith('[H]')) html += `<div class="h">${esc(t.slice(3).trim())}</div>`;
    else if (t.startsWith('[S]')) html += `<div class="s">${esc(t.slice(3).trim())}</div>`;
    else if (t.startsWith('[E]')) html += `<div class="e">${esc(t.slice(3).trim())}</div>`;
    else if (t.startsWith('[L]')) html += `<div class="l">${esc(t.slice(3).trim())}</div>`;
    else html += `<div>${esc(t)}</div>`;
  }
  html += `<div class="tools">
    <button onclick="copyText(this)">📋 কপি করো</button>
    <button onclick="window.print()">🖨️ প্রিন্ট / PDF</button>
  </div>`;
  return html;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function copyText(btn) {
  const txt = btn.closest('.msg').innerText.replace('📋 কপি করো','').replace('🖨️ প্রিন্ট / PDF','').trim();
  navigator.clipboard.writeText(txt);
  btn.textContent = '✅ কপি হয়েছে';
  setTimeout(() => btn.textContent = '📋 কপি করো', 1500);
}

async function sendMsg(isMcq = false) {
  const inp = document.getElementById('inp');
  const chap = document.getElementById('chap').value;
  const msg = inp.value.trim();
  if (!msg && !imgData && !isMcq) return;

  document.body.classList.add('chatting');
  const chat = document.getElementById('chat');

  const uDiv = document.createElement('div');
  uDiv.className = 'msg u';
  if (imgData) {
    const im = document.createElement('img');
    im.src = imgData;
    uDiv.appendChild(im);
  }
  const displayMsg = isMcq ? `📝 MCQ টেস্ট (${chap || 'সব অধ্যায়'})` : msg;
  if (displayMsg) uDiv.appendChild(document.createTextNode(displayMsg));
  chat.appendChild(uDiv);

  const curImg = imgData;
  inp.value = '';
  clearImg();

  const aDiv = document.createElement('div');
  aDiv.className = 'msg a';
  aDiv.textContent = 'উত্তর তৈরি হচ্ছে... ⏳';
  chat.appendChild(aDiv);
  chat.scrollTop = chat.scrollHeight;

  const btn = document.getElementById('sendBtn');
  btn.disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, chapter: chap, image: curImg, history, isMcq })
    });
    const data = await res.json();
    if (data.error) {
      aDiv.textContent = '⚠️ ' + data.error;
    } else {
      aDiv.innerHTML = formatReply(data.reply);
      history.push({ role: 'user', text: displayMsg }, { role: 'model', text: data.reply });
    }
  } catch (e) {
    aDiv.textContent = '⚠️ নেটওয়ার্ক সমস্যা হয়েছে। আবার চেষ্টা করো।';
  }
  btn.disabled = false;
  chat.scrollTop = chat.scrollHeight;
}

function startMcq() {
  sendMsg(true);
}

let rec;
function toggleMic() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) return alert('তোমার ব্রাউজারে ভয়েস ইনপুট সাপোর্ট করে না।');
  const micBtn = document.getElementById('micBtn');
  if (rec) { rec.stop(); return; }
  rec = new SpeechRec();
  rec.lang = 'bn-BD';
  rec.onstart = () => micBtn.classList.add('on');
  rec.onend = () => { micBtn.classList.remove('on'); rec = null; };
  rec.onresult = e => {
    document.getElementById('inp').value += e.results[0][0].transcript;
  };
  rec.start();
}
