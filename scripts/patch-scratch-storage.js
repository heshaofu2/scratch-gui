#!/usr/bin/env node
/**
 * 修补 scratch-storage 以禁用 FetchWorkerTool
 * 在 iframe sandbox 环境中，FetchWorkerTool 的 Web Worker 无法正常工作
 */

const fs = require('fs');
const path = require('path');

const STORAGE_FILE = path.join(__dirname, '../node_modules/scratch-storage/dist/web/scratch-storage.js');

if (!fs.existsSync(STORAGE_FILE)) {
    console.log('[patch] scratch-storage not found, skipping patch');
    process.exit(0);
}

let content = fs.readFileSync(STORAGE_FILE, 'utf8');

// 检查是否已经修补过
if (content.includes('FetchWorkerTool disabled')) {
    console.log('[patch] scratch-storage already patched, skipping');
    process.exit(0);
}

// 查找并替换 ProxyTool 构造函数中的代码
const oldCode = /let tools;\s*if \(filter === ProxyTool\.TOOL_FILTER\.READY\) \{\s*tools = \[new FetchTool\(\)\];\s*\} else \{\s*tools = \[new PublicFetchWorkerTool\(\), new FetchTool\(\)\];\s*\}/;
const newCode = `let tools; // FetchWorkerTool disabled for private deployment
    tools = [new FetchTool()];`;

if (oldCode.test(content)) {
    content = content.replace(oldCode, newCode);
    fs.writeFileSync(STORAGE_FILE, content);
    console.log('[patch] scratch-storage patched successfully!');
} else {
    console.log('[patch] Pattern not found, scratch-storage may have been updated');
    console.log('[patch] Please check and update the patch script if needed');
}
