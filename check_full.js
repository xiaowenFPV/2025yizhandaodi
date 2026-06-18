
const { execSync } = require('child_process');
try {
  execSync('node --check main_script.js', { encoding: 'utf8', stdio: 'pipe' });
  console.log('OK');
} catch (e) {
  console.log('STDERR:', e.stderr);
  console.log('STDOUT:', e.stdout);
}
