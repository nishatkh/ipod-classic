import fs from 'fs';
console.log("Dist files:", fs.readdirSync('./dist'));
console.log("Manifest:", fs.existsSync('./dist/manifest.json'));
console.log("Icon:", fs.existsSync('./dist/icon.svg'));
console.log("SW:", fs.existsSync('./dist/sw.js'));