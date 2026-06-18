
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const scriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
const code = scriptMatch[1];
fs.writeFileSync('main_script.js', code, 'utf8');
console.log('Written', code.length, 'chars to main_script.js');
