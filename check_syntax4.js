
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const scriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
const code = scriptMatch[1];

// Find ALL_QUESTIONS array
const idx = code.indexOf('ALL_QUESTIONS = [');
const j = code.indexOf('[', idx);
let depth = 0, k = j;
for (; k < code.length; k++) {
  if (code[k] === '[') depth++;
  if (code[k] === ']') depth--;
  if (depth === 0) break;
}
const arrStr = code.substring(j, k + 1);

try {
  eval('var x = ' + arrStr);
  console.log('OK, entries:', x.length);
} catch(e) {
  console.log('Array ERROR:', e.message.substring(0, 200));
  const m = e.message.match(/position (\d+)/);
  if (m) {
    const pos = parseInt(m[1]);
    console.log('Near:', JSON.stringify(arrStr.substring(Math.max(0,pos-40), pos+40)));
  }
}

// Now try after ALL_QUESTIONS
const afterArr = code.substring(k + 1, k + 300);
console.log('\nAfter array:', JSON.stringify(afterArr.substring(0,200)));
