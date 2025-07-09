import { XMTPStatusMonitor } from "../src/services/XMTPStatusMonitor";

/**
 * Test script to verify the restart mechanism
 */
async function testRestartMechanism() {
  console.log("🧪 Testing XMTP restart mechanism...");

  const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? ".data/xmtp";
  const statusMonitor = new XMTPStatusMonitor(volumePath);

  // Mock application factory for testing
  let appStartCount = 0;
  const mockApplicationFactory = async () => {
    appStartCount++;
    console.log(`📱 Mock application started (count: ${appStartCount})`);

    // Simulate application resources
    return {
      client: {} as any, // Mock client
      statusMonitor,
      messageStream: {} as any, // Mock stream
      cleanup: async () => {
        console.log("🧹 Mock cleanup called");
      },
    };
  };

  console.log("📊 Current status:", statusMonitor.getStatus());

  try {
    // Test 1: Start application with monitoring
    console.log("\n🔬 Test 1: Starting application with monitoring...");

    // Start the application (this will run in background)
    const startPromise = statusMonitor.startWithMonitoring(
      mockApplicationFactory
    );

    // Wait a moment for initialization
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (appStartCount === 1) {
      console.log("✅ Test 1 passed: Application started successfully!");
    } else {
      console.log("❌ Test 1 failed: Application didn't start properly");
    }

    // Test 2: Manual status check
    console.log("\n🔬 Test 2: Manual status check...");
    const shouldRestart = await statusMonitor.performManualCheck();
    console.log(
      `Result: ${shouldRestart ? "RESTART NEEDED" : "NO RESTART NEEDED"}`
    );

    // Test 3: Force restart
    console.log("\n🔬 Test 3: Testing force restart...");
    const initialCount = appStartCount;

    // Force restart
    await statusMonitor.forceRestart();

    // Wait for restart to complete
    await new Promise((resolve) => setTimeout(resolve, 3000));

    if (appStartCount > initialCount) {
      console.log("✅ Test 3 passed: Force restart worked!");
    } else {
      console.log("❌ Test 3 failed: Force restart didn't work");
    }

    // Test 4: Immediate check trigger
    console.log("\n🔬 Test 4: Testing immediate check trigger...");
    await statusMonitor.triggerImmediateCheck();
    console.log("✅ Test 4 passed: Immediate check completed!");

    // Test 5: Status retrieval
    console.log("\n🔬 Test 5: Testing status retrieval...");

    // Wait a moment for monitoring to restart after force restart
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const status = statusMonitor.getStatus();
    console.log("Status:", status);

    if (status.isMonitoring && status.startupTime && status.checkInterval > 0) {
      console.log(
        "✅ Test 5 passed: Status retrieval works and monitoring is active!"
      );
    } else {
      console.log(
        "❌ Test 5 failed: Status retrieval incomplete or monitoring not active"
      );
    }

    console.log("\n✅ All tests completed!");
    console.log(`📊 Final app start count: ${appStartCount}`);
  } catch (error) {
    console.error("❌ Test failed:", error);
  } finally {
    // Clean up
    await statusMonitor.shutdown();
    console.log("🧹 Test cleanup completed");
  }

  process.exit(0);
}

// Run the test
testRestartMechanism().catch((error) => {
  console.error("❌ Test failed:", error);
  process.exit(1);
});
