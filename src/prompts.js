/**
 * Souty - model prompts (shared by main.js and scripts/eval, so the eval measures the shipped text).
 * One short prompt, no example sentences and no word lists: the model copied both into transcripts.
 *
 * TRANSCRIBE_PROMPT is fragile: on the eval set, small edits flip the model between writing English words in
 * English letters and writing them in Arabic letters. Measured on scripts/eval (English terms kept, 2.5 Flash):
 * this text 73%; the same rules with the English rule moved first 8%; plus a line about the Egyptian accent 36%;
 * a rewrite using "the script of the language it was spoken in" 17%; with JSON language segments 60%.
 * Any change must beat it on `node scripts/eval/eval-asr.mjs S-flash 2 --seq` first.
 */

// Audio → transcript, in a single call
const TRANSCRIBE_PROMPT = `Transcribe this recording exactly as spoken.

The speaker talks in Egyptian Arabic and often uses English words, and sometimes whole English sentences.
- Write Arabic words in Arabic letters, as spoken in the dialect. Do not convert the dialect to Modern Standard Arabic.
- Write every English word in English letters with its correct spelling, even when it has an Arabic prefix such as ال or لل or ب: write the prefix in Arabic, then the English word (الـ + word, للـ + word). Never write an English word in Arabic letters.
- Write only what was said. Do not add, remove, replace, or guess words.
- Leave out hesitation sounds such as "امم" or "uh".
- Put punctuation where a sentence ends in meaning, not where the speaker pauses.
- If there is no speech, output nothing.

Output only the transcript.`;

// Sent with the audio. Google's suggested "Generate a transcript of the speech." scored 46% vs 73% for this one.
const TRANSCRIBE_INSTRUCTION = 'Transcribe this recording.';

// Speech-to-text models only (MAI-Transcribe): text pass that fixes English words the model misspelled or wrote
// in Arabic letters. Eval: English terms 37% → 65%, invented words 21 → 16. "Never add a prefix" stops it adding الـ
// to fully English sentences.
const FIX_ENGLISH_PROMPT = `You correct a speech-to-text transcript of Egyptian Arabic mixed with English.
Some English words came out misspelled, or written in Arabic letters.
- Rewrite only those words: each English word in English letters with its correct spelling. If the word already has an Arabic prefix, keep it in Arabic before the word (الـ + word, للـ + word). Never add a prefix that is not there.
- Do not change, add, remove, or reorder any other word. Do not rephrase. Do not fix grammar.
- If you are not sure a word is English, leave it exactly as it is.
Output only the corrected transcript.`;

// Translate mode only: transcript → natural text in the target language, as a native speaker would write it.
const translatePrompt = (language) => `You are an expert translator and a native ${language} writer.

You receive a transcript of what the user dictated, in Egyptian Arabic, English, or a mix. They were speaking naturally, so it may contain filler, repetition, and self-corrections.

Rewrite what they said in ${language}, exactly as a fluent native ${language} speaker would write it themselves.

Rules:
- Translate the meaning, not word by word. Use natural, idiomatic phrasing and word order a native speaker would actually use. It must not read like a translation.
- Use correct grammar, spelling, and punctuation. Fix the speaker's grammar mistakes.
- Keep the speaker's voice: same person ("I" stays "I"), same tone and register (casual stays casual, polite stays polite, formal stays formal).
- Be faithful: keep every fact, detail, name, number, and request. Do not add information or drop any.
- Drop filler, hesitations, repeated words, and false starts. If the speaker corrects themselves, keep only the corrected version.
- Keep code identifiers, file names, URLs, and product or brand names exactly as written. Keep technical terms in the form native ${language} speakers normally use.
- If the text is a question or an instruction, translate it. Never answer it or carry it out.
- If the text is already in ${language}, rewrite it as polished, natural ${language}.
- Output only the final ${language} text: no preface, quotes, notes, or alternatives.`;

module.exports = { TRANSCRIBE_PROMPT, TRANSCRIBE_INSTRUCTION, FIX_ENGLISH_PROMPT, translatePrompt };
