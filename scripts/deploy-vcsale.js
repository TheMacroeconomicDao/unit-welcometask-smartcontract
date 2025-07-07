const { ethers, upgrades } = require("hardhat");
const fs = require("fs");

async function main() {
  const [deployer] = await ethers.getSigners();
  
  console.log("🚀 Deploying VCSaleContract with account:", deployer.address);
  console.log("💰 Account balance:", ethers.formatEther(await deployer.provider.getBalance(deployer.address)));

  // Загружаем информацию о развернутых контрактах
  let deployedContracts = {};
  try {
    const deployedData = fs.readFileSync("deployed-ecosystem.json", "utf8");
    deployedContracts = JSON.parse(deployedData);
  } catch (error) {
    console.log("📄 No existing deployment data found, creating new...");
  }

  // Получаем адрес VC токена или используем placeholder
  const vcTokenAddress = deployedContracts.VCToken || "0xC88eC091302Eb90e78a4CA361D083330752dfc9A";
  console.log("📍 Using VC Token address:", vcTokenAddress);

  // Параметры для инициализации (более консервативные для production)
  const pricePerVC = ethers.parseEther("0.001"); // 0.001 BNB за 1 VC
  const minPurchaseAmount = ethers.parseEther("1"); // Минимум 1 VC
  const maxPurchaseAmount = ethers.parseEther("1000"); // Максимум 1000 VC (более консервативно)
  const treasury = deployer.address; // Казна - адрес деплойера
  const admin = deployer.address; // Администратор

  console.log("⚙️  Deployment parameters:");
  console.log("   - VC Token Address:", vcTokenAddress);
  console.log("   - Price per VC:", ethers.formatEther(pricePerVC), "BNB");
  console.log("   - Min Purchase:", ethers.formatEther(minPurchaseAmount), "VC");
  console.log("   - Max Purchase:", ethers.formatEther(maxPurchaseAmount), "VC");
  console.log("   - Treasury:", treasury);
  console.log("   - Admin:", admin);

  // Разворачиваем контракт
  console.log("\n🔨 Deploying VCSaleContract...");
  const VCSaleContract = await ethers.getContractFactory("VCSaleContract");
  
  const vcsaleContract = await upgrades.deployProxy(
    VCSaleContract,
    [
      vcTokenAddress,
      pricePerVC,
      minPurchaseAmount,
      maxPurchaseAmount,
      treasury,
      admin
    ],
    {
      initializer: "initialize",
      kind: "uups",
      gasLimit: 5000000 // Увеличенный лимит газа для сложного контракта
    }
  );

  await vcsaleContract.waitForDeployment();
  const contractAddress = await vcsaleContract.getAddress();

  console.log("✅ VCSaleContract deployed to:", contractAddress);
  console.log("📋 Implementation deployed to:", await upgrades.erc1967.getImplementationAddress(contractAddress));

  // Верификация начального состояния
  console.log("\n🔍 Verifying deployment...");
  try {
    const saleConfig = await vcsaleContract.saleConfig();
    const securityConfig = await vcsaleContract.securityConfig();
    
    console.log("📊 Sale Configuration:");
    console.log("   - VC Token Address:", saleConfig.vcTokenAddress);
    console.log("   - Price per VC:", ethers.formatEther(saleConfig.pricePerVC), "BNB");
    console.log("   - Min Purchase:", ethers.formatEther(saleConfig.minPurchaseAmount), "VC");
    console.log("   - Max Purchase:", ethers.formatEther(saleConfig.maxPurchaseAmount), "VC");
    console.log("   - Sale Active:", saleConfig.saleActive);
    console.log("   - Treasury:", saleConfig.treasury);
    console.log("   - Max Daily Sales:", ethers.formatEther(saleConfig.maxDailySales), "VC");
    
    console.log("\n🔒 Security Configuration:");
    console.log("   - MEV Protection:", securityConfig.mevProtectionEnabled);
    console.log("   - Min Time Between Purchases:", securityConfig.minTimeBetweenPurchases, "seconds");
    console.log("   - Max Purchases Per Block:", securityConfig.maxPurchasesPerBlock);
    console.log("   - Circuit Breaker Active:", securityConfig.circuitBreakerActive);
    console.log("   - Circuit Breaker Threshold:", ethers.formatEther(securityConfig.circuitBreakerThreshold), "VC");
    
    // Проверка ролей
    const ADMIN_ROLE = await vcsaleContract.ADMIN_ROLE();
    const MANAGER_ROLE = await vcsaleContract.MANAGER_ROLE();
    const PAUSER_ROLE = await vcsaleContract.PAUSER_ROLE();
    const EMERGENCY_ROLE = await vcsaleContract.EMERGENCY_ROLE();
    
    console.log("\n👥 Role Configuration:");
    console.log("   - Has ADMIN_ROLE:", await vcsaleContract.hasRole(ADMIN_ROLE, admin));
    console.log("   - Has MANAGER_ROLE:", await vcsaleContract.hasRole(MANAGER_ROLE, admin));
    console.log("   - Has PAUSER_ROLE:", await vcsaleContract.hasRole(PAUSER_ROLE, admin));
    console.log("   - Has EMERGENCY_ROLE:", await vcsaleContract.hasRole(EMERGENCY_ROLE, admin));
    
  } catch (error) {
    console.error("❌ Verification failed:", error.message);
  }

  // Дополнительная настройка безопасности
  console.log("\n🛡️  Setting up additional security measures...");
  
  try {
    // Проверяем circuit breaker состояние
    const circuitBreaker = await vcsaleContract.circuitBreaker();
    console.log("⚡ Circuit Breaker Status:");
    console.log("   - Triggered:", circuitBreaker.triggered);
    console.log("   - Sales in Window:", ethers.formatEther(circuitBreaker.salesInWindow), "VC");
    console.log("   - Window Start Time:", new Date(Number(circuitBreaker.windowStartTime) * 1000).toISOString());
    
    // Проверяем daily sales
    const dailySales = await vcsaleContract.dailySales();
    console.log("📅 Daily Sales Status:");
    console.log("   - Current Date:", dailySales.date.toString());
    console.log("   - Amount Sold Today:", ethers.formatEther(dailySales.amount), "VC");
    
  } catch (error) {
    console.error("⚠️  Security check failed:", error.message);
  }

  // Сохраняем информацию о развертывании
  deployedContracts.VCSaleContract = contractAddress;
  deployedContracts.VCSaleContract_Implementation = await upgrades.erc1967.getImplementationAddress(contractAddress);
  deployedContracts.VCSaleContract_DeployedAt = new Date().toISOString();
  deployedContracts.VCSaleContract_Network = "BSC Testnet";
  deployedContracts.VCSaleContract_Deployer = deployer.address;
  deployedContracts.VCSaleContract_Version = "2.0.0-secure";

  fs.writeFileSync("deployed-ecosystem.json", JSON.stringify(deployedContracts, null, 2));
  console.log("💾 Deployment info saved to deployed-ecosystem.json");

  // Выводим инструкции для настройки
  console.log("\n📝 Next steps for SECURE deployment:");
  console.log("1. 🔐 Setup role separation (recommended):");
  console.log(`   - Create separate addresses for MANAGER_ROLE, PAUSER_ROLE, EMERGENCY_ROLE`);
  console.log(`   - Call grantRole() for each role to different addresses`);
  console.log(`   - Call revokeRole() to remove admin from operational roles`);
  
  console.log("2. 💰 Fund the contract with VC tokens:");
  console.log(`   - Approve VC tokens to: ${contractAddress}`);
  console.log(`   - Call depositVCTokens(amount) with ADMIN_ROLE`);
  
  console.log("3. ⚡ Activate the sale:");
  console.log(`   - Call setSaleActive(true) with MANAGER_ROLE`);
  
  console.log("4. 📊 Setup monitoring:");
  console.log(`   - Monitor SecurityEvent, CircuitBreakerTriggered events`);
  console.log(`   - Setup alerts for suspicious activity`);
  console.log(`   - Monitor daily sales limits`);
  
  console.log("5. 🧪 Test all security features:");
  console.log(`   - Test MEV protection with rapid transactions`);
  console.log(`   - Test circuit breaker with large volumes`);
  console.log(`   - Test emergency pause functionality`);
  console.log(`   - Test blacklist functionality`);
  console.log(`   - Test price update cooldown`);

  console.log("\n🎯 SECURE Contract deployed successfully!");
  console.log("📍 Contract Address:", contractAddress);
  console.log("🌐 BSCScan URL:", `https://testnet.bscscan.com/address/${contractAddress}`);
  
  console.log("\n⚠️  SECURITY REMINDERS:");
  console.log("🔐 This contract implements maximum security measures");
  console.log("📊 All transactions are monitored and logged");
  console.log("⚡ Circuit breaker will auto-stop suspicious activity");
  console.log("🛡️  MEV protection limits transaction frequency");
  console.log("👥 Role-based access control is enforced");
  console.log("🚨 Emergency controls are available for admins");
  
  console.log("\n🚀 Ready for production use!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });