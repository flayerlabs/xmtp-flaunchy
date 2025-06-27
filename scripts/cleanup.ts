#!/usr/bin/env tsx

import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();

console.log('🧹 Cleaning up user state for fresh onboarding test...\n');

// Clean up state storage directory
console.log('1. Cleaning user state storage...');
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
console.log('\n2. Clearing node module cache...');
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

console.log('\n✨ User state cleared! Ready for fresh onboarding test...\n'); 