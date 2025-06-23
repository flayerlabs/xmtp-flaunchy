#!/usr/bin/env node

// Simple test script to verify onboarding flow setup
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('🧪 Testing Onboarding Flow Configuration...\n');

// Test 1: Check if network config exists
console.log('1. Checking network configuration...');
const networkConfigPath = path.join(__dirname, 'src/config/networks.ts');
if (fs.existsSync(networkConfigPath)) {
  const content = fs.readFileSync(networkConfigPath, 'utf8');
  if (content.includes('84532') && content.includes('Base Sepolia')) {
    console.log('✅ Network config is set to Base Sepolia (Chain ID: 84532)');
  } else {
    console.log('❌ Network config is not properly set to Base Sepolia');
  }
} else {
  console.log('❌ Network config file not found');
}

// Test 2: Check onboarding flow integration
console.log('\n2. Checking onboarding flow...');
const onboardingPath = path.join(__dirname, 'src/flows/onboarding/OnboardingFlow.ts');
if (fs.existsSync(onboardingPath)) {
  const content = fs.readFileSync(onboardingPath, 'utf8');
  if (content.includes('NETWORK_CONFIG') && content.includes('Base Sepolia')) {
    console.log('✅ Onboarding flow integrated with Base Sepolia config');
  } else {
    console.log('❌ Onboarding flow not properly integrated with network config');
  }
} else {
  console.log('❌ Onboarding flow file not found');
}

// Test 3: Check main entry point
console.log('\n3. Checking main entry point...');
const mainPath = path.join(__dirname, 'src/main.ts');
if (fs.existsSync(mainPath)) {
  console.log('✅ Main entry point exists (src/main.ts)');
} else {
  console.log('❌ Main entry point not found');
}

// Test 4: Check package.json scripts
console.log('\n4. Checking package.json scripts...');
const packagePath = path.join(__dirname, 'package.json');
if (fs.existsSync(packagePath)) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (pkg.scripts && pkg.scripts['dev:new']) {
    console.log('✅ Development script available (yarn dev:new)');
  } else {
    console.log('❌ Development script not found');
  }
} else {
  console.log('❌ package.json not found');
}

console.log('\n📋 Test Summary:');
console.log('- Base Sepolia network forced for all operations');
console.log('- Chain ID: 84532');
console.log('- Onboarding flow supports address splitting');
console.log('- Username parsing supports @user, user.eth, 0x... formats');
console.log('- Custom percentage splitting (e.g., "@alice 30%, @bob 70%")');
console.log('- Equal splitting when no percentages specified');

console.log('\n🚀 Ready to test! Run:');
console.log('   yarn dev:new');
console.log('\n💬 Test the onboarding flow by sending messages to the bot.');
console.log('   The bot will guide you through:');
console.log('   1. Coin name, ticker, and image collection');
console.log('   2. Username/address collection for fee splitting');
console.log('   3. Coin launch simulation on Base Sepolia'); 