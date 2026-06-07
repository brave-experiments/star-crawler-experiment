const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, 'Consent-O-Matic');
const gdpr = path.join(repo, 'Extension', 'GDPRConfig.js');

function patch(value) {
    const text = fs.readFileSync(gdpr, 'utf-8');
    const patched = text.replace(
        /GDPRConfig\.defaultValues\s*=\s*\{[^}]*\}/s,
        `GDPRConfig.defaultValues = {\n    "A": ${value},\n    "B": ${value},\n` +
        `    "D": ${value},\n    "E": ${value},\n    "F": ${value},\n    "X": ${value}\n}`
    );
    if (patched === text) throw new Error('defaultValues pattern did not match');
    fs.writeFileSync(gdpr, patched, 'utf-8');
}

for (const [consent, value] of [['accept', 'true'], ['reject', 'false']]) {
    patch(value);
    execSync('npm run build-chromium', { cwd: repo, stdio: 'inherit' });
    const out = path.join(__dirname, `consent-${consent}`);
    fs.rmSync(out, { recursive: true, force: true });
    fs.cpSync(path.join(repo, 'build'), out, { recursive: true });
    console.log(`Built consent-${consent}`);
}