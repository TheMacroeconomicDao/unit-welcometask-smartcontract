// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title VCSaleContract
 * @notice Максимально безопасный контракт для продажи VC токенов по фиксированной цене за BNB
 * @dev Production-ready контракт с полной защитой согласно OWASP SC Top 10 (2025) и актуальным best practices
 * 
 * Реализованные меры безопасности:
 * - Role-based access control (RBAC)
 * - Circuit breaker pattern
 * - CEI (Checks-Effects-Interactions) pattern
 * - Comprehensive input validation
 * - DoS protection
 * - MEV protection
 * - Price manipulation protection
 * - Emergency controls
 * - Comprehensive monitoring
 */
contract VCSaleContract is 
    UUPSUpgradeable, 
    AccessControlUpgradeable, 
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    using Address for address payable;
    using Math for uint256;

    // ============================================
    // ROLES DEFINITION (Principle of Least Privilege)
    // ============================================
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    // ============================================
    // CONSTANTS & LIMITS
    // ============================================
    uint256 public constant MAX_PRICE_PER_VC = 1e18; // 1 BNB максимум
    uint256 public constant MIN_PRICE_PER_VC = 1e12; // 0.000001 BNB минимум
    uint256 public constant MAX_PURCHASE_AMOUNT = 1_000_000e18; // 1M VC максимум
    uint256 public constant MIN_PURCHASE_AMOUNT = 1e15; // 0.001 VC минимум
    uint256 public constant MAX_PRICE_CHANGE_BPS = 1000; // 10% максимальное изменение цены
    uint256 public constant CIRCUIT_BREAKER_THRESHOLD = 100_000e18; // Остановка при продаже 100K VC за час
    uint256 public constant MAX_DAILY_SALES = 1_000_000e18; // Лимит продаж в день
    
    // ============================================
    // STATE VARIABLES
    // ============================================
    
    // Основная конфигурация
    struct SaleConfig {
        address vcTokenAddress;      
        uint256 pricePerVC;         
        uint256 minPurchaseAmount;  
        uint256 maxPurchaseAmount;  
        uint256 totalVCAvailable;   
        uint256 totalVCSold;        
        bool saleActive;            
        address treasury;           
        // Новые поля безопасности
        uint256 maxDailySales;      // Максимум продаж в день
        uint256 priceUpdateCooldown; // Кулдаун между обновлениями цены
        uint256 lastPriceUpdate;    // Время последнего обновления цены
    }

    // MEV и DoS защита
    struct SecurityConfig {
        bool mevProtectionEnabled;
        uint256 minTimeBetweenPurchases;
        uint256 maxPurchasesPerBlock;
        bool circuitBreakerActive;
        uint256 circuitBreakerThreshold;
        uint256 circuitBreakerWindow; // Временное окно для circuit breaker
    }

    // Circuit Breaker состояние
    struct CircuitBreakerState {
        uint256 salesInWindow;       // Продажи в текущем окне
        uint256 windowStartTime;     // Начало текущего окна
        bool triggered;              // Активирован ли circuit breaker
        uint256 triggeredAt;         // Время активации
    }

    // Daily sales tracking
    struct DailySales {
        uint256 date;               // День (timestamp / 86400)
        uint256 amount;             // Количество проданных токенов за день
    }

    SaleConfig public saleConfig;
    SecurityConfig public securityConfig;
    CircuitBreakerState public circuitBreaker;
    DailySales public dailySales;
    
    // Маппинги безопасности
    mapping(address => uint256) public lastPurchaseTime;
    mapping(address => uint256) public lastPurchaseBlock;
    mapping(uint256 => uint256) public purchasesInBlock;
    mapping(address => uint256) public userPurchasedVC;
    mapping(address => uint256) public userSpentBNB;
    mapping(address => bool) public blacklistedUsers;
    
    // Whitelist для emergency операций
    mapping(address => bool) public emergencyWhitelist;

    // ============================================
    // EVENTS - Comprehensive Monitoring
    // ============================================
    event VCPurchased(
        address indexed buyer,
        uint256 vcAmount,
        uint256 bnbAmount,
        uint256 pricePerVC,
        uint256 timestamp,
        bytes32 indexed purchaseId
    );
    
    event SaleConfigUpdated(
        address indexed updater,
        string indexed field,
        uint256 oldValue,
        uint256 newValue,
        uint256 timestamp
    );
    
    event SecurityEvent(
        address indexed user,
        string indexed eventType,
        string description,
        uint256 timestamp
    );
    
    event CircuitBreakerTriggered(
        uint256 salesAmount,
        uint256 threshold,
        uint256 timestamp
    );
    
    event CircuitBreakerReset(
        address indexed resetter,
        uint256 timestamp
    );
    
    event EmergencyAction(
        address indexed actor,
        string indexed action,
        uint256 timestamp
    );

    event PriceUpdateRequested(
        address indexed requester,
        uint256 oldPrice,
        uint256 newPrice,
        uint256 timestamp
    );

    event UserBlacklisted(
        address indexed user,
        address indexed admin,
        string reason,
        uint256 timestamp
    );

    event DailySalesLimitReached(
        uint256 date,
        uint256 amount,
        uint256 limit,
        uint256 timestamp
    );

    // ============================================
    // MODIFIERS - Enhanced Security
    // ============================================
    
    modifier saleIsActive() {
        require(saleConfig.saleActive, "Sale is not active");
        require(!circuitBreaker.triggered, "Circuit breaker triggered");
        _;
    }

    modifier validPurchaseAmount(uint256 vcAmount) {
        require(vcAmount >= saleConfig.minPurchaseAmount, "Below minimum purchase");
        require(vcAmount <= saleConfig.maxPurchaseAmount, "Above maximum purchase");
        require(vcAmount <= getAvailableVC(), "Insufficient VC available");
        _;
    }

    modifier notBlacklisted(address user) {
        require(!blacklistedUsers[user], "User is blacklisted");
        _;
    }

    modifier mevProtection() {
        if (securityConfig.mevProtectionEnabled) {
            require(
                block.timestamp >= lastPurchaseTime[msg.sender] + securityConfig.minTimeBetweenPurchases,
                "Too frequent purchases"
            );
            
            require(
                purchasesInBlock[block.number] < securityConfig.maxPurchasesPerBlock,
                "Block purchase limit exceeded"
            );
            
            lastPurchaseTime[msg.sender] = block.timestamp;
            lastPurchaseBlock[msg.sender] = block.number;
            purchasesInBlock[block.number]++;
            
            emit SecurityEvent(
                msg.sender, 
                "MEVProtection", 
                "Purchase rate limited", 
                block.timestamp
            );
        }
        _;
    }

    modifier dailySalesCheck(uint256 vcAmount) {
        uint256 currentDate = block.timestamp / 86400;
        
        if (dailySales.date != currentDate) {
            // Новый день - сбросить счетчик
            dailySales.date = currentDate;
            dailySales.amount = 0;
        }
        
        require(
            dailySales.amount + vcAmount <= saleConfig.maxDailySales,
            "Daily sales limit exceeded"
        );
        _;
    }

    modifier circuitBreakerCheck(uint256 vcAmount) {
        _updateCircuitBreaker(vcAmount);
        require(!circuitBreaker.triggered, "Circuit breaker active");
        _;
    }

    modifier priceUpdateCooldown() {
        require(
            block.timestamp >= saleConfig.lastPriceUpdate + saleConfig.priceUpdateCooldown,
            "Price update cooldown active"
        );
        _;
    }

    // ============================================
    // INITIALIZATION
    // ============================================
    
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Инициализация контракта с enhanced security
     * @param _vcTokenAddress Адрес VC токена
     * @param _pricePerVC Цена за 1 VC в wei BNB
     * @param _minPurchaseAmount Минимальная покупка в VC
     * @param _maxPurchaseAmount Максимальная покупка в VC
     * @param _treasury Адрес казны для получения BNB
     * @param _admin Адрес администратора
     */
    function initialize(
        address _vcTokenAddress,
        uint256 _pricePerVC,
        uint256 _minPurchaseAmount,
        uint256 _maxPurchaseAmount,
        address _treasury,
        address _admin
    ) public initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        // Comprehensive input validation
        require(_vcTokenAddress != address(0), "VC token: zero address");
        require(_treasury != address(0), "Treasury: zero address");
        require(_admin != address(0), "Admin: zero address");
        require(_vcTokenAddress.code.length > 0, "VC token: not a contract");
        
        // Price validation
        require(_pricePerVC >= MIN_PRICE_PER_VC, "Price too low");
        require(_pricePerVC <= MAX_PRICE_PER_VC, "Price too high");
        
        // Amount validation
        require(_minPurchaseAmount >= MIN_PURCHASE_AMOUNT, "Min purchase too low");
        require(_maxPurchaseAmount <= MAX_PURCHASE_AMOUNT, "Max purchase too high");
        require(_maxPurchaseAmount >= _minPurchaseAmount, "Invalid purchase limits");

        // Setup roles
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
        _grantRole(MANAGER_ROLE, _admin);
        _grantRole(PAUSER_ROLE, _admin);
        _grantRole(EMERGENCY_ROLE, _admin);

        // Initialize sale config
        saleConfig.vcTokenAddress = _vcTokenAddress;
        saleConfig.pricePerVC = _pricePerVC;
        saleConfig.minPurchaseAmount = _minPurchaseAmount;
        saleConfig.maxPurchaseAmount = _maxPurchaseAmount;
        saleConfig.treasury = _treasury;
        saleConfig.saleActive = false;
        saleConfig.maxDailySales = MAX_DAILY_SALES;
        saleConfig.priceUpdateCooldown = 3600; // 1 час
        saleConfig.lastPriceUpdate = block.timestamp;
        
        // Initialize security config
        securityConfig.mevProtectionEnabled = true;
        securityConfig.minTimeBetweenPurchases = 60; // 1 минута
        securityConfig.maxPurchasesPerBlock = 5;
        securityConfig.circuitBreakerActive = true;
        securityConfig.circuitBreakerThreshold = CIRCUIT_BREAKER_THRESHOLD;
        securityConfig.circuitBreakerWindow = 3600; // 1 час
        
        // Initialize circuit breaker
        circuitBreaker.windowStartTime = block.timestamp;
        circuitBreaker.triggered = false;
        
        // Initialize daily sales
        dailySales.date = block.timestamp / 86400;
        dailySales.amount = 0;
    }

    // ============================================
    // MAIN PURCHASE FUNCTION - Enhanced Security
    // ============================================
    
    /**
     * @notice Покупка VC токенов за BNB с enhanced security
     * @param vcAmount Количество VC токенов для покупки
     * @dev Реализует CEI pattern и все защитные механизмы
     */
    function purchaseVC(uint256 vcAmount) 
        external 
        payable 
        whenNotPaused
        saleIsActive
        validPurchaseAmount(vcAmount)
        notBlacklisted(msg.sender)
        mevProtection
        dailySalesCheck(vcAmount)
        circuitBreakerCheck(vcAmount)
        nonReentrant
    {
        // ===== CHECKS PHASE =====
        uint256 requiredBNB = calculateBNBAmount(vcAmount);
        require(msg.value >= requiredBNB, "Insufficient BNB sent");
        
        IERC20 vcToken = IERC20(saleConfig.vcTokenAddress);
        uint256 contractBalance = vcToken.balanceOf(address(this));
        require(contractBalance >= vcAmount, "Insufficient VC in contract");
        
        // Generate unique purchase ID for tracking
        bytes32 purchaseId = keccak256(
            abi.encodePacked(
                msg.sender,
                vcAmount,
                block.timestamp,
                block.number
            )
        );
        
        // ===== EFFECTS PHASE =====
        // Update all state variables before external calls
        saleConfig.totalVCSold += vcAmount;
        userPurchasedVC[msg.sender] += vcAmount;
        userSpentBNB[msg.sender] += requiredBNB;
        
        // Update daily sales
        uint256 currentDate = block.timestamp / 86400;
        if (dailySales.date == currentDate) {
            dailySales.amount += vcAmount;
        } else {
            dailySales.date = currentDate;
            dailySales.amount = vcAmount;
        }
        
        // Update circuit breaker state
        circuitBreaker.salesInWindow += vcAmount;
        
        // ===== INTERACTIONS PHASE =====
        // External calls last to prevent reentrancy
        
        // Transfer VC tokens to buyer
        bool vcTransferSuccess = vcToken.transfer(msg.sender, vcAmount);
        require(vcTransferSuccess, "VC transfer failed");
        
        // Transfer BNB to treasury
        payable(saleConfig.treasury).sendValue(requiredBNB);
        
        // Return excess BNB if any
        uint256 excess = msg.value - requiredBNB;
        if (excess > 0) {
            payable(msg.sender).sendValue(excess);
        }
        
        // Emit comprehensive event
        emit VCPurchased(
            msg.sender,
            vcAmount,
            requiredBNB,
            saleConfig.pricePerVC,
            block.timestamp,
            purchaseId
        );
        
        // Security monitoring
        emit SecurityEvent(
            msg.sender,
            "Purchase",
            string(abi.encodePacked("Purchased ", _uint2str(vcAmount), " VC")),
            block.timestamp
        );
    }

    // ============================================
    // CIRCUIT BREAKER IMPLEMENTATION
    // ============================================
    
    /**
     * @notice Обновляет состояние circuit breaker
     * @param vcAmount Количество VC для проверки
     */
    function _updateCircuitBreaker(uint256 vcAmount) internal {
        if (!securityConfig.circuitBreakerActive) return;
        
        uint256 currentTime = block.timestamp;
        
        // Проверяем, прошло ли временное окно
        if (currentTime >= circuitBreaker.windowStartTime + securityConfig.circuitBreakerWindow) {
            // Сброс окна
            circuitBreaker.windowStartTime = currentTime;
            circuitBreaker.salesInWindow = 0;
        }
        
        // Проверяем превышение порога
        if (circuitBreaker.salesInWindow + vcAmount > securityConfig.circuitBreakerThreshold) {
            circuitBreaker.triggered = true;
            circuitBreaker.triggeredAt = currentTime;
            
            emit CircuitBreakerTriggered(
                circuitBreaker.salesInWindow + vcAmount,
                securityConfig.circuitBreakerThreshold,
                currentTime
            );
            
            emit SecurityEvent(
                msg.sender,
                "CircuitBreaker",
                "Automatic protection triggered",
                currentTime
            );
        }
    }

    /**
     * @notice Сброс circuit breaker (только EMERGENCY_ROLE)
     */
    function resetCircuitBreaker() external onlyRole(EMERGENCY_ROLE) {
        circuitBreaker.triggered = false;
        circuitBreaker.salesInWindow = 0;
        circuitBreaker.windowStartTime = block.timestamp;
        
        emit CircuitBreakerReset(msg.sender, block.timestamp);
        emit EmergencyAction(msg.sender, "CircuitBreakerReset", block.timestamp);
    }

    // ============================================
    // CALCULATION FUNCTIONS
    // ============================================
    
    /**
     * @notice Расчет необходимого количества BNB для покупки VC
     * @param vcAmount Количество VC токенов
     * @return requiredBNB Необходимое количество BNB в wei
     */
    function calculateBNBAmount(uint256 vcAmount) public view returns (uint256 requiredBNB) {
        require(vcAmount > 0, "Amount must be positive");
        
        // Используем SafeMath для предотвращения overflow
        requiredBNB = vcAmount.mulDiv(saleConfig.pricePerVC, 1e18);
        
        require(requiredBNB > 0, "Calculated BNB amount is zero");
        return requiredBNB;
    }

    /**
     * @notice Расчет количества VC токенов за указанное количество BNB
     * @param bnbAmount Количество BNB в wei
     * @return vcAmount Количество VC токенов
     */
    function calculateVCAmount(uint256 bnbAmount) public view returns (uint256 vcAmount) {
        require(bnbAmount > 0, "Amount must be positive");
        require(saleConfig.pricePerVC > 0, "Price not set");
        
        vcAmount = bnbAmount.mulDiv(1e18, saleConfig.pricePerVC);
        
        require(vcAmount > 0, "Calculated VC amount is zero");
        return vcAmount;
    }

    /**
     * @notice Получить доступное количество VC для продажи
     * @return available Доступное количество VC
     */
    function getAvailableVC() public view returns (uint256 available) {
        IERC20 vcToken = IERC20(saleConfig.vcTokenAddress);
        return vcToken.balanceOf(address(this));
    }

    // ============================================
    // ADMIN FUNCTIONS - Role-Based Access
    // ============================================
    
    /**
     * @notice Депозит VC токенов для продажи (ADMIN_ROLE)
     * @param amount Количество VC токенов
     */
    function depositVCTokens(uint256 amount) external onlyRole(ADMIN_ROLE) {
        require(amount > 0, "Amount must be positive");
        require(amount <= MAX_PURCHASE_AMOUNT * 10, "Deposit too large");
        
        IERC20 vcToken = IERC20(saleConfig.vcTokenAddress);
        
        // Проверяем allowance
        uint256 allowance = vcToken.allowance(msg.sender, address(this));
        require(allowance >= amount, "Insufficient allowance");
        
        bool success = vcToken.transferFrom(msg.sender, address(this), amount);
        require(success, "Transfer failed");
        
        saleConfig.totalVCAvailable += amount;
        
        emit SaleConfigUpdated(
            msg.sender,
            "totalVCAvailable",
            saleConfig.totalVCAvailable - amount,
            saleConfig.totalVCAvailable,
            block.timestamp
        );
    }

    /**
     * @notice Активация/деактивация продажи (MANAGER_ROLE)
     * @param _active Статус активности
     */
    function setSaleActive(bool _active) external onlyRole(MANAGER_ROLE) {
        bool oldValue = saleConfig.saleActive;
        saleConfig.saleActive = _active;
        
        emit SaleConfigUpdated(
            msg.sender,
            "saleActive",
            oldValue ? 1 : 0,
            _active ? 1 : 0,
            block.timestamp
        );
        
        emit SecurityEvent(
            msg.sender,
            "SaleStatus",
            _active ? "Sale activated" : "Sale deactivated",
            block.timestamp
        );
    }

    /**
     * @notice Обновление цены за VC с защитой от манипуляций (MANAGER_ROLE)
     * @param _newPrice Новая цена за 1 VC в wei BNB
     */
    function updatePrice(uint256 _newPrice) 
        external 
        onlyRole(MANAGER_ROLE) 
        priceUpdateCooldown 
    {
        require(_newPrice >= MIN_PRICE_PER_VC, "Price too low");
        require(_newPrice <= MAX_PRICE_PER_VC, "Price too high");
        
        uint256 currentPrice = saleConfig.pricePerVC;
        
        // Защита от резких изменений цены
        if (currentPrice > 0) {
            uint256 maxChange = currentPrice.mulDiv(MAX_PRICE_CHANGE_BPS, 10000);
            require(
                _newPrice <= currentPrice + maxChange && 
                _newPrice >= currentPrice - maxChange,
                "Price change too large"
            );
        }
        
        uint256 oldPrice = saleConfig.pricePerVC;
        saleConfig.pricePerVC = _newPrice;
        saleConfig.lastPriceUpdate = block.timestamp;
        
        emit PriceUpdateRequested(msg.sender, oldPrice, _newPrice, block.timestamp);
        emit SaleConfigUpdated(
            msg.sender,
            "pricePerVC",
            oldPrice,
            _newPrice,
            block.timestamp
        );
    }

    /**
     * @notice Blacklist пользователя (ADMIN_ROLE)
     * @param user Адрес пользователя
     * @param reason Причина блокировки
     */
    function blacklistUser(address user, string calldata reason) external onlyRole(ADMIN_ROLE) {
        require(user != address(0), "Invalid address");
        require(!hasRole(ADMIN_ROLE, user), "Cannot blacklist admin");
        
        blacklistedUsers[user] = true;
        
        emit UserBlacklisted(user, msg.sender, reason, block.timestamp);
        emit SecurityEvent(user, "Blacklisted", reason, block.timestamp);
    }

    /**
     * @notice Снятие с blacklist (ADMIN_ROLE)
     * @param user Адрес пользователя
     */
    function removeFromBlacklist(address user) external onlyRole(ADMIN_ROLE) {
        blacklistedUsers[user] = false;
        emit SecurityEvent(user, "RemovedFromBlacklist", "User rehabilitated", block.timestamp);
    }

    // ============================================
    // EMERGENCY FUNCTIONS
    // ============================================
    
    /**
     * @notice Аварийная остановка контракта (PAUSER_ROLE)
     */
    function emergencyPause() external onlyRole(PAUSER_ROLE) {
        _pause();
        emit EmergencyAction(msg.sender, "EmergencyPause", block.timestamp);
    }

    /**
     * @notice Возобновление работы контракта (ADMIN_ROLE)
     */
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
        emit EmergencyAction(msg.sender, "Unpause", block.timestamp);
    }

    /**
     * @notice Аварийное снятие застрявших токенов (EMERGENCY_ROLE)
     * @param token Адрес токена (address(0) для ETH/BNB)
     * @param amount Количество для снятия
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyRole(EMERGENCY_ROLE) {
        require(amount > 0, "Amount must be positive");
        
        if (token == address(0)) {
            // Снятие BNB
            require(address(this).balance >= amount, "Insufficient balance");
            payable(msg.sender).sendValue(amount);
        } else {
            // Снятие токенов
            IERC20 tokenContract = IERC20(token);
            require(tokenContract.balanceOf(address(this)) >= amount, "Insufficient token balance");
            
            bool success = tokenContract.transfer(msg.sender, amount);
            require(success, "Token transfer failed");
        }
        
        emit EmergencyAction(msg.sender, "EmergencyWithdraw", block.timestamp);
    }

    // ============================================
    // VIEW FUNCTIONS - Comprehensive Monitoring
    // ============================================
    
    /**
     * @notice Получение полной статистики продажи
     * @return totalVCAvailable Общее доступное количество VC
     * @return totalVCSold Общее проданное количество VC  
     * @return currentVCBalance Текущий баланс VC в контракте
     * @return pricePerVC Цена за 1 VC в wei BNB
     * @return saleActive Активна ли продажа
     * @return totalRevenue Общая выручка в BNB
     * @return dailySalesAmount Продано за сегодня
     * @return circuitBreakerActive Активен ли circuit breaker
     * @return salesInCurrentWindow Продажи в текущем окне
     */
    function getSaleStats() external view returns (
        uint256 totalVCAvailable,
        uint256 totalVCSold,
        uint256 currentVCBalance,
        uint256 pricePerVC,
        bool saleActive,
        uint256 totalRevenue,
        uint256 dailySalesAmount,
        bool circuitBreakerActive,
        uint256 salesInCurrentWindow
    ) {
        return (
            saleConfig.totalVCAvailable,
            saleConfig.totalVCSold,
            getAvailableVC(),
            saleConfig.pricePerVC,
            saleConfig.saleActive,
            saleConfig.totalVCSold.mulDiv(saleConfig.pricePerVC, 1e18),
            dailySales.amount,
            circuitBreaker.triggered,
            circuitBreaker.salesInWindow
        );
    }

    /**
     * @notice Получение статистики пользователя
     * @param user Адрес пользователя
     * @return purchasedVC Купленное количество VC
     * @return spentBNB Потраченное количество BNB
     * @return lastPurchaseTimestamp Время последней покупки
     * @return isBlacklisted Заблокирован ли пользователь
     * @return canPurchaseNext Когда можно совершить следующую покупку
     */
    function getUserStats(address user) external view returns (
        uint256 purchasedVC,
        uint256 spentBNB,
        uint256 lastPurchaseTimestamp,
        bool isBlacklisted,
        uint256 canPurchaseNext
    ) {
        return (
            userPurchasedVC[user],
            userSpentBNB[user],
            lastPurchaseTime[user],
            blacklistedUsers[user],
            lastPurchaseTime[user] + securityConfig.minTimeBetweenPurchases
        );
    }

    /**
     * @notice Проверка возможности покупки
     * @param user Адрес пользователя
     * @param vcAmount Количество VC для покупки
     * @return canPurchase Можно ли совершить покупку
     * @return reason Причина, если покупка невозможна
     */
    function canPurchase(address user, uint256 vcAmount) external view returns (
        bool canPurchase,
        string memory reason
    ) {
        if (!saleConfig.saleActive) return (false, "Sale not active");
        if (paused()) return (false, "Contract paused");
        if (circuitBreaker.triggered) return (false, "Circuit breaker active");
        if (blacklistedUsers[user]) return (false, "User blacklisted");
        if (vcAmount < saleConfig.minPurchaseAmount) return (false, "Below minimum");
        if (vcAmount > saleConfig.maxPurchaseAmount) return (false, "Above maximum");
        if (vcAmount > getAvailableVC()) return (false, "Insufficient VC available");
        
        // Проверка MEV защиты
        if (securityConfig.mevProtectionEnabled) {
            if (block.timestamp < lastPurchaseTime[user] + securityConfig.minTimeBetweenPurchases) {
                return (false, "Rate limited");
            }
        }
        
        // Проверка дневного лимита
        uint256 currentDate = block.timestamp / 86400;
        uint256 currentDailySales = (dailySales.date == currentDate) ? dailySales.amount : 0;
        if (currentDailySales + vcAmount > saleConfig.maxDailySales) {
            return (false, "Daily limit exceeded");
        }
        
        return (true, "");
    }

    // ============================================
    // INTERNAL HELPER FUNCTIONS
    // ============================================
    
    /**
     * @notice Конвертация uint256 в string
     * @param _i Число для конвертации
     * @return _uintAsString Строковое представление
     */
    function _uint2str(uint256 _i) internal pure returns (string memory _uintAsString) {
        if (_i == 0) {
            return "0";
        }
        uint256 j = _i;
        uint256 len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory bstr = new bytes(len);
        uint256 k = len;
        while (_i != 0) {
            k = k - 1;
            uint8 temp = (48 + uint8(_i - _i / 10 * 10));
            bytes1 b1 = bytes1(temp);
            bstr[k] = b1;
            _i /= 10;
        }
        return string(bstr);
    }

    // ============================================
    // UPGRADE AUTHORIZATION
    // ============================================
    
    /**
     * @notice Авторизация обновления для UUPS (только ADMIN_ROLE)
     * @param newImplementation Адрес новой реализации
     */
    function _authorizeUpgrade(address newImplementation) 
        internal 
        override 
        onlyRole(ADMIN_ROLE) 
    {
        require(newImplementation != address(0), "Invalid implementation");
        require(newImplementation.code.length > 0, "Implementation not a contract");
    }

    // ============================================
    // FALLBACK PROTECTION
    // ============================================
    
    /**
     * @notice Receive функция - отклоняет прямые переводы BNB
     */
    receive() external payable {
        revert("Direct BNB transfers not allowed. Use purchaseVC function.");
    }

    /**
     * @notice Fallback функция для неизвестных вызовов
     */
    fallback() external payable {
        revert("Function not found. Check contract interface.");
    }
}