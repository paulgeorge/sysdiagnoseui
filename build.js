#!/usr/bin/env node
// Build script: compiles JSX in index-dev.html → index.html (production)
// Usage: node build.js
// Requires: npm install @babel/core @babel/preset-react (in build_deps/)

const fs = require('fs');
const path = require('path');

const DEV_FILE = 'index-dev.html';
const OUT_FILE = 'index.html';

// Resolve from project root
process.chdir(__dirname);

if (!fs.existsSync(DEV_FILE)) {
    console.error(`Error: ${DEV_FILE} not found. Edit ${DEV_FILE} (not ${OUT_FILE}) for development.`);
    process.exit(1);
}

// Find Babel — check build_deps/ first, then node_modules/
let babelCore, presetReact;
const locations = ['build_deps/node_modules', 'node_modules'];
for (const loc of locations) {
    try {
        babelCore = require(path.resolve(loc, '@babel/core'));
        presetReact = path.resolve(loc, '@babel/preset-react');
        break;
    } catch (e) { /* try next */ }
}

if (!babelCore) {
    console.error('Babel not found. Run:');
    console.error('  mkdir build_deps && cd build_deps && npm init -y && npm install @babel/core @babel/preset-react');
    process.exit(1);
}

const html = fs.readFileSync(DEV_FILE, 'utf8');

// Find <script type="text/babel"> block
const openTag = '<script type="text/babel">';
const babelStart = html.indexOf(openTag);
if (babelStart === -1) {
    console.error(`No ${openTag} found in ${DEV_FILE}`);
    process.exit(1);
}
const babelEnd = html.indexOf('</script>', babelStart) + '</script>'.length;

const jsxSource = html.substring(babelStart + openTag.length, babelEnd - '</script>'.length);
console.log(`Compiling ${jsxSource.length} chars of JSX...`);

const result = babelCore.transformSync(jsxSource, {
    presets: [presetReact],
    filename: 'app.jsx',
    sourceType: 'script',
});

// Reassemble with compiled JS
let out = html.substring(0, babelStart)
    + '<script>\n' + result.code + '\n    </script>'
    + html.substring(babelEnd);

// Remove Babel standalone CDN script
out = out.replace(
    /\s*<script src="https:\/\/unpkg\.com\/@babel\/standalone\/babel\.min\.js"><\/script>\n?/,
    '\n'
);

// React dev → production builds
out = out.replace('react@18/umd/react.development.js', 'react@18/umd/react.production.min.js');
out = out.replace('react-dom@18/umd/react-dom.development.js', 'react-dom@18/umd/react-dom.production.min.js');

// Add preconnect hints if not already present
if (!out.includes('rel="preconnect"')) {
    const hints = [
        '    <link rel="preconnect" href="https://unpkg.com" crossorigin>',
        '    <link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin>',
        '    <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>',
    ].join('\n') + '\n';
    out = out.replace(
        '    <script crossorigin src="https://unpkg.com/react@18',
        hints + '    <script crossorigin src="https://unpkg.com/react@18'
    );
}

fs.writeFileSync(OUT_FILE, out, 'utf8');

const devSize = fs.statSync(DEV_FILE).size;
const outSize = fs.statSync(OUT_FILE).size;
console.log(`  ${DEV_FILE} (${devSize.toLocaleString()} bytes)`);
console.log(`→ ${OUT_FILE} (${outSize.toLocaleString()} bytes)`);
console.log(`  Babel removed, JSX compiled, React production builds`);
