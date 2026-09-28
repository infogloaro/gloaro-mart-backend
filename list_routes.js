const fs = require('fs');
const path = require('path');
const appJsPath = './src/app.js';
const routesDir = './src/routes/';

const appContent = fs.readFileSync(appJsPath, 'utf8');
const prefixes = [];
const regex = /app\.use\(['"](\/api\/[^'"]+)['"],\s*require\(['"]\.\/routes\/([^'"]+)['"]\)/g;
let match;
while ((match = regex.exec(appContent)) !== null) {
  prefixes.push({ prefix: match[1], file: match[2] + (match[2].endsWith('.js') ? '' : '.js') });
}

console.log('# Gloaro Mart API Endpoints\n');
for (const p of prefixes) {
  console.log(`## ${p.prefix}`);
  const routeContent = fs.readFileSync(path.join(routesDir, p.file), 'utf8');
  const routeRegex = /router\.(get|post|put|patch|delete)\(['"]([^'"]+)['"]/g;
  let rMatch;
  while ((rMatch = routeRegex.exec(routeContent)) !== null) {
    let method = rMatch[1].toUpperCase();
    let pathName = rMatch[2];
    if (pathName === '/') pathName = '';
    console.log(`- **${method}** ${p.prefix}${pathName}`);
  }
  console.log();
}
