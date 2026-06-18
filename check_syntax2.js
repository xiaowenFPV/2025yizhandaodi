
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const scriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
if (scriptMatch) {
  const code = scriptMatch[1];
  try {
    new Function(code);
    console.log('OK');
  } catch (e) {
    const msg = e.message;
    console.log('ERROR:', msg.substring(0, 300));
    // Try to find error position
    const lineMatch = msg.match(/at position (\d+)/);
    if (lineMatch) {
      const pos = parseInt(lineMatch[1]);
      console.log('Near:', JSON.stringify(code.substring(Math.max(0, pos - 40), pos + 40)));
    }
  }
}
