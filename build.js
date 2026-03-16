#!/usr/bin/env node
// Build script: inlines app.css + compiles app.jsx → single-file index.html (production)
// Usage: node build.js
// Requires: npm install @babel/core @babel/preset-react (in build_deps/)

const fs = require('fs');
const path = require('path');

const DEV_FILE = 'index-dev.html';
const CSS_FILE = 'app.css';
const JSX_FILE = 'app.tsx';
const OUT_FILE = 'index.html';

// Resolve from project root
process.chdir(__dirname);

for (const f of [DEV_FILE, CSS_FILE, JSX_FILE]) {
    if (!fs.existsSync(f)) {
        console.error(`Error: ${f} not found.`);
        process.exit(1);
    }
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

// Read sources
const html = fs.readFileSync(DEV_FILE, 'utf8');
const css = fs.readFileSync(CSS_FILE, 'utf8');
const jsxSource = fs.readFileSync(JSX_FILE, 'utf8');

console.log(`Compiling ${jsxSource.length.toLocaleString()} chars of JSX...`);

// Compile JSX → plain JS
const result = babelCore.transformSync(jsxSource, {
    presets: [presetReact],
    filename: JSX_FILE,
    sourceType: 'script',
});

// Build output: inline CSS and compiled JS into HTML
let out = html;

// Replace <link rel="stylesheet" href="app.css"> with inline <style>
out = out.replace(
    /\s*<link rel="stylesheet" href="app\.css">/,
    '\n    <style>\n' + css.split('\n').map(l => '        ' + l).join('\n') + '\n    </style>'
);

// Replace <script type="text/babel" src="app.jsx"></script> with inline compiled <script>
out = out.replace(
    /<script type="text\/babel" src="app\.tsx"><\/script>/,
    '<script>\n' + result.code + '\n    </script>'
);

// Remove Babel standalone CDN script (not needed in production)
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

const srcSize = fs.statSync(CSS_FILE).size + fs.statSync(JSX_FILE).size + fs.statSync(DEV_FILE).size;
const outSize = fs.statSync(OUT_FILE).size;
console.log(`  Sources: ${DEV_FILE} + ${CSS_FILE} + ${JSX_FILE} (${srcSize.toLocaleString()} bytes)`);
console.log(`→ ${OUT_FILE} (${outSize.toLocaleString()} bytes)`);
console.log(`  CSS inlined, JSX compiled, Babel removed, React production builds`);
