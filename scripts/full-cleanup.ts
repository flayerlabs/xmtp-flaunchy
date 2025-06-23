#!/usr/bin/env tsx

import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();

console.log('🔥 FULL CLEANUP - Removing ALL data including XMTP databases...\n');

// Clean up XMTP database files
console.log('1. Removing XMTP database files...');
const dbFiles = fs.readdirSync(rootDir).filter(file => 
  file.startsWith('xmtp-dev-') && (
    file.endsWith('.db3') || 
    file.endsWith('.db3-wal') || 
    file.endsWith('.db3-shm')
  )
);

let removedCount = 0;
for (const file of dbFiles) {
  try {
    fs.unlinkSync(path.join(rootDir, file));
    console.log(`   ✅ Removed: ${file}`);
    removedCount++;
  } catch (error) {
    console.log(`   ⚠️  Could not remove: ${file} (${error instanceof Error ? error.message : 'unknown error'})`);
  }
}

if (removedCount === 0) {
  console.log('   ℹ️  No XMTP database files found to remove');
}

// Clean up state storage directory
console.log('\n2. Cleaning user state storage...');
const dataDir = path.join(rootDir, '.data');
if (fs.existsSync(dataDir)) {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('   ✅ Removed: .data directory');
  } catch (error) {
    console.log(`   ⚠️  Could not remove .data directory: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
} else {
  console.log('   ℹ️  No .data directory found');
}

// Clean up node_modules cache (optional)
console.log('\n3. Clearing node module cache...');
const nodeModulesCache = path.join(rootDir, 'node_modules', '.cache');
if (fs.existsSync(nodeModulesCache)) {
  try {
    fs.rmSync(nodeModulesCache, { recursive: true, force: true });
    console.log('   ✅ Cleared node_modules cache');
  } catch (error) {
    console.log(`   ⚠️  Could not clear cache: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
} else {
  console.log('   ℹ️  No node_modules cache found');
}

console.log('\n🔥 FULL CLEANUP COMPLETE! Everything has been reset.\n'); 