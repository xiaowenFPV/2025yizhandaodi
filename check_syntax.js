
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g);
if (scripts) {
  scripts.forEach((s, i) => {
    const code = s.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
    try {
      new Function(code);
      console.log('Script', i + 1, 'OK,', code.length, 'chars');
    } catch (e) {
      console.log('Script', i + 1, 'ERROR:', e.message.substring(0, 200));
    }
  });
}
