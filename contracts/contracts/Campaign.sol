// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./access/Ownable.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IPoD} from "./interfaces/IPoD.sol";
import {ITransistorMinter} from "./interfaces/ITransistorMinter.sol";
import {Emission} from "./libraries/Emission.sol";

/// @title Campaign —— BEM 众筹挖矿单期合约
/// @notice 忠实实现前端 fixtures.js 的状态机与资金流：
///         funding → executing → mining；executing 子态 buying→listed→ready；
///         退出两条互不相交路径：份额转让（主动·仅 mining）+ 退款（被动安全阀·募资超时/流片失败）。
///
/// 关键设计（与前端 apply* 一一对应）：
///  - 多钱包账本：shares / escrow / claimed / refunded 均按地址记，收益 pending 按地址隔离（F1）。
///  - BNB 原子结算（F4）：认购款进 raisedBnb 托管；转让接收时买方 BNB 立即付给卖方；退款/流片从托管支出。
///  - execute 不可逆、仅 Owner（F3）：按锁定报价快照 priceLock 结算，买不起→判失败可退，成功清脏状态（F5）。
///  - 退款 per-wallet（F6）：refunded[addr] + 全局 totalRefunded 区分「你的」与「全网」。
contract Campaign is Ownable, ReentrancyGuard {
    using Emission for uint256;

    // ─────────────────────────── 状态机 ───────────────────────────
    enum Scene {
        Funding,
        Executing,
        Mining
    }
    enum Phase {
        None, // 非 executing 场景
        Buying, // 待挂单（买晶体管）
        Listed, // 挂单中（可取消）
        Ready // 晶体管已到账，待 execute
    }

    struct Listing {
        address seller;
        uint256 shares;
        uint256 priceBnbPerShare;
        bool open;
    }

    uint16 internal constant BPS = 10_000;

    // ─────────────────────── 不可变配置（开期写死） ───────────────────────
    uint256 public immutable sharePriceBnb; // 每份价格（wei）
    uint256 public immutable totalShares; // 总份数
    uint16 public immutable feeBps; // 服务费基点
    uint64 public immutable fundingDeadline; // 募集截止（unix 秒）
    address public immutable feeRecipient; // 收费地址
    uint256 public immutable taskId; // 官方题目
    bytes32 public immutable netlistHash; // 开期承诺的网表哈希
    uint64 public immutable executeDelay; // 售罄后观察期（秒）
    IPoD public immutable pod; // 挖矿合约
    IERC20 public immutable bem; // BEM 代币
    ITransistorMinter public immutable minter; // 晶体管二级市场铸造器

    // ─────────────────────── 可变状态 ───────────────────────
    Scene public scene;
    Phase public phase;
    uint256 public sold;
    uint64 public soldOutAt;
    bool public executionFailed;

    uint256 public raisedBnb; // 合约代持 BNB 池（认购款托管，与钱包余额隔离）
    uint256 public harvestCount;
    uint256 public totalDistributed; // 本期已分配给全部持有人的净 BEM（wei）
    uint256 public totalFeeCollected; // 累计服务费 BEM
    uint256 public totalClaimed; // 累计被领取 BEM
    uint256 public totalRefunded; // 累计退款 BNB（全网）

    uint256 public hashpower; // 实际算力 H（execute 成功后由 PoD 返回）
    uint256 public estHashpower; // 预估算力（开期设计值，未执行时展示）
    bool public capped; // 是否被挖矿闸门拦住（true → 未验证池）
    uint256 public transistorCount; // 需买入晶体管数（图纸元件数）
    uint256 public priceLock; // execute 锁定的报价快照（每颗 BNB）；0 = 未锁

    // 全网权重（oracle 更新，默认取链上实读值）
    uint256 public netWeightVerified;
    uint256 public netWeightUnverified;

    // ─────────────────────── 多钱包账本（F1/F4/F6） ───────────────────────
    mapping(address => uint256) private _shares; // 可用份额
    mapping(address => uint256) private _escrow; // 挂单锁定份额
    mapping(address => uint256) private _claimed; // 已领 BEM（按地址隔离）
    mapping(address => uint256) private _refunded; // 已退 BNB（按地址）

    Listing[] private _listings;

    // ─────────────────────── 事件 ───────────────────────
    event Bought(address indexed buyer, uint256 count, uint256 paidBnb);
    event Refunded(address indexed holder, uint256 amountBnb);
    event Listed(uint256 indexed id, address indexed seller, uint256 count, uint256 priceBnbPerShare);
    event ListingCancelled(uint256 indexed id, address indexed seller, uint256 shares);
    event ListingTaken(uint256 indexed id, address indexed buyer, address indexed seller, uint256 count, uint256 paidBnb);
    event TransistorOrderPlaced(uint256 count, uint256 unitPriceBnb);
    event TransistorOrderCancelled();
    event TransistorsConfirmed();
    event ExecutionFailed(uint256 needBnb, uint256 raisedBnb);
    event Executed(uint256 spentBnb, uint256 hashpower);
    event Harvested(uint256 round, uint256 grossBem, uint256 feeBem, uint256 netBem);
    event Claimed(address indexed holder, uint256 amountBem);
    event NetworkWeightUpdated(uint256 verified, uint256 unverified);
    event PlanUpdated(uint256 estHashpower, bool capped, uint256 transistorCount);

    // ─────────────────────── 自定义错误 ───────────────────────
    error DirectTransferNotAllowed();
    error WrongScene();
    error FundingEnded();
    error NotSoldOut();
    error ObservationPeriodActive(uint64 unlockAt);
    error NetlistMismatch();
    error TransistorsNotReady();
    error RefundNotAvailable();
    error NothingToClaim();
    error NoEmission();
    error ZeroShares();
    error ZeroPrice();
    error BadCount();
    error InsufficientShares();
    error ExceedsRemaining();
    error WrongPayment();
    error EscrowLocked();
    error NoListing();
    error NotSeller();
    error CannotTakeOwnListing();
    error AlreadyListed();
    error NotListed();
    error AlreadyReady();
    error TransferFailed();

    constructor(
        uint256 sharePriceBnb_,
        uint256 totalShares_,
        uint16 feeBps_,
        uint64 fundingDeadline_,
        address feeRecipient_,
        uint256 taskId_,
        address pod_,
        uint64 executeDelay_,
        address bem_,
        address minter_,
        bytes32 netlistHash_,
        address owner_,
        uint256 netWeightVerified_,
        uint256 netWeightUnverified_
    ) Ownable(owner_) {
        if (
            feeRecipient_ == address(0) || pod_ == address(0) || bem_ == address(0) || minter_ == address(0)
        ) revert ZeroAddress();
        if (totalShares_ == 0 || sharePriceBnb_ == 0) revert ZeroShares();
        sharePriceBnb = sharePriceBnb_;
        totalShares = totalShares_;
        feeBps = feeBps_;
        fundingDeadline = fundingDeadline_;
        feeRecipient = feeRecipient_;
        taskId = taskId_;
        pod = IPoD(pod_);
        executeDelay = executeDelay_;
        bem = IERC20(bem_);
        minter = ITransistorMinter(minter_);
        netlistHash = netlistHash_;
        scene = Scene.Funding;
        phase = Phase.None;
        netWeightVerified = netWeightVerified_;
        netWeightUnverified = netWeightUnverified_;
    }

    /// @dev 资金只准经由 buy / takeListing 进入，拒绝直接转账，保证 raisedBnb 记账精确。
    receive() external payable {
        revert DirectTransferNotAllowed();
    }

    // ─────────────────────────── 产出口径 ───────────────────────────

    /// @notice 本矿机日产 BEM（wei）。execute 前为 0。
    function dailyBem() public view returns (uint256) {
        return Emission.dailyBem(hashpower, capped, netWeightVerified, netWeightUnverified);
    }

    /// @notice 某地址当前可领 BEM（F1：按地址隔离）。
    ///         pending = 每轮净产出 × 领取轮数 × 该地址份额占比 − 该地址已领。
    function pendingBem(address account) public view returns (uint256) {
        if (scene != Scene.Mining || totalShares == 0) return 0;
        uint256 daily = dailyBem();
        if (daily == 0) return 0;
        uint256 netPerRound = (daily * (BPS - feeBps)) / BPS;
        uint256 accrued = (netPerRound * harvestCount * _shares[account]) / totalShares;
        uint256 done = _claimed[account];
        return accrued > done ? accrued - done : 0;
    }

    /// @notice 更新全网权重（oracle）。零和机制下权重持续变化，需定期刷新。
    function updateNetworkWeight(uint256 verified, uint256 unverified) external onlyOwner {
        netWeightVerified = verified;
        netWeightUnverified = unverified;
        emit NetworkWeightUpdated(verified, unverified);
    }

    /// @notice 设定开期图纸派生量：预估算力、是否被闸门拦住、需买入晶体管数。execute 前由 Owner 设定一次。
    function setPlan(uint256 estHashpower_, bool capped_, uint256 transistorCount_) external onlyOwner {
        estHashpower = estHashpower_;
        capped = capped_;
        transistorCount = transistorCount_;
        emit PlanUpdated(estHashpower_, capped_, transistorCount_);
    }

    // ─────────────────────────── 认购 ───────────────────────────

    /// @notice 按整数份认购，支付 count × sharePriceBnb BNB。自然售罄即进入待执行并启动观察期。
    function buy(uint256 count) external payable nonReentrant {
        if (scene != Scene.Funding) revert WrongScene();
        if (block.timestamp > fundingDeadline) revert FundingEnded();
        if (count == 0) revert ZeroShares();
        if (sold + count > totalShares) revert ExceedsRemaining();
        if (msg.value != count * sharePriceBnb) revert WrongPayment();

        _shares[msg.sender] += count;
        sold += count;
        raisedBnb += msg.value;

        if (sold == totalShares) {
            scene = Scene.Executing;
            phase = Phase.Buying;
            soldOutAt = uint64(block.timestamp);
        }
        emit Bought(msg.sender, count, msg.value);
    }

    // ─────────────────────────── 退款（被动安全阀） ───────────────────────────

    /// @notice 原路退还本金：仅「募集中 + 超过截止仍未售罄」或「待执行 + 已判流片失败」可调。
    ///         退还 count × sharePriceBnb、份额清零、已售份数回退、BNB 退回认购地址。
    function refund() external nonReentrant {
        bool fundingExpired = scene == Scene.Funding && block.timestamp > fundingDeadline;
        bool execFailed = scene == Scene.Executing && executionFailed;
        if (!fundingExpired && !execFailed) revert RefundNotAvailable();

        uint256 s = _shares[msg.sender];
        if (s == 0) revert ZeroShares();
        if (_escrow[msg.sender] != 0) revert EscrowLocked();

        uint256 amount = s * sharePriceBnb;
        _shares[msg.sender] = 0;
        sold -= s;
        raisedBnb -= amount;
        _refunded[msg.sender] += amount;
        totalRefunded += amount;

        _send(msg.sender, amount);
        emit Refunded(msg.sender, amount);
    }

    // ─────────────────────────── 份额转让（唯一主动退出，仅 mining） ───────────────────────────

    /// @notice 发布出售挂单：挂出份额立即从可用余额锁定到 escrow，不能领取/转让，直到卖出或撤单。
    function listShares(uint256 count, uint256 priceBnbPerShare) external {
        if (scene != Scene.Mining) revert WrongScene();
        if (count == 0) revert ZeroShares();
        if (priceBnbPerShare == 0) revert ZeroPrice();
        if (_shares[msg.sender] < count) revert InsufficientShares();

        _shares[msg.sender] -= count;
        _escrow[msg.sender] += count;
        _listings.push(Listing({seller: msg.sender, shares: count, priceBnbPerShare: priceBnbPerShare, open: true}));
        emit Listed(_listings.length - 1, msg.sender, count, priceBnbPerShare);
    }

    /// @notice 撤销自己的挂单，释放锁定份额回可用余额。仅挂单方或 Owner。
    function cancelListing(uint256 id) external {
        if (scene != Scene.Mining) revert WrongScene();
        if (id >= _listings.length || !_listings[id].open) revert NoListing();
        Listing storage l = _listings[id];
        if (msg.sender != l.seller && msg.sender != owner) revert NotSeller();

        l.open = false;
        _escrow[l.seller] -= l.shares;
        _shares[l.seller] += l.shares;
        emit ListingCancelled(id, l.seller, l.shares);
    }

    /// @notice 接收（买入）挂单：份额过户到买方，买方 BNB 立即付给卖方（原子结算，不进合约托管）。
    function takeListing(uint256 id, uint256 count) external payable nonReentrant {
        if (scene != Scene.Mining) revert WrongScene();
        if (id >= _listings.length || !_listings[id].open) revert NoListing();
        Listing storage l = _listings[id];
        if (msg.sender == l.seller) revert CannotTakeOwnListing();
        if (count == 0 || count > l.shares) revert BadCount();

        uint256 pay = count * l.priceBnbPerShare;
        if (msg.value != pay) revert WrongPayment();

        _escrow[l.seller] -= count;
        _shares[msg.sender] += count;
        l.shares -= count;
        if (l.shares == 0) l.open = false;

        _send(l.seller, pay); // BNB 实时付给卖方
        emit ListingTaken(id, msg.sender, l.seller, count, pay);
    }

    // ─────────────────────────── 晶体管二级市场挂单（仅 Owner） ───────────────────────────

    /// @notice Owner 手动调用 tapeout.net 挂单逻辑：记录锁定报价快照，进入「挂单中」。
    function placeTransistorOrder(uint256 count, uint256 unitPriceBnb) external onlyOwner {
        if (scene != Scene.Executing) revert WrongScene();
        if (phase == Phase.Ready) revert AlreadyReady();
        if (phase == Phase.Listed) revert AlreadyListed();
        if (count == 0 || unitPriceBnb == 0) revert ZeroShares();

        transistorCount = count;
        priceLock = unitPriceBnb; // 锁定报价快照
        phase = Phase.Listed;
        emit TransistorOrderPlaced(count, unitPriceBnb);
    }

    /// @notice 取消挂单，回到待挂单并清空锁价。
    function cancelTransistorOrder() external onlyOwner {
        if (scene != Scene.Executing) revert WrongScene();
        if (phase != Phase.Listed) revert NotListed();

        phase = Phase.Buying;
        transistorCount = 0;
        priceLock = 0;
        emit TransistorOrderCancelled();
    }

    /// @notice 确认成交到账，解锁 execute。priceLock 保留为锁定快照。
    function confirmTransistors() external onlyOwner {
        if (scene != Scene.Executing) revert WrongScene();
        if (phase == Phase.Ready) revert AlreadyReady();
        if (phase != Phase.Listed) revert NotListed();

        phase = Phase.Ready;
        emit TransistorsConfirmed();
    }

    // ─────────────────────────── 流片开矿（不可逆，仅 Owner） ───────────────────────────

    /// @notice 换币 + 流片 + 开户挖矿。按锁定报价快照结算：
    ///         买不起 → 判 executionFailed、留在待执行、本金未动、可原路退还（清锁价允许降价重试）；
    ///         买得起 → 支出募集款买入晶体管并烧掉、流片开户，进入 mining（F5 清脏状态）。
    function execute(bytes calldata tapeoutData, bytes calldata startData) external onlyOwner nonReentrant {
        if (scene != Scene.Executing) revert WrongScene();
        if (sold < totalShares) revert NotSoldOut();
        if (phase != Phase.Ready) revert TransistorsNotReady();
        if (block.timestamp < uint256(soldOutAt) + executeDelay) {
            revert ObservationPeriodActive(soldOutAt + executeDelay);
        }
        if (keccak256(tapeoutData) != netlistHash) revert NetlistMismatch();

        uint256 cost = transistorCount * priceLock; // 锁定报价快照结算
        if (cost > raisedBnb) {
            executionFailed = true;
            priceLock = 0; // 清锁价，允许元件降价后由 Owner 重试
            emit ExecutionFailed(cost, raisedBnb);
            return;
        }

        raisedBnb -= cost;
        ITransistorMinter(minter).mint{value: cost}(transistorCount); // 买入晶体管并烧掉
        uint256 hp = IPoD(pod).start(startData); // 流片开户，返回权重
        hashpower = hp;
        scene = Scene.Mining;
        phase = Phase.None;
        executionFailed = false; // F5：清脏状态
        harvestCount = 0;
        emit Executed(cost, hp);
    }

    // ─────────────────────────── 领取 / 分发 ───────────────────────────

    /// @notice 全网分发一轮：从 PoD 拉取当日 BEM，扣服务费打给收费地址，净额按份累计给全部持有人。
    ///         领取次数不设上限，只要还在出矿（日产 > 0）即可一直分发。
    function harvest() external nonReentrant {
        if (scene != Scene.Mining) revert WrongScene();
        uint256 daily = dailyBem();
        if (daily == 0) revert NoEmission();

        harvestCount += 1;
        uint256 fee = (daily * feeBps) / BPS;
        uint256 net = daily - fee;
        totalFeeCollected += fee;
        totalDistributed += net;

        uint256 pulled = IPoD(pod).claim(); // 拉取本日产 BEM 到本合约
        uint256 feeToSend = fee <= pulled ? fee : pulled;
        if (feeToSend > 0 && feeRecipient != address(0)) {
            bem.transfer(feeRecipient, feeToSend);
        }
        emit Harvested(harvestCount, daily, feeToSend, net);
    }

    /// @notice 领取本钱包已累计的 BEM（F1：只领自己的 pending）。
    function claim() external nonReentrant returns (uint256) {
        if (scene != Scene.Mining) revert WrongScene();
        uint256 pending = pendingBem(msg.sender);
        if (pending == 0) revert NothingToClaim();
        uint256 bal = bem.balanceOf(address(this));
        uint256 amount = pending <= bal ? pending : bal;
        if (amount == 0) revert NothingToClaim();

        _claimed[msg.sender] += amount;
        totalClaimed += amount;
        bem.transfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
        return amount;
    }

    // ─────────────────────────── 视图 ───────────────────────────

    function status() external view returns (Scene) {
        return scene;
    }

    function executePhase() external view returns (Phase) {
        return phase;
    }

    function sharesOf(address account) external view returns (uint256) {
        return _shares[account];
    }

    function escrowOf(address account) external view returns (uint256) {
        return _escrow[account];
    }

    function claimedOf(address account) external view returns (uint256) {
        return _claimed[account];
    }

    function refundedOf(address account) external view returns (uint256) {
        return _refunded[account];
    }

    function listingCount() external view returns (uint256) {
        return _listings.length;
    }

    function getListing(uint256 id) external view returns (Listing memory) {
        if (id >= _listings.length) revert NoListing();
        return _listings[id];
    }

    // ─────────────────────────── 内部 ───────────────────────────

    function _send(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
