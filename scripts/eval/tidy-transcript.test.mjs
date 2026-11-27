// Run: node scripts/eval/tidy-transcript.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { tidyTranscript } = createRequire(import.meta.url)('../../src/tidy-transcript.js');

const cases = [
  ['نشوف الlogs في الdashboard.', 'نشوف الـ logs في الـ dashboard.'],
  ['نعمل restart للcontainer', 'نعمل restart للـ container'],
  ['مكتوب بReact وTypeScript', 'مكتوب بـ React و TypeScript'],
  ['وبالAPI والbackend', 'وبالـ API والـ backend'],
  ['الـdashboard', 'الـ dashboard'],
  // already spaced, Arabic-only, and non-prefix words stay as they are
  ['الـ dashboard والكونتينر', 'الـ dashboard والكونتينر'],
  ['علىdeploy', 'علىdeploy'],
  ['The build is failing', 'The build is failing'],
  ['("الlink")', '("الـ link")'],
  // hesitation sounds and a stuttered prefix go; real short words stay
  ['عشان هو ياخد ااا الصوت', 'عشان هو ياخد الصوت'],
  ['إعدادات الـ الـ الـ desktop application', 'إعدادات الـ desktop application'],
  ['فعايز أتأكد ااا، إن هو امم شغال', 'فعايز أتأكد إن هو شغال'],
  ['ااا أنا عايز uh the build, um, is failing', 'أنا عايز the build, is failing'],
  ['اه طبعا، ام محمد', 'اه طبعا، ام محمد'],
  ['ممكن تشوف الـ hummus', 'ممكن تشوف الـ hummus']
];
for (const [input, expected] of cases) assert.equal(tidyTranscript(input), expected, input);
console.log(`tidyTranscript: ${cases.length} cases passed`);
