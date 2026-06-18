
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const scriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
const code = scriptMatch[1];

// Binary search for error position
function tryEval(str) {
  try { new Function(str); return true; } catch(e) { return false; }
}

let lo = 0, hi = code.length;
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  if (tryEval(code.substring(0, mid))) {
    lo = mid + 1;
  } else {
    hi = mid;
  }
}
console.log('Error near position:', lo);
console.log('Before:', JSON.stringify(code.substring(Math.max(0, lo - 80), lo)));
console.log('After:', JSON.stringify(code.substring(lo, lo + 80)));
