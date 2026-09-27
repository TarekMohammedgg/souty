// Measure transcription on the TTS eval set with the same single-call request the app sends.
// Usage: node scripts/eval/eval-asr.mjs [configs=S-flash] [runs=1] [--seq] [--show] [--only=g01,g17] [--delay=ms]
//   OpenRouter key: OPENROUTER_API_KEY (settings.json stores it encrypted, so it can't be read from here).
//   Google keys: GOOGLE_API_KEYS=k1,k2 (or GOOGLE_API_KEY) enables G-* configs; rotates keys on 429.
//   Experiments: PROMPT_FILE=path, INSTRUCTION="...", EVAL_TEMPERATURE=1, JSON_SEGMENTS=1 (language-tagged structured output).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const prompts = require('../../src/prompts.js');
const { tidyTranscript } = require('../../src/tidy-transcript.js');
const { wordErrorRate, normalize } = require('./metrics.js');

const TRANSCRIBE_PROMPT = process.env.PROMPT_FILE ? fs.readFileSync(process.env.PROMPT_FILE, 'utf8') : prompts.TRANSCRIBE_PROMPT;
const INSTRUCTION = process.env.INSTRUCTION || prompts.TRANSCRIBE_INSTRUCTION || 'Transcribe this recording.';
const TEMPERATURE = Number(process.env.EVAL_TEMPERATURE || 0); // not TEMP: Windows already uses that for the temp folder
const SEGMENTS_SCHEMA = {
  type: 'object',
  properties: { segments: { type: 'array', items: { type: 'object', properties: {
    language: { type: 'string', enum: ['ar', 'en'] }, text: { type: 'string' } }, required: ['language', 'text'] } } },
  required: ['segments']
};
const jsonSegments = process.env.JSON_SEGMENTS === '1';
const joinSegments = (raw) => {
  if (!jsonSegments) return raw;
  try { return JSON.parse(raw).segments.map(s => s.text.trim()).join(' '); } catch { return raw; }
};

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',');
const delay = Number(process.argv.find(a => a.startsWith('--delay='))?.slice(8) || 0);
const golden = JSON.parse(fs.readFileSync(path.join(here, 'golden.json'), 'utf8')).clips
  .filter(c => !only || only.includes(c.id));
// settings.json stores the key encrypted (apiKeyEnc) since it's read only by the app's own main process, so this
// script needs the key passed directly.
const openrouterKey = process.env.OPENROUTER_API_KEY;
const googleKeys = (process.env.GOOGLE_API_KEYS || process.env.GOOGLE_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Gemini 3.x can't turn thinking off; "minimal" is its lowest level
const isGemini3 = (model) => /gemini-3/.test(model);

// Same request as generate() in main.js (OpenRouter branch)
async function transcribe(model, audio) {
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, temperature: TEMPERATURE,
      ...(isGemini3(model) && { reasoning: { effort: 'minimal' } }),
      ...(jsonSegments && { response_format: { type: 'json_schema', json_schema: { name: 'transcript', strict: true, schema: SEGMENTS_SCHEMA } } }),
      messages: [{ role: 'system', content: TRANSCRIBE_PROMPT }, { role: 'user', content: [
        { type: 'input_audio', input_audio: { data: audio, format: 'wav' } }, { type: 'text', text: INSTRUCTION }] }]
    })
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || res.status);
  const choice = data.choices?.[0] || {};
  if (choice.finish_reason === 'content_filter') throw new Error('cut by safety filter');
  return { text: joinSegments((choice.message?.content || '').trim()), ms: Date.now() - t0 };
}

// Free Google keys allow a few requests a minute: rotate on 429, wait when all are limited
let keyIndex = 0;
async function googleFetch(url, body) {
  for (let attempt = 0; attempt < googleKeys.length * 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': googleKeys[keyIndex] },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (res.status !== 429) {
      if (!res.ok || data.error) throw new Error(data.error?.message || res.status);
      return data;
    }
    keyIndex = (keyIndex + 1) % googleKeys.length;
    if (keyIndex === 0) await wait(15000);
  }
  throw new Error('all Google keys rate-limited');
}

// Same request as generate() in main.js (Google branch)
async function transcribeGoogle(model, audio) {
  const t0 = Date.now();
  const data = await googleFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    systemInstruction: { parts: [{ text: TRANSCRIBE_PROMPT }] },
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'audio/wav', data: audio } }, { text: INSTRUCTION }] }],
    generationConfig: {
      temperature: TEMPERATURE,
      thinkingConfig: isGemini3(model) ? { thinkingLevel: 'minimal' } : { thinkingBudget: 0 },
      ...(jsonSegments && { responseMimeType: 'application/json', responseSchema: SEGMENTS_SCHEMA })
    },
    safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
      .map(category => ({ category, threshold: 'BLOCK_NONE' }))
  });
  const candidate = data.candidates?.[0];
  if (!candidate || candidate.finishReason === 'SAFETY') throw new Error('blocked by Google');
  return { text: joinSegments((candidate.content?.parts || []).map(p => p.text || '').join('').trim()), ms: Date.now() - t0 };
}

// Dedicated speech-to-text model: no prompt, only a transcription config
async function transcribeDedicated(audio) {
  const t0 = Date.now();
  const data = await googleFetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    model: 'gemini-3.5-transcribe',
    input: [{ type: 'audio', data: audio, mime_type: 'audio/wav' }],
    generation_config: { transcription_config: { language_codes: ['ar-EG', 'en-US'], mode: 'smart' } } // verbatim writes English words in Arabic letters
  });
  const text = data.output_text ?? (data.steps || []).flatMap(s => s.content || []).map(c => c.text || '').join('');
  return { text: text.trim(), ms: Date.now() - t0 };
}

// OpenRouter speech-to-text endpoint (Microsoft MAI-Transcribe). STT_PROMPT / STT_LANGUAGE try optional hints.
async function transcribeStt(model, audio) {
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, input_audio: { data: audio, format: 'wav' },
      ...(process.env.STT_PROMPT && { prompt: process.env.STT_PROMPT }),
      ...(process.env.STT_LANGUAGE && { language: process.env.STT_LANGUAGE })
    })
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || res.status);
  const text = (data.text || '').trim();
  return { text: process.env.RAW ? text : tidyTranscript(text), ms: Date.now() - t0 };
}

const CONFIGS = {
  'S-mai2': (audio) => transcribeStt('microsoft/mai-transcribe-2', audio),
  'S-mai15': (audio) => transcribeStt('microsoft/mai-transcribe-1.5', audio),
  'S-flash': (audio) => transcribe('google/gemini-2.5-flash', audio),
  'S-lite35': (audio) => transcribe('google/gemini-3.5-flash-lite', audio),
  'S-lite31': (audio) => transcribe('google/gemini-3.1-flash-lite', audio),
  ...(googleKeys.length ? {
    'G-flash': (audio) => transcribeGoogle('gemini-2.5-flash', audio),
    'G-lite35': (audio) => transcribeGoogle('gemini-3.5-flash-lite', audio),
    'G-lite31': (audio) => transcribeGoogle('gemini-3.1-flash-lite', audio),
    'G-transcribe': (audio) => transcribeDedicated(audio)
  } : {})
};

const latinWords = (text) => normalize(text).split(' ').filter(w => /^[a-z0-9]+$/.test(w));
const sentenceCount = (t) => t.split(/[.?!؟\n]+/).filter(s => normalize(s)).length;
// "back-end", "back end" and "backend" are all correct spellings of the term
const squash = (s) => normalize(s).replace(/ /g, '');
const termHit = (text, term) => squash(text).includes(squash(term));

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const names = (args[0] || 'S-flash').split(',');
const runs = Number(args[1] || 1);
const sequential = process.argv.includes('--seq') || delay > 0;
const show = process.argv.includes('--show');
const results = {};

for (const name of names) {
  if (!CONFIGS[name]) { console.log(`${name}: unknown config (G-* needs GOOGLE_API_KEYS)`); continue; }
  const runClip = async (clip) => {
    const audio = fs.readFileSync(path.join(here, 'clips', `${clip.id}.wav`)).toString('base64');
    try { return { clip, out: await CONFIGS[name](audio) }; }
    catch (err) { return { clip, out: { text: '', ms: 0, error: err.message } }; }
    finally { if (delay) await wait(delay); }
  };
  const rows = [];
  for (let run = 0; run < runs; run++) {
    if (sequential) for (const clip of golden) rows.push(await runClip(clip));
    else rows.push(...await Promise.all(golden.map(runClip)));
  }

  const scored = rows.map(({ clip, out }) => {
    const refWords = new Set(latinWords(clip.ref));
    return {
      id: clip.id, out,
      wer: wordErrorRate(clip.ref, out.text),
      termsHit: clip.terms.filter(t => termHit(out.text, t)).length, terms: clip.terms.length,
      // English words the speaker never said (e.g. "backend" instead of "Image")
      invented: latinWords(out.text).filter(w => !refWords.has(w)),
      overSplit: Math.max(0, sentenceCount(out.text) - (clip.sentences || 1))
    };
  });
  const ok = scored.filter(s => !s.out.error);
  const errors = scored.length - ok.length;
  const lat = ok.map(s => s.out.ms).sort((a, b) => a - b);
  const sum = (f) => ok.reduce((s, r) => s + f(r), 0);
  const summary = {
    wer: sum(r => r.wer) / (ok.length || 1),
    terms: sum(r => r.termsHit) / (sum(r => r.terms) || 1),
    invented: sum(r => r.invented.length),
    overSplit: sum(r => r.overSplit),
    perfect: ok.filter(r => r.wer === 0).length,
    p50: lat[Math.floor(lat.length / 2)] || 0,
    p90: lat[Math.floor(lat.length * 0.9)] || 0,
    errors, n: scored.length
  };
  results[name] = { summary, scored };

  const pct = (x) => (x * 100).toFixed(1).padStart(5) + '%';
  console.log(`${name.padEnd(12)} WER ${pct(summary.wer)} | terms ${pct(summary.terms)} | invented ${String(summary.invented).padStart(2)} | perfect ${String(summary.perfect).padStart(2)}/${ok.length} | split-errors ${String(summary.overSplit).padStart(2)} | p50 ${String(summary.p50).padStart(5)}ms p90 ${String(summary.p90).padStart(5)}ms${errors ? ` | ERRORS ${errors}: ${scored.find(s => s.out.error).out.error}` : ''}`);
  if (show) {
    for (const s of scored) {
      const extra = s.invented.length ? ` [invented: ${s.invented.join(', ')}]` : '';
      console.log(`   ${s.id} wer=${String(Math.round(s.wer * 100)).padStart(3)}%${extra} ${s.out.error || s.out.text.replace(/\n/g, ' ⏎ ')}`);
    }
  }
}

fs.mkdirSync(path.join(here, 'results'), { recursive: true });
const file = path.join(here, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`\nsaved ${path.relative(process.cwd(), file)}`);
