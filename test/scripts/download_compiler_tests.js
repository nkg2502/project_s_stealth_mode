const fs = require('fs');
const path = require('path');
const https = require('https');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'compiler_tests');

const CONFIG = {
    clang: {
        repo: 'llvm/llvm-project',
        branch: 'main',
        path: 'clang/test/Parser',
        limit: 1024
    },
    gcc: {
        repo: 'gcc-mirror/gcc',
        branch: 'master',
        path: 'gcc/testsuite/gcc.c-torture/compile',
        limit: 1024
    }
};

async function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Node.js' } }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to fetch ${url}, status: ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
    });
}

async function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const req = https.get(url, { headers: { 'User-Agent': 'Node.js' } }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to download ${url}, status: ${res.statusCode}`));
            }
            res.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        });
        req.on('error', err => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

async function fetchFromRepo(name, config) {
    console.log(`Fetching file list for ${name}...`);
    const apiUrl = `https://api.github.com/repos/${config.repo}/contents/${config.path}?ref=${config.branch}`;
    
    let files = [];
    try {
        const data = await fetchJson(apiUrl);
        if (!Array.isArray(data)) {
            throw new Error(`Expected array from GitHub API, got ${typeof data}`);
        }
        
        // Filter for C/C++ files
        files = data.filter(item => 
            item.type === 'file' && 
            (item.name.endsWith('.c') || item.name.endsWith('.cpp'))
        );
        
        console.log(`Found ${files.length} test files in ${name}.`);
        
        // Shuffle and limit
        files = files.sort(() => 0.5 - Math.random()).slice(0, config.limit);
        console.log(`Selected ${files.length} files from ${name} to download.`);
        
        const targetDir = path.join(FIXTURES_DIR, name);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        
        let count = 0;
        for (const file of files) {
            const destPath = path.join(targetDir, file.name);
            if (!fs.existsSync(destPath)) {
                try {
                    await downloadFile(file.download_url, destPath);
                    count++;
                    if (count % 10 === 0) {
                        console.log(`Downloaded ${count}/${files.length} files for ${name}...`);
                    }
                } catch (err) {
                    console.error(`Failed to download ${file.name}: ${err.message}`);
                }
            }
        }
        console.log(`Completed ${name}: downloaded ${count} new files.\n`);
    } catch (err) {
        console.error(`Failed to process ${name}:`, err);
    }
}

async function main() {
    if (!fs.existsSync(FIXTURES_DIR)) {
        fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    }
    
    await fetchFromRepo('clang', CONFIG.clang);
    await fetchFromRepo('gcc', CONFIG.gcc);
    
    console.log('All downloads completed successfully.');
}

main().catch(console.error);
