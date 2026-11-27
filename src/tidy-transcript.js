/**
 * Souty - plain-code cleanup of a transcript (no model involved, so it can't invent words).
 * Speech-to-text models such as MAI-Transcribe glue an Arabic prefix onto the English word after it
 * ("الdashboard", "للcontainer"); this writes it the way the Gemini prompt does ("الـ dashboard").
 * It also drops hesitation sounds the models keep ("ااا", "امم", "uh") and a stuttered "الـ الـ".
 */

// Word-initial Arabic prefix (ال، بال، وال، لل، ب، و…) glued to a Latin letter, with or without a tatweel
const GLUED_PREFIX = /(^|[\s"'(«])((?:[وفبك]{0,2}ال|[وف]?لل|[وفبكل])ـ?)(?=[A-Za-z])/g;

// A whole word that is only a hesitation sound: ااا / آآ / امم / ممم / uh / um / hmm / erm (plus a comma after it).
// "اه" / "آه" (yes) and "ام" (mother / or) are real words, so 2+ alefs or 2+ meems are required.
const FILLER = /(^|\s)(?:[اأإآ]{2,}|[اأإ]?م{2,}|u+h+m*|u+m+|h+m{2,}|er+m?)[،,]?(?=\s|[.!?؟،,]|$)/giu;

// The same bare prefix said two or more times in a row: "الـ الـ الـ desktop" → "الـ desktop"
const REPEATED_PREFIX = /(^|\s)(الـ|للـ|بالـ|والـ)(?:\s+\2)+(?=\s|$)/g;

function tidyTranscript(text) {
  return text
    .replace(GLUED_PREFIX, (_, before, prefix) => {
      const bare = prefix.replace('ـ', '');
      // و doesn't join the next letter, so a tatweel after it would look broken
      return before + (bare === 'و' ? 'و ' : `${bare}ـ `);
    })
    .replace(FILLER, '$1')
    .replace(REPEATED_PREFIX, '$1$2')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.!?؟،,])/g, '$1')
    .replace(/^[\s،,]+/gm, '')
    .trim();
}

module.exports = { tidyTranscript };
