/**
 * Souty - plain-code cleanup of a transcript (no model involved, so it can't invent words).
 * Speech-to-text models such as MAI-Transcribe glue an Arabic prefix onto the English word after it
 * ("الdashboard", "للcontainer"); this writes it the way the Gemini prompt does ("الـ dashboard").
 */

// Word-initial Arabic prefix (ال، بال، وال، لل، ب، و…) glued to a Latin letter, with or without a tatweel
const GLUED_PREFIX = /(^|[\s"'(«])((?:[وفبك]{0,2}ال|[وف]?لل|[وفبكل])ـ?)(?=[A-Za-z])/g;

function tidyTranscript(text) {
  return text.replace(GLUED_PREFIX, (_, before, prefix) => {
    const bare = prefix.replace('ـ', '');
    // و doesn't join the next letter, so a tatweel after it would look broken
    return before + (bare === 'و' ? 'و ' : `${bare}ـ `);
  });
}

module.exports = { tidyTranscript };
