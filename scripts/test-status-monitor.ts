import { XMTPStatusMonitor } from "../src/services/XMTPStatusMonitor";

/**
 * Test script for the XMTP Status Monitor
 */
async function testStatusMonitor() {
  console.log("🧪 Testing XMTP Status Monitor...");

  // Create monitor instance
  const monitor = new XMTPStatusMonitor(".data/test");

  try {
    // Perform a manual check first
    console.log("\n1. Performing manual status check...");
    const hasIssues = await monitor.performManualCheck();
    console.log(
      `   Result: ${hasIssues ? "🚨 Issues detected" : "✅ No issues"}`
    );

    // Show current status
    console.log("\n2. Monitor status:");
    const status = monitor.getStatus();
    console.log(`   - Is monitoring: ${status.isMonitoring}`);
    console.log(`   - Startup time: ${status.startupTime.toISOString()}`);
    console.log(`   - Check interval: ${status.checkInterval / 1000}s`);

    // Start monitoring for a short test period
    console.log("\n3. Starting monitoring for 30 seconds...");

    // Mock application factory for testing
    const mockApplicationFactory = async () => {
      return {
        client: {} as any,
        statusMonitor: monitor,
        messageStream: {} as any,
        cleanup: async () => console.log("Mock cleanup called"),
      };
    };

    // Start monitoring with mock factory
    monitor.startWithMonitoring(mockApplicationFactory);

    // Wait 30 seconds then stop
    setTimeout(async () => {
      console.log("\n4. Stopping monitor...");
      await monitor.shutdown();
      console.log("✅ Test completed successfully!");
      process.exit(0);
    }, 30000);
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

// Handle interruption
process.on("SIGINT", () => {
  console.log("\n🛑 Test interrupted");
  process.exit(0);
});

testStatusMonitor();
