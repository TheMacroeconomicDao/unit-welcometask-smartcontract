import { ethers, upgrades, network } from "hardhat";
import { expect } from "chai";
import { Signer } from "ethers";
import { VCSaleContract, VCToken } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("VCSaleContract", () => {
  let owner: Signer;
  let admin: Signer;
  let manager: Signer;
  let user1: Signer;
  let user2: Signer;
  let treasury: Signer;
  let vcsaleContract: VCSaleContract;
  let vcToken: VCToken;
  
  // Test constants
  const PRICE_PER_VC = ethers.parseEther("0.001"); // 0.001 BNB per VC
  const MIN_PURCHASE = ethers.parseEther("1"); // 1 VC minimum
  const MAX_PURCHASE = ethers.parseEther("1000"); // 1000 VC maximum
  const INITIAL_VC_SUPPLY = ethers.parseEther("1000000"); // 1M VC for testing
  
  beforeEach(async () => {
    [owner, admin, manager, user1, user2, treasury] = await ethers.getSigners();

    // Deploy VC Token mock
    const VCTokenFactory = await ethers.getContractFactory("VCToken");
    vcToken = await VCTokenFactory.deploy(await owner.getAddress());
    await vcToken.waitForDeployment();
    
    // Deploy VCSaleContract through proxy
    const VCSaleContractFactory = await ethers.getContractFactory("VCSaleContract");
    vcsaleContract = await upgrades.deployProxy(
      VCSaleContractFactory,
      [
        await vcToken.getAddress(),
        PRICE_PER_VC,
        MIN_PURCHASE,
        MAX_PURCHASE,
        await treasury.getAddress(),
        await admin.getAddress()
      ],
      {
        initializer: "initialize",
        kind: "uups"
      }
    ) as unknown as VCSaleContract;
    await vcsaleContract.waitForDeployment();
    
    // Fund the contract with VC tokens
    await vcToken.mintTo(await admin.getAddress(), INITIAL_VC_SUPPLY);
    await vcToken.connect(admin).approve(await vcsaleContract.getAddress(), INITIAL_VC_SUPPLY);
    await vcsaleContract.connect(admin).depositVCTokens(INITIAL_VC_SUPPLY);
    
    // Grant additional roles
    const MANAGER_ROLE = await vcsaleContract.MANAGER_ROLE();
    await vcsaleContract.connect(admin).grantRole(MANAGER_ROLE, await manager.getAddress());
  });

  describe("Initialization", () => {
    it("Should set correct initial configuration", async () => {
      const saleConfig = await vcsaleContract.saleConfig();
      const securityConfig = await vcsaleContract.securityConfig();
      
      expect(saleConfig.vcTokenAddress).to.equal(await vcToken.getAddress());
      expect(saleConfig.pricePerVC).to.equal(PRICE_PER_VC);
      expect(saleConfig.minPurchaseAmount).to.equal(MIN_PURCHASE);
      expect(saleConfig.maxPurchaseAmount).to.equal(MAX_PURCHASE);
      expect(saleConfig.treasury).to.equal(await treasury.getAddress());
      expect(saleConfig.saleActive).to.be.false;
      expect(saleConfig.totalVCAvailable).to.equal(INITIAL_VC_SUPPLY);
      
      expect(securityConfig.mevProtectionEnabled).to.be.true;
      expect(securityConfig.minTimeBetweenPurchases).to.equal(60);
      expect(securityConfig.circuitBreakerActive).to.be.true;
    });

    it("Should grant correct roles to admin", async () => {
      const ADMIN_ROLE = await vcsaleContract.ADMIN_ROLE();
      const MANAGER_ROLE = await vcsaleContract.MANAGER_ROLE();
      const PAUSER_ROLE = await vcsaleContract.PAUSER_ROLE();
      const EMERGENCY_ROLE = await vcsaleContract.EMERGENCY_ROLE();
      
      expect(await vcsaleContract.hasRole(ADMIN_ROLE, await admin.getAddress())).to.be.true;
      expect(await vcsaleContract.hasRole(MANAGER_ROLE, await admin.getAddress())).to.be.true;
      expect(await vcsaleContract.hasRole(PAUSER_ROLE, await admin.getAddress())).to.be.true;
      expect(await vcsaleContract.hasRole(EMERGENCY_ROLE, await admin.getAddress())).to.be.true;
    });

    it("Should prevent double initialization", async () => {
      await expect(
        vcsaleContract.initialize(
          await vcToken.getAddress(),
          PRICE_PER_VC,
          MIN_PURCHASE,
          MAX_PURCHASE,
          await treasury.getAddress(),
          await admin.getAddress()
        )
      ).to.be.revertedWithCustomError(vcsaleContract, "InvalidInitialization");
    });

    it("Should validate initialization parameters", async () => {
      const VCSaleContractFactory = await ethers.getContractFactory("VCSaleContract");
      
      // Test zero addresses
      await expect(
        upgrades.deployProxy(
          VCSaleContractFactory,
          [
            ethers.ZeroAddress, // Invalid VC token
            PRICE_PER_VC,
            MIN_PURCHASE,
            MAX_PURCHASE,
            await treasury.getAddress(),
            await admin.getAddress()
          ],
          { initializer: "initialize", kind: "uups" }
        )
      ).to.be.revertedWith("VC token: zero address");
      
      // Test invalid price
      await expect(
        upgrades.deployProxy(
          VCSaleContractFactory,
          [
            await vcToken.getAddress(),
            0, // Invalid price
            MIN_PURCHASE,
            MAX_PURCHASE,
            await treasury.getAddress(),
            await admin.getAddress()
          ],
          { initializer: "initialize", kind: "uups" }
        )
      ).to.be.revertedWith("Price too low");
    });
  });

  describe("Purchase Function", () => {
    beforeEach(async () => {
      // Activate sale
      await vcsaleContract.connect(manager).setSaleActive(true);
    });

    it("Should allow valid purchase", async () => {
      const vcAmount = ethers.parseEther("10");
      const requiredBNB = await vcsaleContract.calculateBNBAmount(vcAmount);
      
      const initialVCBalance = await vcToken.balanceOf(await user1.getAddress());
      
      const tx = await vcsaleContract.connect(user1).purchaseVC(vcAmount, { 
        value: requiredBNB + ethers.parseEther("0.001") // Add buffer
      });
      
      // Check event was emitted
      await expect(tx).to.emit(vcsaleContract, "VCPurchased");
      
      // Check token transfer happened
      expect(await vcToken.balanceOf(await user1.getAddress()))
        .to.equal(initialVCBalance + vcAmount);
      
      // Check user stats
      const userStats = await vcsaleContract.getUserStats(await user1.getAddress());
      expect(userStats.purchasedVC).to.equal(vcAmount);
      expect(userStats.spentBNB).to.equal(requiredBNB);
    });

    it("Should reject purchase when sale is inactive", async () => {
      await vcsaleContract.connect(manager).setSaleActive(false);
      
      const vcAmount = ethers.parseEther("10");
      const requiredBNB = await vcsaleContract.calculateBNBAmount(vcAmount);
      
      await expect(
        vcsaleContract.connect(user1).purchaseVC(vcAmount, { value: requiredBNB })
      ).to.be.revertedWith("Sale is not active");
    });

    it("Should reject purchase below minimum", async () => {
      const vcAmount = ethers.parseEther("0.5"); // Below 1 VC minimum
      const requiredBNB = await vcsaleContract.calculateBNBAmount(vcAmount);
      
      await expect(
        vcsaleContract.connect(user1).purchaseVC(vcAmount, { value: requiredBNB })
      ).to.be.revertedWith("Below minimum purchase");
    });

    it("Should reject purchase above maximum", async () => {
      const vcAmount = ethers.parseEther("1001"); // Above 1000 VC maximum
      const requiredBNB = await vcsaleContract.calculateBNBAmount(vcAmount);
      
      await expect(
        vcsaleContract.connect(user1).purchaseVC(vcAmount, { value: requiredBNB })
      ).to.be.revertedWith("Above maximum purchase");
    });

    it("Should reject insufficient BNB", async () => {
      const vcAmount = ethers.parseEther("10");
      const requiredBNB = await vcsaleContract.calculateBNBAmount(vcAmount);
      
      await expect(
        vcsaleContract.connect(user1).purchaseVC(vcAmount, { value: requiredBNB - 1n })
      ).to.be.revertedWith("Insufficient BNB sent");
    });

    it("Should return excess BNB", async () => {
      const vcAmount = ethers.parseEther("10");
      const requiredBNB = await vcsaleContract.calculateBNBAmount(vcAmount);
      const excess = ethers.parseEther("0.1");
      
      const initialBalance = await ethers.provider.getBalance(await user1.getAddress());
      
      const tx = await vcsaleContract.connect(user1).purchaseVC(vcAmount, { 
        value: requiredBNB + excess
      });
      
      const gasUsed = (await tx.wait())!.gasUsed;
      const gasPrice = tx.gasPrice || 0n;
      const expectedBalance = initialBalance - requiredBNB - (gasUsed * gasPrice);
      
      expect(await ethers.provider.getBalance(await user1.getAddress()))
        .to.be.closeTo(expectedBalance, ethers.parseEther("0.001"));
    });
  });

  describe("MEV Protection", () => {
    beforeEach(async () => {
      await vcsaleContract.connect(manager).setSaleActive(true);
    });

    it("Should prevent rapid purchases from same user", async () => {
      const vcAmount = ethers.parseEther("10");
      const requiredBNB = await vcsaleContract.calculateBNBAmount(vcAmount);
      
      // First purchase should succeed
      await vcsaleContract.connect(user1).purchaseVC(vcAmount, { value: requiredBNB });
      
      // Second purchase should fail due to MEV protection
      await expect(
        vcsaleContract.connect(user1).purchaseVC(vcAmount, { value: requiredBNB })
      ).to.be.revertedWith("Too frequent purchases");
    });

    it("Should allow purchase after cooldown period", async () => {
      const vcAmount = ethers.parseEther("10");
      const requiredBNB = await vcsaleContract.calculateBNBAmount(vcAmount);
      
      // First purchase
      await vcsaleContract.connect(user1).purchaseVC(vcAmount, { value: requiredBNB });
      
      // Advance time by 61 seconds (cooldown is 60 seconds)
      await time.increase(61);
      
      // Second purchase should succeed
      await expect(
        vcsaleContract.connect(user1).purchaseVC(vcAmount, { value: requiredBNB })
      ).to.not.be.reverted;
    });
  });

  describe("Circuit Breaker", () => {
    beforeEach(async () => {
      await vcsaleContract.connect(manager).setSaleActive(true);
    });

    it("Should track sales in window and reset after time window", async () => {
      const largeAmount = ethers.parseEther("1000"); // Max purchase per transaction
      
      // Make several purchases to test sales tracking
      for (let i = 0; i < 3; i++) {
        const requiredBNB = await vcsaleContract.calculateBNBAmount(largeAmount);
        const user = i % 2 === 0 ? user1 : user2; // Alternate users
        
        await time.increase(61); // MEV protection cooldown
        await vcsaleContract.connect(user).purchaseVC(largeAmount, { value: requiredBNB });
      }
      
      // Check that sales are being tracked
      const circuitBreakerState = await vcsaleContract.circuitBreaker();
      expect(circuitBreakerState.salesInWindow).to.equal(ethers.parseEther("3000")); // 3 * 1000 VC
      
      // Advance time beyond circuit breaker window (1 hour + 1 second)
      await time.increase(3601);
      
      // Make another purchase - this should reset the window
      const requiredBNB = await vcsaleContract.calculateBNBAmount(largeAmount);
      await vcsaleContract.connect(user1).purchaseVC(largeAmount, { value: requiredBNB });
      
      // Window should be reset, sales should be just this purchase
      const newState = await vcsaleContract.circuitBreaker();
      expect(newState.salesInWindow).to.equal(largeAmount); // Just the new purchase
    });

    it("Should allow emergency role to reset circuit breaker", async () => {
      // Manually reset circuit breaker
      await expect(
        vcsaleContract.connect(admin).resetCircuitBreaker()
      ).to.emit(vcsaleContract, "CircuitBreakerReset");
      
      // Check that circuit breaker was reset
      const afterReset = await vcsaleContract.circuitBreaker();
      expect(afterReset.salesInWindow).to.equal(0);
      expect(afterReset.triggered).to.be.false;
    });
  });

  describe("Daily Sales Limits", () => {
    beforeEach(async () => {
      await vcsaleContract.connect(manager).setSaleActive(true);
    });

    it("Should track daily sales and reset properly", async () => {
      const purchaseAmount = ethers.parseEther("1000");
      
      // Make several purchases to test daily tracking
      for (let i = 0; i < 3; i++) {
        const requiredBNB = await vcsaleContract.calculateBNBAmount(purchaseAmount);
        const user = i % 2 === 0 ? user1 : user2;
        
        await time.increase(61); // MEV protection
        await vcsaleContract.connect(user).purchaseVC(purchaseAmount, { value: requiredBNB });
      }
      
      // Check daily sales tracking
      const dailySalesData = await vcsaleContract.dailySales();
      const currentDate = Math.floor((await time.latest()) / 86400);
      
      expect(dailySalesData.date).to.equal(currentDate);
      expect(dailySalesData.amount).to.equal(ethers.parseEther("3000")); // 3 * 1000 VC
      
      // Check remaining daily limit
      const stats = await vcsaleContract.getSaleStats();
      expect(stats.dailySalesAmount).to.equal(ethers.parseEther("3000"));
    });

    it("Should reset daily sales limit each day", async () => {
      const purchaseAmount = ethers.parseEther("1000");
      
      // Make purchases on day 1  
      for (let i = 0; i < 2; i++) {
        const requiredBNB = await vcsaleContract.calculateBNBAmount(purchaseAmount);
        const user = i % 2 === 0 ? user1 : user2;
        
        await time.increase(61);
        await vcsaleContract.connect(user).purchaseVC(purchaseAmount, { value: requiredBNB });
      }
      
      // Check day 1 sales
      let dailySalesData = await vcsaleContract.dailySales();
      expect(dailySalesData.amount).to.equal(ethers.parseEther("2000")); // 2 * 1000 VC
      
      // Advance time by 24 hours + 1 second to next day
      await time.increase(24 * 60 * 60 + 1);
      
      // Make a purchase on day 2 - this should reset daily counter
      const requiredBNB = await vcsaleContract.calculateBNBAmount(purchaseAmount);
      await vcsaleContract.connect(user1).purchaseVC(purchaseAmount, { value: requiredBNB });
      
      // Check that daily sales reset
      dailySalesData = await vcsaleContract.dailySales();
      const newDate = Math.floor((await time.latest()) / 86400);
      
      expect(dailySalesData.date).to.equal(newDate); // New date
      expect(dailySalesData.amount).to.equal(purchaseAmount); // Only today's purchase
    });
  });

  describe("Role-Based Access Control", () => {
    it("Should allow admin to deposit VC tokens", async () => {
      const depositAmount = ethers.parseEther("1000");
      
      await vcToken.mintTo(await admin.getAddress(), depositAmount);
      await vcToken.connect(admin).approve(await vcsaleContract.getAddress(), depositAmount);
      
      await expect(
        vcsaleContract.connect(admin).depositVCTokens(depositAmount)
      ).to.emit(vcsaleContract, "SaleConfigUpdated");
    });

    it("Should prevent non-admin from depositing VC tokens", async () => {
      const depositAmount = ethers.parseEther("1000");
      
      await expect(
        vcsaleContract.connect(user1).depositVCTokens(depositAmount)
      ).to.be.revertedWithCustomError(vcsaleContract, "AccessControlUnauthorizedAccount");
    });

    it("Should allow manager to activate/deactivate sale", async () => {
      await expect(
        vcsaleContract.connect(manager).setSaleActive(true)
      ).to.emit(vcsaleContract, "SaleConfigUpdated");
      
      expect((await vcsaleContract.saleConfig()).saleActive).to.be.true;
    });

    it("Should allow manager to update price with restrictions", async () => {
      // First advance time to clear initial cooldown
      await time.increase(3601); // 1 hour + 1 second
      
      const newPrice = ethers.parseEther("0.0015"); // 50% increase (exceeds 10% limit)
      
      // This should fail due to price change protection
      await expect(
        vcsaleContract.connect(manager).updatePrice(newPrice)
      ).to.be.revertedWith("Price change too large");
      
      // But 5% change should work
      const smallChange = PRICE_PER_VC * 105n / 100n; // 5% increase
      await expect(
        vcsaleContract.connect(manager).updatePrice(smallChange)
      ).to.emit(vcsaleContract, "PriceUpdateRequested");
    });

    it("Should enforce price update cooldown", async () => {
      // First advance time to clear initial cooldown
      await time.increase(3601); // 1 hour + 1 second
      
      const newPrice = PRICE_PER_VC * 105n / 100n; // 5% increase
      
      // First update should succeed
      await vcsaleContract.connect(manager).updatePrice(newPrice);
      
      // Second update should fail due to cooldown
      await expect(
        vcsaleContract.connect(manager).updatePrice(PRICE_PER_VC)
      ).to.be.revertedWith("Price update cooldown active");
      
      // After cooldown period, should succeed
      await time.increase(3601); // 1 hour + 1 second
      await expect(
        vcsaleContract.connect(manager).updatePrice(PRICE_PER_VC)
      ).to.emit(vcsaleContract, "PriceUpdateRequested");
    });
  });

  describe("Emergency Functions", () => {
    it("Should allow pauser to emergency pause", async () => {
      await expect(
        vcsaleContract.connect(admin).emergencyPause()
      ).to.emit(vcsaleContract, "EmergencyAction");
      
      expect(await vcsaleContract.paused()).to.be.true;
    });

    it("Should allow admin to unpause", async () => {
      await vcsaleContract.connect(admin).emergencyPause();
      
      await expect(
        vcsaleContract.connect(admin).unpause()
      ).to.emit(vcsaleContract, "EmergencyAction");
      
      expect(await vcsaleContract.paused()).to.be.false;
    });

    it("Should allow emergency withdrawal", async () => {
      // First fund contract with some BNB
      await owner.sendTransaction({
        to: await vcsaleContract.getAddress(),
        value: ethers.parseEther("1")
      });
      
      // This should fail because receive() reverts
      await expect(
        owner.sendTransaction({
          to: await vcsaleContract.getAddress(),
          value: ethers.parseEther("1")
        })
      ).to.be.reverted;
      
      // Emergency withdraw should work for emergency role
      await expect(
        vcsaleContract.connect(admin).emergencyWithdraw(ethers.ZeroAddress, ethers.parseEther("0.5"))
      ).to.emit(vcsaleContract, "EmergencyAction");
    });
  });

  describe("View Functions", () => {
    beforeEach(async () => {
      await vcsaleContract.connect(manager).setSaleActive(true);
    });

    it("Should return correct sale stats", async () => {
      const stats = await vcsaleContract.getSaleStats();
      
      expect(stats.totalVCAvailable).to.equal(INITIAL_VC_SUPPLY);
      expect(stats.totalVCSold).to.equal(0);
      expect(stats.currentVCBalance).to.equal(INITIAL_VC_SUPPLY);
      expect(stats.pricePerVC).to.equal(PRICE_PER_VC);
      expect(stats.saleActive).to.be.true;
    });

    it("Should return correct user stats", async () => {
      const vcAmount = ethers.parseEther("100");
      const requiredBNB = await vcsaleContract.calculateBNBAmount(vcAmount);
      
      // Make a purchase
      await vcsaleContract.connect(user1).purchaseVC(vcAmount, { value: requiredBNB });
      
      const userStats = await vcsaleContract.getUserStats(await user1.getAddress());
      expect(userStats.purchasedVC).to.equal(vcAmount);
      expect(userStats.spentBNB).to.equal(requiredBNB);
      expect(userStats.isBlacklisted).to.be.false;
    });

    it("Should check purchase eligibility correctly", async () => {
      const vcAmount = ethers.parseEther("100");
      
      const [canPurchase, reason] = await vcsaleContract.canPurchase(
        await user1.getAddress(),
        vcAmount
      );
      
      expect(canPurchase).to.be.true;
      expect(reason).to.equal("");
    });
  });

  describe("Security Features", () => {
    beforeEach(async () => {
      await vcsaleContract.connect(manager).setSaleActive(true);
    });

    it("Should blacklist users", async () => {
      await expect(
        vcsaleContract.connect(admin).blacklistUser(await user1.getAddress(), "Suspicious activity")
      ).to.emit(vcsaleContract, "UserBlacklisted");
      
      expect(await vcsaleContract.blacklistedUsers(await user1.getAddress())).to.be.true;
      
      // Blacklisted user cannot purchase
      const vcAmount = ethers.parseEther("10");
      const requiredBNB = await vcsaleContract.calculateBNBAmount(vcAmount);
      
      await expect(
        vcsaleContract.connect(user1).purchaseVC(vcAmount, { value: requiredBNB })
      ).to.be.revertedWith("User is blacklisted");
    });

    it("Should remove users from blacklist", async () => {
      // First blacklist
      await vcsaleContract.connect(admin).blacklistUser(await user1.getAddress(), "Test");
      
      // Then remove from blacklist
      await expect(
        vcsaleContract.connect(admin).removeFromBlacklist(await user1.getAddress())
      ).to.emit(vcsaleContract, "SecurityEvent");
      
      expect(await vcsaleContract.blacklistedUsers(await user1.getAddress())).to.be.false;
    });

    it("Should prevent direct BNB transfers", async () => {
      await expect(
        user1.sendTransaction({
          to: await vcsaleContract.getAddress(),
          value: ethers.parseEther("1")
        })
      ).to.be.revertedWith("Direct BNB transfers not allowed. Use purchaseVC function.");
    });
  });

  describe("Calculation Functions", () => {
    it("Should calculate BNB amount correctly", async () => {
      const vcAmount = ethers.parseEther("100");
      const expectedBNB = vcAmount * PRICE_PER_VC / ethers.parseEther("1");
      
      const calculatedBNB = await vcsaleContract.calculateBNBAmount(vcAmount);
      expect(calculatedBNB).to.equal(expectedBNB);
    });

    it("Should calculate VC amount correctly", async () => {
      const bnbAmount = ethers.parseEther("0.1");
      const expectedVC = bnbAmount * ethers.parseEther("1") / PRICE_PER_VC;
      
      const calculatedVC = await vcsaleContract.calculateVCAmount(bnbAmount);
      expect(calculatedVC).to.equal(expectedVC);
    });

    it("Should return available VC correctly", async () => {
      const available = await vcsaleContract.getAvailableVC();
      expect(available).to.equal(INITIAL_VC_SUPPLY);
    });
  });
});