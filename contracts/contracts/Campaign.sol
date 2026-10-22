// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./access/Ownable.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";
import {IERC1155} from "./interfaces/IERC1155.sol";
import {IMaterialMarket} from "./interfaces/IMaterialMarket.sol";

/// @title Campaign — one BEM crowdfunding round
/// @notice Scenes: Funding → Executing → Mining. Executing phases: Buying → Listed → Ready.
///
/// Funds:
///  - Subscription BNB sits in raisedBnb. Subscribe is still allowed at the exact deadline.
///    After the deadline, if the round is not sold out, each subscriber calls refund.
///  - The owner spends raisedBnb on material-market placeBid. Sellers fillBid and parts arrive
///    as ERC1155. If the bid is unaffordable the tx succeeds, sets executionFailed, and does not
///    place. Only the market may refund escrow via receive.
///  - Share transfer (listShares / takeListing / cancelListing) is Mining-only. Buyer BNB is paid
///    straight to the seller, not into raisedBnb.
///
///  NOTE: tape-out (流片) and PoD mining have been REMOVED. In their place, an owner commits the
///  round's transistors into a mining pool via depositToPool() — an IRREVERSIBLE action that transfers
///  the held ERC1155 parts to `miningPool`, returns any unspent subscription BNB to holders (shares kept),
///  and moves the round into the Mining scene. harvest() / claim() remain placeholders: the Mining scene is
///  now reachable, but no BEM distribution is implemented yet, so they no-op / return 0.
interface IFactory {
    function isRegistered(address campaign) external view returns (bool);
}

contract Campaign is Ownable, ReentrancyGuard {
    /// @notice Factory that created this round. Read for registry membership (see receive / cancelTransistorOrder).
    address public immutable factory;

    // ─────────────────────────── state machine ───────────────────────────
    enum Scene {
        Funding,
        Executing,
        Mining
    }
    enum Phase {
        None, // not Executing
        Buying, // ready to place transistor bids
        Listed, // bids live; cancel still allowed
        Ready // parts filled; waiting for execute
    }

    struct Listing {
        address seller;
        uint256 shares;
        uint256 priceBnbPerShare;
        bool open;
    }

    uint256 internal constant FAIL_GRACE = 3 days;
    /// @notice 服务费硬上限（基点）。1000 = 10%。
    ///         ⚠️ **口径澄清（必须记住）**：本期的「服务费」是**挖矿产出奖励的服务费**，
    ///         它只在矿池把挖矿收益打进 depositRevenue() 时从**收益**里计提，
    ///         **与认筹款（subscribe 付的 BNB）完全无关**。
    ///         认购人付的 BNB 全额进 raisedBnb（认购托管池），只用于买元件，
    ///         链上**不存在**任何从认购款里抽服务费的路径。
    ///         所以这个上限约束的是「最多从挖矿产出里抽走 10% 给服务费收款方」，
    ///         **不是**「不能吃掉认购款」。
    uint16 internal constant MAX_SERVICE_FEE_BPS = 1000;
    /// @notice 服务费分成表最多几个地址。限制数组长度，避免计提时的循环把 gas 撑爆。
    ///         T-72：8 → 3。分成表每多一个地址都要多存一份地址 + 份额，
    ///         而常见场景就是「一个人独享」或「平台 + 创始人」两三个地址。
    ///         3 个已足够，且链上字节与循环成本都更低。
    uint256 internal constant MAX_FEE_RECIPIENTS = 3;

    // ─────────────────────── immutable config (fixed at creation) ───────────────────────
    uint256 public immutable sharePriceBnb; // price per share (wei)
    uint256 public immutable totalShares; // share cap
    uint64 public immutable fundingDeadline; // funding deadline (unix seconds)
    /// @notice Official ERC1155 parts contract for this round (TapeOut or Behemoth processor parts).
    ///         Locked at create; placeBid uses it. The processor model is fixed here, not chosen per order.
    address public immutable transistors;
    /// @notice Material market (placeBid / cancelBid / bids). Testnets may use a matching mock.
    IMaterialMarket public market;
    /// @notice Mining pool address. Owner-set before depositToPool(); the held transistors are sent here
    ///         irreversibly. May be any ERC1155-receiving contract (must implement onERC1155Received).
    address public miningPool;

    // ─────────────────────── mutable state ───────────────────────
    Scene public scene;
    Phase public phase;
    /// @notice 本期**累计**售出的份数。只在 subscribe 里增加，**退款不会让它变小**。
    ///         为什么要单调：owner 下单的闸门是「本期必须售罄」（sold == totalShares）。
    ///         退款原本会递减 sold，于是任何一个持份人退款后，owner 就永久失去下单资格
    ///         （H-1 后半）。改成单调后，退款只影响 outstandingShares，owner 的执行资格不受影响。
    uint256 public sold;
    /// @notice 已售出但**尚未退款**的份数。退款时递减；按比例退款的分母就是它。
    ///         与 sold 的差别：sold 记「卖出去过多少」（历史事实），outstandingShares 记「还欠多少人」（当前债务）。
    uint256 public outstandingShares;
    /// @notice 本期服务费率（基点，1/10000）。0 = 不收。
    ///         由开期人在**尚无人认购时**通过 setServiceFee 设定并固定下来，
    ///         链上前端可读 —— 不再是前端本地记录（口径反转：服务费真正上链）。
    ///
    ///         ⚠️ **口径澄清（勿回退）**：本字段是**挖矿产出奖励的服务费率**。
    ///         它只在 depositRevenue()（矿池把挖矿收益打进来）时从**收益**里计提，
    ///         **与认筹款无关** —— subscribe() 收的 BNB 全额进 raisedBnb，
    ///         链上不存在从认购款抽服务费的任何路径。
    uint16 public serviceFeeBps;
    /// @notice 服务费分成地址（多地址分成表）。长度 = feeRecipientCount()。
    address[] private _feeRecipients;
    /// @notice 各分成地址的份额（基点，合计 10000）。与 _feeRecipients 一一对应。
    uint16[] private _feeSharesBps;
    /// @notice 各分成地址已计提但未领取的服务费。收款方自己调 claimFee() 领（pull 模式）。
    mapping(address => uint256) public pendingFee;
    /// @notice pendingFee 的总额。recoverBnb 必须把它留出来，否则 owner 会吞掉收款方的服务费。
    uint256 public totalPendingFee;
    /// @notice 服务费是否已被设定过。设定后（哪怕 bps = 0）不再允许修改。
    bool public serviceFeeSet;
    uint64 public soldOutAt;
    /// @notice 最后一次 placeTransistorOrder 的时间戳。非 owner 调用 markFailed 的宽限期从它算起。
    uint64 public lastOrderAt;
    bool public executionFailed;
    /// @notice True once the held transistors have been committed to the mining pool. Irreversible:
    ///         no function pulls them back, and refund / abandon / recover escape hatches are closed.
    bool public pooled;

    uint256 public raisedBnb; // subscription escrow. Bids debit it; market refunds credit it via receive
    uint256 public totalRefunded; // cumulative refunded BNB (all wallets)
    /// @notice 累计已支付出去的服务费（wei）。
    uint256 public totalFeesPaid;
    /// @notice 挖矿收益池：矿池打进来的收益，扣掉服务费后的净额。
    ///         分配给持份人的逻辑等矿池接口就绪后在 harvest()/claim() 里实现（当前是占位）。
    ///         ⚠️ 这个池子装的是**挖矿产出**，不是认筹款。认筹款在 raisedBnb 里。
    uint256 public revenuePool;

    uint256 public priceLock; // total bid escrow (wei), not a unit price. 0 = no live order
    uint256 public nandBidId;
    uint256 public latchBidId;
    uint256 public nandQty;
    uint256 public latchQty;
    uint96 public nandPrice; // locked NAND bid price. display-only: read off-chain via getter; never read in on-chain logic
    uint96 public latchPrice; // locked LATCH bid price. display-only: read off-chain via getter; never read in on-chain logic
    /// @notice Sell-side ask ids after a partial buy. Used to cash out parts already on hand before refund.
    uint256 public nandAskId;
    uint256 public latchAskId;
    uint256 public nandAskQty;
    uint256 public latchAskQty;
    uint96 public nandAskPrice; // live NAND ask price. display-only: read off-chain via getter; never read in on-chain logic
    uint96 public latchAskPrice; // live LATCH ask price. display-only: read off-chain via getter; never read in on-chain logic
    uint256 public estHashpower; // design estimate. display-only: read off-chain via getter; never read in on-chain logic

    // ─────────────────────── per-wallet ledger ───────────────────────
    mapping(address => uint256) private _shares; // available shares
    mapping(address => uint256) private _escrow; // shares locked in a listing
    mapping(address => uint256) private _refunded; // BNB already refunded to this wallet
    /// @notice 入池时未发出去的余款（按份应得但转账失败）。持份人可自行 claimSurplus() 领取。
    mapping(address => uint256) public pendingSurplus;

    /// @notice pendingSurplus 的总额。recoverBnb 在「sold == 0」分支会扫走整个余额，
    ///         必须先把这笔钱留出来，否则 owner 会吞掉持份人尚未领取的余款。
    uint256 public totalPendingSurplus;
    /// @notice 入池时可分配的余款总额（= 入池瞬间的 raisedBnb）。它是按份计算的**分子基准**，不随退款变化。
    uint256 public surplusPool;
    /// @notice 余款分配的份额分母（= 入池瞬间的 outstandingShares）。持份人后来增减不影响已定基准。
    uint256 public surplusBase;
    /// @notice 已经按份算过账的份数（用于把取整尾差交给最后一位来领，保证分毫不差地发完）。
    uint256 public surplusClaimedShares;
    /// @notice 已经按份「分配」出去的总额（= 已计提给各持份人但未必已转账，含 pendingSurplus 里的）。
    ///         分配口径必须与 surplusPaid 分开：计提发生在 accrue，转账发生在 claim。
    uint256 public surplusAllocated;
    /// @notice 已经真正转给持份人的余款总额。owner 扫钱时用 surplusPool − surplusPaid 算「还欠多少」。
    uint256 public surplusPaid;
    /// @notice 每个持份人已经计入余款分配的份数。用于防止同一个人重复领取。
    mapping(address => uint256) public surplusCounted;
    address[] private _holders; // subscribers and listing buyers. openRefund and surplus use this list
    // NOTE: 只增不减（已退款 / 已领完的地址仍留在数组里），因为 _holders 的下标被 holderAt() 暴露给前端。
    // 代价是 _refundAll / _returnSurplus 每次全量遍历：每条约 2.1k gas（冷 SLOAD），
    // 即 1,000 个地址约 2.1M gas、10,000 个约 21M gas——会逼近区块 gas 上限。
    // 单期份数天然有上限（totalShares 由开期人定），目前够用；
    // 若将来要让 owner 能给上万地址退款，需改成可分批的 pull 退款（分段游标）而不是继续加长这个数组。
    mapping(address => bool) private _holderSeen;

    Listing[] private _listings;
    /// @dev 曾担任过本期末次市场的地址。receive() 接受其中任何一个的打款——
    ///      市场结算/撤单是异步的，只认当前 market 会把迟到的款项永久拒收。
    address[] private _marketHistory;

    // ─────────────────────── events ───────────────────────
    event Subscribed(address indexed subscriber, uint256 count, uint256 paidBnb);
    event Refunded(address indexed holder, uint256 amountBnb);
    event Listed(uint256 indexed id, address indexed seller, uint256 count, uint256 priceBnbPerShare);
    event ListingCancelled(uint256 indexed id, address indexed seller, uint256 shares);
    event ListingTaken(uint256 indexed id, address indexed buyer, address indexed seller, uint256 count, uint256 paidBnb);
    /// @notice The second argument is total escrowed BNB, not a unit price. The name is kept for the old ABI.
    event TransistorOrderPlaced(uint256 count, uint256 unitPriceBnb);
    event TransistorOrderCancelled();
    event TransistorAskPlaced(uint256 nandQty, uint256 latchQty, uint256 nandAskId, uint256 latchAskId);
    event TransistorAskCancelled();
    event TransistorsConfirmed();
    /// @notice needBnb is the bid escrow that could not be paid. openRefund emits 0. The tx does not revert.
    event ExecutionFailed(uint256 needBnb, uint256 raisedBnb);
    event RefundSendFailed(address indexed holder, uint256 amountBnb);
    event PlanUpdated(uint256 estHashpower);
    event MaterialMarketUpdated(address indexed previous, address indexed next);
    /// @notice The operator approval granted to a former material market was revoked.
    event MaterialMarketApprovalRevoked(address indexed market);
    /// @notice Owner escape hatch: BNB pulled out of the campaign. `to` is the owner.
    event BnbRecovered(uint256 amount, address indexed to);
    /// @notice Owner escape hatch: ERC1155 parts pulled out so they are not left in the campaign. `to` is the owner.
    event TransistorsRecovered(address indexed token, uint256 indexed id, uint256 amount, address indexed to);
    /// @notice Mining pool address was set / changed by the owner.
    event MiningPoolSet(address indexed previous, address indexed next);
    /// @notice The round's transistors were committed to the mining pool. IRREVERSIBLE.
    event DepositedToPool(address indexed pool, uint256 nandAmount, uint256 latchAmount);
    /// @notice The Executing sub-phase changed. Emitted by every path that writes `phase`.
    /// @dev 前端不能只靠事件驱动状态——但有事件总比没有强：
    ///      setPhase 之前**不发任何事件**，链下监控与前端完全看不到这一步被推过。
    event PhaseChanged(uint8 indexed previous, uint8 indexed next);
    /// @notice The round's sale order was settled and the proceeds pulled. The phase returns to Buying.
    event AskSettled(uint256 proceeds);

    // ─────────────────────── errors ───────────────────────
    error DirectTransferNotAllowed();
    error WrongScene();
    error FundingEnded();
    error NotSoldOut();
    error TransistorsNotReady();
    error RefundNotAvailable();
    error ZeroShares();
    error ZeroPrice();
    error BadCount();
    error InsufficientShares();
    error ExceedsRemaining();
    error WrongPayment();
    error NoListing();
    error NotSeller();
    error CannotTakeOwnListing();
    error AlreadyListed();
    error NotListed();
    error AlreadyReady();
    error TransferFailed();
    error OrderFilled();
    error BadBidId();
    error BadAskId();
    error AlreadyAsked();
    error NotAsked();
    error InsufficientParts();
    error PoolNotSet();
    error AlreadyPooled();
    /// @notice The transistors argument does not match the parts contract locked at creation.
    error WrongTransistors();
    /// @notice Service-fee configuration is invalid (bps over the hard ceiling, mismatched table
    ///         lengths, duplicate recipients, zero address, or shares that do not sum to 10000).
    error BadFeeConfig();
    /// @notice The service-fee table was already set. It is frozen forever once written.
    error ServiceFeeAlreadySet();
    /// @notice The service fee can no longer be changed because somebody already subscribed.
    error ServiceFeeLocked();
    /// @notice The round is not sold out. Owner may not clear a round that subscribers can still exit from.
    error NotSoldOutYet();
    /// @notice Surplus was accrued to a holder. Amount is now claimable via claimSurplus().
    event SurplusAccrued(address indexed holder, uint256 amountBnb);
    /// @notice Service-fee configuration was set. Only settable while nobody has subscribed yet.
    event ServiceFeeSet(uint16 feeBps, address[] recipients, uint16[] sharesBps);
    /// @notice A service-fee share was accrued to a recipient. The recipient pulls it via claimFee().
    event FeeAccrued(address indexed to, uint256 amount);
    /// @notice Mining revenue was deposited into the round. `fee` was withheld, `net` went to the revenue pool.
    event RevenueDeposited(uint256 gross, uint256 fee, uint256 net);
    /// @notice A service-fee share was paid out at claimFee() time.
    event FeePaid(address indexed to, uint256 amount);

    /// @param materialMarket_ Material-market address. Stored in the `market` state var; read it via market().
    /// @param transistors_ Official ERC1155 parts contract for this round (TapeOut or Behemoth processor parts).
    ///        Locked at create; placeBid uses it. The processor model is fixed here, not chosen per order.
    constructor(
        uint256 sharePriceBnb_,
        uint256 totalShares_,
        uint64 fundingDeadline_,
        address materialMarket_,
        address owner_,
        address transistors_
    ) Ownable(owner_) {
        if (materialMarket_ == address(0) || transistors_ == address(0)) revert ZeroAddress();
        factory = msg.sender;
        if (totalShares_ == 0 || sharePriceBnb_ == 0) revert ZeroShares();
        sharePriceBnb = sharePriceBnb_;
        totalShares = totalShares_;
        fundingDeadline = fundingDeadline_;
        market = IMaterialMarket(materialMarket_);
        transistors = transistors_;
        scene = Scene.Funding;
        phase = Phase.None;
    }

    /// @dev Only the material market may push BNB into this contract, and every legitimate inbound transfer comes
    ///      from it:
    ///      - an unfilled bid leg is cancelled (placeTransistorOrder / abandonOrder / cancelTransistorOrder / markFailed
    ///        call market.cancelBid), whose escrow refund returns here and is credited to raisedBnb;
    ///      - the market settles an ask or pays an owed balance (market.withdraw / fill settlement).
    ///      No other address may send BNB. An arbitrary deposit would inflate raisedBnb and break the
    ///      "contract BNB balance == escrow pool" invariant that refund() depends on,
    ///      letting a stranger over-claim from the pool. A retired round's cancelBid refund still originates from
    ///      the market, so it is accepted here the same way — the factory registry state changes nothing.
    receive() external payable {
        // 接受**任何曾经是本期末次市场**的地址，不只是当前 market。
        //
        // 为什么要历史：市场结算/撤单/提取是异步的。owner 若在款项到账前调了 setMaterialMarket，
        // 那笔钱会被 DirectTransferNotAllowed 拒收——BSC 上不可追回，
        // 用户本金就永久卡在旧市场里（合约里没有任何函数能取回它）。
        if (!_isKnownMarket(msg.sender)) revert DirectTransferNotAllowed();
        raisedBnb += msg.value;
    }

    /// @dev The factory registry is this round's only source of writes. A reverting call counts as retired.
    function _retired() internal view returns (bool) {
        try IFactory(factory).isRegistered(address(this)) returns (bool live) {
            return !live;
        } catch {
            return true;
        }
    }

    /// @dev 该地址是否曾经担任过本期的材料市场。
    function _isKnownMarket(address who) internal view returns (bool) {
        if (who == address(market)) return true;
        for (uint256 i = 0; i < _marketHistory.length; i++) {
            if (_marketHistory[i] == who) return true;
        }
        return false;
    }

    /// @notice Replace the material market (official placeBid contract, or a matching test mock).
    ///
    ///         ⚠️ 加严说明（主网前）：
    ///         原来这个函数**没有任何阶段限制**，也不撤销旧市场的 operator 授权。
    ///         两个后果：
    ///           1. 在 Listed 阶段换市场 → 撤单路径全部改调新市场的 cancelBid，
    ///              而 bid 在旧市场上。要么新市场没有这个 bid 而 revert，
    ///              要么旧市场的 cancelBid 把 BNB 退回来却被 receive() 拒收——
    ///              **用户的全部认购款永久留在旧市场里，合约内没有任何函数能取回**。
    ///           2. 换市场后，此前 placeTransistorAsk 给旧市场授的 setApprovalForAll 永久保留，
    ///              旧市场可以随时把合约持有的 ERC1155 拿走。
    ///         现在：有挂单或有卖单时禁止换；换的时候把旧市场的授权撤销。
    function setMaterialMarket(address materialMarket_) external onlyOwner {
        if (materialMarket_ == address(0)) revert ZeroAddress();
        // 有活跃挂单 / 卖单时换市场 = 把 escrow 丢在旧市场里。必须先撤干净。
        if (phase == Phase.Listed) revert AlreadyListed();
        if (_askOpen()) revert AlreadyAsked();
        // 旧市场的 operator 授权要撤销，否则它随时能拿走本期的 ERC1155。
        // revoke 失败不阻断换市场（老市场可能没实现 / 已自毁），但要留下痕迹。
        address previous = address(market);
        if (previous != materialMarket_) {
            _revokeApproval(previous);
        }
        emit MaterialMarketUpdated(previous, materialMarket_);
        market = IMaterialMarket(materialMarket_);
        if (previous != materialMarket_) {
            _marketHistory.push(previous);
        }
    }

    /// @dev 撤销对某市场 operator 授权。失败静默——老市场可能不认这个调用。
    function _revokeApproval(address operator) internal {
        if (operator == address(0)) return;
        try IERC1155(transistors).setApprovalForAll(operator, false) {
            emit MaterialMarketApprovalRevoked(operator);
        } catch {
            // 忽略：老市场 / 已弃用的元件合约不实现 setApprovalForAll。
        }
    }

    /// @notice Set the mining pool destination. Owner only, and only before the transistors are pooled.
    ///         depositToPool() reverts with PoolNotSet() until this is a non-zero address.
    function setMiningPool(address pool_) external onlyOwner {
        if (pooled) revert AlreadyPooled();
        if (pool_ == address(0) || pool_ == address(this)) revert ZeroAddress();
        emit MiningPoolSet(miningPool, pool_);
        miningPool = pool_;
    }

    /// @notice Set the display estimate. Writable in Funding, and in Executing only while Buying.
    ///         Not writable in Listed, Ready, or Mining.
    ///         Part count is not a parameter: the live order quantity is whatever placeTransistorOrder writes.
    ///         This function does not place a bid.
    function setPlan(uint256 estHashpower_) external onlyOwner {
        if (scene == Scene.Mining) revert WrongScene();
        if (scene == Scene.Executing && phase != Phase.Buying) revert WrongScene();
        estHashpower = estHashpower_;
        emit PlanUpdated(estHashpower_);
    }

    // ─────────────────────────── subscribe ───────────────────────────

    /// @notice Buy an integer number of shares. msg.value must equal count × sharePriceBnb.
    ///         Subscribe is still allowed when timestamp == fundingDeadline. A sell-out moves the round to Executing / Buying.
    ///
    ///         ⚠️ **认筹款不收服务费（口径澄清，勿回退）**：
    ///         这里的 BNB **全额**进 raisedBnb（认购托管池），只用于买元件。
    ///         本期的「服务费」是**挖矿产出奖励的服务费**，只在 depositRevenue() 里从
    ///         矿池打进来的收益中计提 —— 与本函数收的认筹款**完全无关**。
    ///         链上**不存在**从认筹款抽服务费的路径，认购人付多少就全额进池子。
    function subscribe(uint256 count) external payable nonReentrant {
        if (scene != Scene.Funding) revert WrongScene();
        if (block.timestamp > fundingDeadline) revert FundingEnded();
        if (count == 0) revert ZeroShares();
        if (sold + count > totalShares) revert ExceedsRemaining();
        if (msg.value != count * sharePriceBnb) revert WrongPayment();

        _shares[msg.sender] += count;
        sold += count;
        outstandingShares += count;
        raisedBnb += msg.value;
        _trackHolder(msg.sender);

        if (sold == totalShares) {
            scene = Scene.Executing;
            _setPhase(Phase.Buying);
            soldOutAt = uint64(block.timestamp);
        }
        emit Subscribed(msg.sender, count, msg.value);
    }

    // ─────────────────────────── service fee (on-chain) ───────────────────────────

    /// @notice Set this round's service fee and its multi-recipient split table. Owner only.
    ///         Only allowed while **nobody has subscribed yet** (sold == 0). After that it is frozen
    ///         forever — subscribers must be able to trust the numbers they saw when they subscribed.
    ///         0 bps with an empty table = no fee (the default for a round nobody configures).
    ///
    ///         ⚠️ **服务费是什么、不是什么（口径澄清，勿回退）**：
    ///           - 是：**挖矿产出奖励的服务费**。从矿池打进来的挖矿收益里按比例计提。
    ///           - 不是：**认筹款（认购款）的服务费**。认购人付的 BNB **全额**进 raisedBnb
    ///             （认购托管池），只用于买元件。链上**不存在**任何从认购款抽服务费的路径，
    ///             也不存在「服务费吃掉认购款」这回事。
    ///         收取点唯一：depositRevenue()（仅 miningPool 可调）—— 矿池把挖矿收益打进来时，
    ///         合约自动按 serviceFeeBps 计提并按分成表切分，净额进 revenuePool。
    ///
    ///         为什么服务费必须上链（口径反转）：
    ///         之前服务费只是**前端本地记录**（issuanceRecords.js / fixtures.js），
    ///         链上既不收也不可查，用户看到的分配表可以随便改。
    ///         现在费率与分成表都存在链上，任何人可读、可验证。
    ///
    ///         @param bps_ Fee rate in basis points (1/10000). Hard-capped at MAX_SERVICE_FEE_BPS (10%).
    ///         @param recipients_ Fee recipients. Max MAX_FEE_RECIPIENTS. May be empty only if bps_ == 0.
    ///         @param sharesBps_ Per-recipient share in bps. Must sum to 10000. Same length as recipients_.
    function setServiceFee(uint16 bps_, address[] calldata recipients_, uint16[] calldata sharesBps_) external onlyOwner {
        if (serviceFeeSet) revert ServiceFeeAlreadySet();
        if (sold != 0) revert ServiceFeeLocked();
        if (bps_ > MAX_SERVICE_FEE_BPS) revert BadFeeConfig();
        if (recipients_.length != sharesBps_.length) revert BadFeeConfig();
        if (recipients_.length > MAX_FEE_RECIPIENTS) revert BadFeeConfig();
        if (bps_ == 0 && recipients_.length != 0) revert BadFeeConfig();
        if (bps_ != 0 && recipients_.length == 0) revert BadFeeConfig();

        uint256 sum = 0;
        for (uint256 i = 0; i < recipients_.length; i++) {
            if (recipients_[i] == address(0)) revert BadFeeConfig();
            if (sharesBps_[i] == 0) revert BadFeeConfig();
            for (uint256 j = 0; j < i; j++) {
                if (recipients_[j] == recipients_[i]) revert BadFeeConfig();
            }
            sum += sharesBps_[i];
        }
        if (sum != 10000) revert BadFeeConfig();

        serviceFeeBps = bps_;
        for (uint256 i = 0; i < recipients_.length; i++) {
            _feeRecipients.push(recipients_[i]);
            _feeSharesBps.push(sharesBps_[i]);
        }
        serviceFeeSet = true;
        emit ServiceFeeSet(bps_, recipients_, sharesBps_);
    }

    /// @notice Service-fee recipients, for the frontend to read the split table.
    function feeRecipientCount() external view returns (uint256) {
        return _feeRecipients.length;
    }

    function feeRecipientAt(uint256 index) external view returns (address) {
        if (index >= _feeRecipients.length) revert BadFeeConfig();
        return _feeRecipients[index];
    }

    function feeSharesBpsAt(uint256 index) external view returns (uint16) {
        if (index >= _feeSharesBps.length) revert BadFeeConfig();
        return _feeSharesBps[index];
    }

    /// @notice Total service fee accrued to `who` and not yet pulled.
    function pendingFeeOf(address who) external view returns (uint256) {
        return pendingFee[who];
    }

    /// @notice A fee recipient pulls its accrued service fee. Recipients may be contracts that reject
    ///         plain BNB, so the payment is push-with-fallback: on failure the amount stays in
    ///         pendingFee and the recipient can retry (or move to another address).
    function claimFee() external nonReentrant {
        uint256 amt = pendingFee[msg.sender];
        if (amt == 0) revert ZeroShares();
        pendingFee[msg.sender] = 0;
        totalPendingFee -= amt;
        if (!_trySend(msg.sender, amt)) {
            pendingFee[msg.sender] = amt;
            totalPendingFee += amt;
            revert TransferFailed();
        }
        totalFeesPaid += amt;
        emit FeePaid(msg.sender, amt);
    }

    /// @dev Split `gross` between the fee table and the revenue pool, and book each recipient's cut.
    ///      Returns the amount actually withheld as fee. Rounding dust (the sub-wei remainder of the
    ///      bps math) stays in the revenue pool, never in the fee — the fee is never over-charged.
    ///      Called when mining revenue lands in the round. No-op when no fee is configured.
    function _accrueServiceFee(uint256 gross) internal returns (uint256 fee) {
        if (serviceFeeBps == 0 || _feeRecipients.length == 0) return 0;
        uint256 grossFee = (gross * serviceFeeBps) / 10000;
        if (grossFee == 0) return 0;
        for (uint256 i = 0; i < _feeRecipients.length; i++) {
            uint256 cut = (grossFee * _feeSharesBps[i]) / 10000;
            if (cut == 0) continue;
            pendingFee[_feeRecipients[i]] += cut;
            totalPendingFee += cut;
            fee += cut;
            emit FeeAccrued(_feeRecipients[i], cut);
        }
    }

    // ─────────────────────────── refund (pull) ───────────────────────────

    /// @notice The subscriber pulls their principal. Nothing runs automatically at the deadline.
    ///         Allowed when the round never sold out and Funding is past its deadline, when Executing and
    ///         executionFailed, or when Executing/Buying and raisedBnb can no longer cover every share
    ///         (a partial fill was settled, with or without asking the leftover parts).
    ///         A full pool pays count × sharePriceBnb. A short pool pays pro-rata of raisedBnb.
    ///         A sold-out round cannot use the deadline path: buyers funded the parts purchase, not a refund.
    ///         Reverts if this wallet still has escrowed shares.
    ///
    ///         ⚠️ 「未售罄不许退款」的实现口径（主网前修复，H-1 后半）：
    ///         用户要求「在没有售罄前不允许退款」。字面照做会制造一个**新的 Critical**：
    ///         未售罄 + Funding 过期的期次是**唯一**能让认购人拿回本金的出口，
    ///         把它封掉等于把所有人的本金永久锁在合约里（owner 也扫不走：raisedBnb 还在）。
    ///         所以实现为「owner 的下单资格不受退款影响」，用两个变量分工：
    ///           - sold（单调，只增不减）= 本期卖出去过多少 → owner 的执行闸门只看它，
    ///             退款不再剥夺 owner 的下单资格（H-1 后半的真正病根）；
    ///           - outstandingShares（可减）= 还欠多少人 → 按比例退款的分母、_shortfall 的判据。
    ///         未售罄时本来就没有任何退款路径（scene 必须已经是 Executing，即已售罄），
    ///         唯一例外是 Funding 过期且未售罄 —— 那是本金出口，必须保留。
    function refund() external nonReentrant {
        bool execFailed = scene == Scene.Executing && executionFailed;
        bool short = scene == Scene.Executing && phase == Phase.Buying && _shortfall();
        // 未售罄的期次只保留一条本金出口：Funding 过了截止时间。
        // soldOutAt == 0 ⇔ 从未售罄（scene 转 Executing 的那一刻会写入它）。
        bool neverSoldOut = scene == Scene.Funding && soldOutAt == 0 && block.timestamp > fundingDeadline;
        if (!neverSoldOut && !execFailed && !short) revert RefundNotAvailable();

        // A failed send must revert the whole tx. Soft-fail would surface as ZeroShares.
        // 份额被清掉就算成功：池子相对份数太小时，按比例取整可能是 0，
        // 这时不该让持份人永远退不出来（份额永远归不了零 → outstandingShares 永远不归零 → 尾差永远锁死）。
        uint256 before = _shares[msg.sender];
        uint256 amount = _refundHolder(msg.sender, false);
        if (amount == 0 && _shares[msg.sender] == before) revert ZeroShares();
    }

    function _trackHolder(address who) internal {
        if (_holderSeen[who]) return;
        _holderSeen[who] = true;
        _holders.push(who);
    }

    /// @dev 统一写 phase 的入口，顺带发 PhaseChanged。
    ///      之前 phase 有 8 个写入点，只有部分路径发事件——
    ///      链下靠事件推导状态必然漏。现在所有写入都必须走这里。
    function _setPhase(Phase next) internal {
        uint8 previous = uint8(phase);
        phase = next;
        if (previous != uint8(next)) emit PhaseChanged(previous, uint8(next));
    }

    /// @dev Refund this wallet. Returns 0 if shares are 0, any shares are escrowed, or the pro-rata share rounds to 0.
    ///      A full pool pays count × price. A short pool pays raisedBnb × shares / sold pro-rata.
    ///      soft=true (openRefund): a failed send restores this wallet and is skipped.
    ///      soft=false: a failed send reverts the whole transaction.
    ///
    ///      ⚠️ 取整为 0 也要清份额（主网前修复）：
    ///      原来 `if (amount == 0) return 0;` 直接返回，**份额不清、sold 不减**。
    ///      后果是短池下按比例取整为 0 的持份人永远退不出来：
    ///        - 他的份额永远在 _shares 里 → sold 永远不归零；
    ///        - sold != 0 时 recoverBnb 不敢扫尾差（要留给持份人）；
    ///        - 于是这笔 BNB 被永久锁在合约里，谁也拿不走。
    ///      现在：份额照清、outstandingShares 照减，池子里的余量留给后面的持份人
    ///      （比例随 outstandingShares 变小而变大），最终由最后一位持份人按比例拿走，
    ///      取整尾差不再被锁死。
    ///
    ///      ⚠️ 分母用 outstandingShares 而不是 sold（主网前修复，H-1 后半）：
    ///      sold 改成单调的「历史事实」后退款不再递减它，用它做分母会把
    ///      「已经退出的人」也算进分母里 → 池子永远发不完，最后几位拿不到应得的钱。
    function _refundHolder(address who, bool soft) internal returns (uint256 amount) {
        uint256 s = _shares[who];
        if (s == 0 || _escrow[who] != 0 || outstandingShares == 0) return 0;
        // A full pool pays count × price. A short pool pays raise × shares / outstanding pro-rata.
        amount =
            raisedBnb >= outstandingShares * sharePriceBnb ? s * sharePriceBnb : (raisedBnb * s) / outstandingShares;
        _shares[who] = 0;
        outstandingShares -= s;
        if (amount == 0) {
            // Nothing to send, but the shares are settled: the holder is done and the pool keeps the dust
            // for the remaining holders (their pro-rata share grows as `outstandingShares` shrinks).
            emit Refunded(who, 0);
            return 0;
        }
        raisedBnb -= amount;
        if (!_trySend(who, amount)) {
            _shares[who] = s;
            outstandingShares += s;
            raisedBnb += amount;
            if (!soft) revert TransferFailed();
            emit RefundSendFailed(who, amount);
            return 0;
        }
        _refunded[who] += amount;
        totalRefunded += amount;
        emit Refunded(who, amount);
    }

    // ─────────────────────────── share transfer (Mining only) ───────────────────────────

    /// @notice Mining only. Moves shares into escrow. They stop being transferable until sold or cancelled.
    ///         Mining becomes reachable once the owner commits the parts via depositToPool().
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

    /// @notice Cancel your listing and unlock the shares. Seller or owner only.
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

    /// @notice Mining only. Moves shares from the seller's escrow to the buyer's _shares.
    ///         msg.value must equal count × price and is paid straight to the seller.
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
        _trackHolder(msg.sender);
        l.shares -= count;
        if (l.shares == 0) l.open = false;

        _send(l.seller, pay); // BNB paid to the seller immediately
        emit ListingTaken(id, msg.sender, l.seller, count, pay);
    }

    // ─────────────────────────── secondary-market bids (owner) ───────────────────────────

    /// @notice Place bids on the material market. NAND tokenId is 0, LATCH is 1. Owner only, phase must be Buying.
    ///         Uses the transistors address locked at create. `transistors_` must be address(0) or equal that address.
    ///         Escrow is debited from raisedBnb and sent with placeBid. A zero-qty leg is skipped and its bid id stays 0.
    ///         If cost > raisedBnb, sets executionFailed and returns. The tx does not revert and no bid is placed.
    ///         Only one market order at a time: an open ask must be cancelled first. A fully filled ask slot is cleared here.
    function placeTransistorOrder(
        address transistors_,
        uint256 nandQty_,
        uint96 nandPrice_,
        uint256 latchQty_,
        uint96 latchPrice_
    ) external onlyOwner nonReentrant {
        _requireExecuting();
        if (phase == Phase.Ready) revert AlreadyReady();
        if (phase == Phase.Listed) revert AlreadyListed();
        _purgeFilledAsk();
        if (_askOpen()) revert AlreadyAsked();
        if (transistors_ != address(0) && transistors_ != transistors) revert WrongTransistors();
        _requireLegParams(nandQty_, nandPrice_, latchQty_, latchPrice_);
        // 本期必须售罄过才允许下单。sold 是单调的，退款不会把它拉低，
        // 所以这个条件不会因为「有人退过款」而失效（H-1 后半）。
        if (sold < totalShares) revert NotSoldOutYet();
        // sold 现在是单调的「历史事实」：退款不会让它变小，所以这个闸门
        // 表达的是「本期必须售罄过」而不是「此刻没人退过款」（H-1 后半）。
        if (executionFailed && (sold < totalShares || raisedBnb == 0)) revert RefundNotAvailable();

        uint256 nandCost = nandQty_ * uint256(nandPrice_);
        uint256 latchCost = latchQty_ * uint256(latchPrice_);
        uint256 cost = nandCost + latchCost;
        if (cost > raisedBnb) {
            executionFailed = true;
            emit ExecutionFailed(cost, raisedBnb);
            return;
        }

        executionFailed = false;
        raisedBnb -= cost;
        nandQty = nandQty_;
        latchQty = latchQty_;
        nandPrice = nandPrice_;
        latchPrice = latchPrice_;
        priceLock = cost;
        nandBidId = _placeBidLeg(0, nandQty_, nandPrice_, nandCost);
        latchBidId = _placeBidLeg(1, latchQty_, latchPrice_, latchCost);
        _setPhase(Phase.Listed);
        // 每次下单都把非 owner 的 markFailed 宽限期推后。
        // 宽限期从「最后一次下单」算起，owner 一直在推进就不会被阻击者掐断。
        lastOrderAt = uint64(block.timestamp);
        emit TransistorOrderPlaced(nandQty_ + latchQty_, cost);
    }

    /// @notice Owner refunds every holder. Allowed in Buying, and in Ready once no ask is open.
    ///         Ready with a settled ask must confirmSale first (that pulls proceeds and returns to Buying).
    ///         Parts still held in Ready go back to the owner so a refund cannot strand them.
    function openRefund() external onlyOwner nonReentrant {
        _requireExecuting();
        // outstandingShares == 0 means every share already left: there is nobody left to refund. Revert instead of
        // mining a no-op transaction that emits nothing (the leftover dust is swept with recoverBnb).
        if (outstandingShares == 0) revert ZeroShares();
        if (phase == Phase.Listed) revert AlreadyListed();
        if (phase != Phase.Buying && phase != Phase.Ready) revert WrongScene();
        if (phase == Phase.Ready) {
            if (_askOpen() || _askRecorded() || _owed() > 0) revert AlreadyAsked();
            _returnHeldParts();
        } else {
            _purgeFilledAsk();
            if (_askOpen() || _owed() > 0) revert AlreadyAsked();
        }
        markFailed();
        _refundAll();
    }

    /// @notice Owner only. Give up on this round from Buying, Listed, or Ready: cancel the rest of the bid,
    ///         cancel open asks, return parts still held here, withdraw what the market owes, and refund holders.
    function abandonOrder() external onlyOwner nonReentrant {
        _requireExecuting();
        if (phase == Phase.Listed) {
            _cancelOpenLeg(nandBidId, nandQty);
            _cancelOpenLeg(latchBidId, latchQty);
            _clearOrder();
        }
        _setPhase(Phase.Buying);
        _cancelOpenAsk();
        _returnHeldParts();
        if (_owed() > 0) market.withdraw();
        markFailed();
        _refundAll();
    }

    function _refundAll() internal {
        uint256 n = _holders.length;
        for (uint256 i = 0; i < n; i++) {
            _refundHolder(_holders[i], true);
        }
    }

    /// @notice Cancel whatever is still open on the market, then return to Buying.
    ///         Owner only while nothing filled. Once any quantity filled, anyone may cancel the rest.
    ///         A fully filled order whose parts are already here cannot be cancelled.
    ///         cancelBid refunds the unfilled escrow into receive. Filled quantity stays spent.
    ///         Escrow must never be stranded, so anyone may also cancel a round removed from the factory registry
    ///         (its owner may no longer be around).
    function cancelTransistorOrder() external nonReentrant {
        if (phase != Phase.Listed) revert NotListed();
        bool touched = _filledSome(nandBidId, nandQty) || _filledSome(latchBidId, latchQty);
        if (orderFilled() && _partsOnHand()) revert OrderFilled();
        if (!touched && msg.sender != owner && !_retired()) revert NotOwner(msg.sender);
        _cancelOpenLeg(nandBidId, nandQty);
        _cancelOpenLeg(latchBidId, latchQty);
        _clearOrder();
        _setPhase(Phase.Buying);
        emit TransistorOrderCancelled();
    }

    /// @notice Anyone may call after FAIL_GRACE; the owner may call at any time.
    ///         Lets holders refund even when no owner is around: the live bid's escrow would otherwise stay
    ///         in the market, so a non-owner call first cancels the unfilled legs (escrow returns here via
    ///         receive() and is credited to raisedBnb). Only the bid is touched; the refund formula is unchanged.
    ///
    ///         ⚠️ 宽限期基准修正（主网前）：
    ///         原来非 owner 的宽限期从 `soldOutAt`（售罄时刻）算起，而且是**一次性的**。
    ///         两个后果：
    ///           1. 售罄 3 天后，任何地址都能把一个健康的执行期置为 executionFailed，
    ///              并取消 owner 正在挂的买单——owner 之后再也无法下单（见 placeTransistorOrder 的闸门）。
    ///              攻击成本 = 一次 1 份认购 + 等 3 天。
    ///           2. owner 重新下单会把 executionFailed 重置为 false，于是宽限期「复活」，
    ///              同样的阻击可以无限重复。
    ///         现在宽限期从「最后一次有意义的动作」算起，取 `soldOutAt`（售罄时刻）与
    ///         `lastOrderAt`（最后一次下单时刻）中的**较晚者**：
    ///           - 只用 lastOrderAt：售罄后从未下单时基准为 0，宽限期形同虚设；
    ///           - 只用 soldOutAt：owner 每次重新下单都会让 executionFailed 复活，阻击可无限重复。
    ///         取较晚者后，owner 每次下单都会把宽限期推后，而「售罄后迟迟不下单」也不再被立刻处死。
    function markFailed() public {
        if (scene != Scene.Executing || executionFailed) return;
        uint256 graceBase = uint256(lastOrderAt) > uint256(soldOutAt) ? uint256(lastOrderAt) : uint256(soldOutAt);
        if (msg.sender != owner && block.timestamp < graceBase + FAIL_GRACE) {
            revert RefundNotAvailable();
        }
        executionFailed = true; // CEI: set before the market callback; a revert below rolls it back with the tx.
        // Escape hatch: an untouched bid keeps its escrow in the market. Cancelling it puts the BNB back into
        // raisedBnb so holders refund against the real pool instead of a short one. If the market refuses the
        // cancel the tx reverts and markFailed can be retried later, rather than leaving escrow behind.
        if (phase == Phase.Listed) {
            _cancelOpenLeg(nandBidId, nandQty);
            _cancelOpenLeg(latchBidId, latchQty);
            _clearOrder();
            _setPhase(Phase.Buying);
            emit TransistorOrderCancelled();
        }
        emit ExecutionFailed(0, raisedBnb);
    }

    /// @notice List parts already held after the buy was confirmed (Ready).
    ///         Not available in Buying: a partial fill has to be cancelled or filled, then confirmed.
    ///         Reverts if any ask leg is still open. Approves the market once, then placeAsk for each non-zero leg.
    function placeTransistorAsk(
        uint256 nandQty_,
        uint96 nandPrice_,
        uint256 latchQty_,
        uint96 latchPrice_
    ) external onlyOwner nonReentrant {
        _requireExecuting();
        if (phase != Phase.Ready) revert TransistorsNotReady();
        _requireLegParams(nandQty_, nandPrice_, latchQty_, latchPrice_);
        _purgeFilledAsk();
        if (_askOpen()) revert AlreadyAsked();

        IERC1155 token = IERC1155(transistors);
        if (nandQty_ > 0 && token.balanceOf(address(this), 0) < nandQty_) revert InsufficientParts();
        if (latchQty_ > 0 && token.balanceOf(address(this), 1) < latchQty_) revert InsufficientParts();
        // Idempotent; skips the extra isApprovedForAll SLOAD/external call.
        token.setApprovalForAll(address(market), true);

        nandAskQty = nandQty_;
        latchAskQty = latchQty_;
        nandAskPrice = nandPrice_;
        latchAskPrice = latchPrice_;
        nandAskId = _placeAskLeg(0, nandQty_, nandPrice_);
        latchAskId = _placeAskLeg(1, latchQty_, latchPrice_);
        emit TransistorAskPlaced(nandQty_, latchQty_, nandAskId, latchAskId);
    }

    /// @notice Owner only. Cancel unsold ask remainder so parts return to this campaign.
    ///         Fully filled legs (remaining == 0) are skipped. Call withdrawMarketProceeds after fills.
    ///         A fully filled ask (remaining == 0) can be cleared here without touching the market.
    function cancelTransistorAsk() external onlyOwner nonReentrant {
        if (!_askRecorded()) revert NotAsked();
        _cancelOpenAsk();
        emit TransistorAskCancelled();
    }

    /// @notice Ask is fully filled, or its remainder was cancelled. Pulls owed BNB and returns to Buying,
    ///         which is the only phase that can place another bid or refund after a sale.
    function confirmSale() external onlyOwner nonReentrant {
        _requireExecuting();
        if (phase != Phase.Ready) revert WrongScene();
        if (_askOpen()) revert AlreadyAsked();
        uint256 owed = _owed();
        if (!_askRecorded() && owed == 0) revert NotAsked();
        if (owed > 0) market.withdraw();
        _clearAsk();
        _setPhase(Phase.Buying);
        emit AskSettled(owed);
    }

    /// @notice Pull ask / bid proceeds owed by the material market into raisedBnb (via receive).
    ///         Anyone may call. No-op when owed is 0.
    function withdrawMarketProceeds() external nonReentrant {
        if (_owed() == 0) return;
        market.withdraw();
    }

    /// @notice Anyone may call. Does not move tokens.
    ///         Moves Listed → Ready only when both legs have remaining == 0 and this contract holds the parts.
    ///         A zero-qty leg counts as filled.
    function confirmTransistors() external {
        _requireExecuting();
        if (phase == Phase.Ready) revert AlreadyReady();
        if (phase != Phase.Listed) revert NotListed();
        if (!orderFilled() || !_partsOnHand()) revert TransistorsNotReady();
        _setPhase(Phase.Ready);
        emit TransistorsConfirmed();
    }

    /// @notice True when the official book has fully filled this round's bids.
    function orderFilled() public view returns (bool) {
        return _legFilled(nandBidId, nandQty) && _legFilled(latchBidId, latchQty);
    }

    /// @notice Owner escape hatch: pull held parts out of this campaign. Not for normal flow —
    ///         it exists so parts are not stranded in the contract. Blocked while a bid is live (Listed) and
    ///         once the transistors have been committed to the mining pool (irreversible).
    ///         Recipient is always `owner`. Does not change the order, price lock, or scene.
    function recoverTransistors(address token, uint256 id, uint256 amount) external onlyOwner nonReentrant {
        if (phase == Phase.Listed) revert AlreadyListed();
        if (pooled) revert AlreadyPooled();
        if (token == address(0)) revert ZeroAddress();
        IERC1155(token).safeTransferFrom(address(this), owner, id, amount, "");
        emit TransistorsRecovered(token, id, amount, owner);
    }

    // ─────────────────────────── mining pool (commit) ───────────────────────────

    /// @notice Commit the round's transistors to the mining pool. IRREVERSIBLE.
    ///         Owner only, callable once the order is filled and the parts are on hand (phase Ready).
    ///         1. Transfers every held ERC1155 part (NAND id 0, LATCH id 1) to `miningPool`.
    ///         2. Returns any unspent subscription BNB to holders pro-rata (shares are kept), so the owner
    ///            cannot later sweep holder surplus via recoverBnb.
    ///         3. Sets `pooled = true` and moves the round into the Mining scene.
    ///         After this, recoverTransistors / refund / abandon / markFailed all revert (parts are gone and
    ///         the round is committed); the Mining scene is now reachable for the harvest() / claim() shells.
    ///         The pool contract must implement onERC1155Received; a failing receive reverts the whole tx.
    ///         Gas note: step 2 walks the whole holder list, so a round with tens of thousands of
    ///         holders can exceed the block gas limit and block the owner from pooling. See _holders.
    function depositToPool() external onlyOwner nonReentrant {
        if (pooled) revert AlreadyPooled();
        _requireExecuting();
        if (phase != Phase.Ready) revert TransistorsNotReady();
        if (miningPool == address(0)) revert PoolNotSet();
        if (!orderFilled() || !_partsOnHand()) revert TransistorsNotReady();

        IERC1155 token = IERC1155(transistors);
        uint256 nandAmt = token.balanceOf(address(this), 0);
        uint256 latchAmt = token.balanceOf(address(this), 1);
        if (nandAmt > 0) token.safeTransferFrom(address(this), miningPool, 0, nandAmt, "");
        if (latchAmt > 0) token.safeTransferFrom(address(this), miningPool, 1, latchAmt, "");

        pooled = true;
        _returnSurplus();
        scene = Scene.Mining;
        emit DepositedToPool(miningPool, nandAmt, latchAmt);
    }

    /// @notice PLACEHOLDER — BEM distribution is not implemented. Reachable after depositToPool() moves the
    ///         round into Mining; currently a no-op so the Mining scene and ABI stay stable.
    function harvest() external nonReentrant {
        if (scene != Scene.Mining) revert WrongScene();
    }

    /// @notice PLACEHOLDER — BEM distribution is not implemented. Reachable after depositToPool() moves the
    ///         round into Mining; currently returns 0 so the Mining scene and ABI stay stable.
    function claim() external nonReentrant returns (uint256) {
        if (scene != Scene.Mining) revert WrongScene();
        return 0;
    }

    /// @notice The mining pool deposits this round's mining revenue. Only the mining pool may call it.
    ///         This is the **only** place the service fee is ever collected on-chain
    ///         (口径：服务费 = 挖矿产出奖励的服务费，不是认筹款的服务费):
    ///           - fee = gross × serviceFeeBps / 10000, split across the on-chain recipient table;
    ///           - the rest goes to `revenuePool`, waiting for the distribution logic that lands with
    ///             the mining-pool interface (harvest()/claim() are still placeholders).
    ///         ⚠️ 认筹款（subscribe 付的 BNB）**不经过这里**，也不会被抽任何服务费：
    ///         它全额留在 raisedBnb 里，只用于买元件。
    ///         Rounding dust stays in revenuePool, so the fee is never over-charged.
    ///         The accrued fee is **pulled** by each recipient via claimFee(); it is never pushed, so a
    ///         recipient contract that rejects BNB cannot block the pool's revenue deposit.
    function depositRevenue() external payable nonReentrant {
        if (scene != Scene.Mining) revert WrongScene();
        if (msg.sender != miningPool) revert NotOwner(msg.sender);
        if (msg.value == 0) revert ZeroPrice();

        uint256 fee = _accrueServiceFee(msg.value);
        uint256 net = msg.value - fee;
        revenuePool += net;
        emit RevenueDeposited(msg.value, fee, net);
    }

    // ─────────────────────────── views ───────────────────────────
    // scene and phase already have public getters. Do not wrap them again.

    function sharesOf(address account) external view returns (uint256) {
        return _shares[account];
    }

    /// @notice Subscribers and listing buyers, in first-seen order. Share counts stay on sharesOf.
    function holderCount() external view returns (uint256) {
        return _holders.length;
    }

    function holderAt(uint256 index) external view returns (address) {
        return _holders[index];
    }

    function escrowOf(address account) external view returns (uint256) {
        return _escrow[account];
    }

    function refundedOf(address account) external view returns (uint256) {
        return _refunded[account];
    }

    function listingCount() external view returns (uint256) {
        return _listings.length;
    }

    /// @notice Listing detail by id. The frontend reads each id up to listingCount().
    function getListing(uint256 id) external view returns (address seller, uint256 shares, uint256 priceBnbPerShare, bool open) {
        if (id >= _listings.length) revert NoListing();
        Listing storage l = _listings[id];
        return (l.seller, l.shares, l.priceBnbPerShare, l.open);
    }

    // ─────────────────────────── internal ───────────────────────────

    /// @dev 把入池时未花出去的本金划成「按份分配的余款池」，**不再遍历持份人、不再逐笔转账**（C-4）。
    ///      为什么改 pull：原来这里全量遍历 _holders 并给每人转账，
    ///      每条约 35–45k gas（转账 21k + 冷 SLOAD），BSC 区块上限约 140M →
    ///      约 3,500–4,000 个持份人就顶满上限，owner 会被永久卡住无法入池。
    ///      现在只记录两个基准（分子 surplusPool、分母 surplusBase），
    ///      每个人自己调 claimSurplus() 时才按累计份额公式算出应得额。
    ///
    ///      累计份额公式（与「谁先领」无关，且最后一人自动拿走取整尾差）：
    ///        target = surplusPool × (已领份数累计 + 本人份数) / surplusBase
    ///        本人应得 = target − 已发放总额
    ///      所有人领完后 target = surplusPool，尾差自动归最后一人。
    function _returnSurplus() internal {
        uint256 pool = raisedBnb;
        if (pool == 0) return;
        surplusPool = pool;
        surplusBase = outstandingShares;
        surplusClaimedShares = 0;
        surplusAllocated = 0;
        surplusPaid = 0;
        // 本金池清零：这些钱现在由 surplusPool 记账，由 claimSurplus() 分发。
        // recoverBnb 的受保护金额会算上 surplusPool − surplusPaid，owner 扫不走。
        raisedBnb = 0;
    }

    /// @notice 领取入池时应得但还没领的余款。
    ///         两种来源：
    ///           1. 懒计算应得额（正常路径）：按 surplusPool / surplusBase 的累计份额公式算；
    ///           2. 之前 accrue 过但转账失败：这笔钱挂在 pendingSurplus 里，重试即可。
    ///         为什么必须有这条路径：入池后 refund() 永久关闭，
    ///         没有 claimSurplus 的话这笔钱会永远卡在合约里，owner 也扫不走。
    function claimSurplus() external nonReentrant {
        uint256 amt = pendingSurplus[msg.sender];
        if (amt == 0) {
            amt = _accrueSurplus(msg.sender);
            if (amt == 0) revert ZeroShares();
        }
        pendingSurplus[msg.sender] = 0;
        totalPendingSurplus -= amt;
        surplusPaid += amt;
        if (!_trySend(msg.sender, amt)) {
            // 还是发不出去：整个交易回滚，pendingSurplus 里的钱原样保留，
            // 持份人可以自己重试（或换地址 / 用智能合约钱包）。
            revert TransferFailed();
        }
        _refunded[msg.sender] += amt;
        totalRefunded += amt;
        emit Refunded(msg.sender, amt);
    }

    /// @dev 懒计算某人应得的余款，并把结果记账进 pendingSurplus。
    ///      每个持份人只会被计入一次（surplusCounted 记录他已计入的份数），
    ///      所以重复调用 claimSurplus 不会重复领钱。
    ///      取整尾差（pool 减去各人按份算出的总和）归最后一个计入满 base 的人。
    function _accrueSurplus(address who) internal returns (uint256 amt) {
        uint256 s = _shares[who];
        if (s == 0 || surplusBase == 0 || surplusPool == 0) return 0;
        uint256 already = surplusCounted[who];
        if (already >= s) return 0; // 已经计过份了
        uint256 newShares = s - already;
        // 防御：入池后份额若因异常变化超过基准，超出部分不再发放。
        if (surplusClaimedShares + newShares > surplusBase) {
            newShares = surplusBase - surplusClaimedShares;
            if (newShares == 0) return 0;
        }
        surplusCounted[who] = already + newShares;
        surplusClaimedShares += newShares;

        amt = (surplusPool * newShares) / surplusBase;
        // 最后一个计入满基准的人拿走**全部剩余**（含前面各人取整产生的尾差），
        // 保证 surplusPool 分毫不差地发完、也不会多发。
        if (surplusClaimedShares == surplusBase) {
            amt = surplusPool - surplusAllocated;
        }
        surplusAllocated += amt;
        pendingSurplus[who] += amt;
        totalPendingSurplus += amt;
        emit SurplusAccrued(who, amt);
    }

    /// @notice 某人当前可领取的余款（含还没记账的懒计算部分）。前端展示用。
    function surplusOf(address who) external view returns (uint256) {
        uint256 amt = pendingSurplus[who];
        if (amt != 0) return amt;
        uint256 s = _shares[who];
        if (s == 0 || surplusBase == 0 || surplusPool == 0) return 0;
        uint256 already = surplusCounted[who];
        if (already >= s) return 0;
        uint256 newShares = s - already;
        if (surplusClaimedShares + newShares > surplusBase) {
            newShares = surplusBase - surplusClaimedShares;
            if (newShares == 0) return 0;
        }
        uint256 out = (surplusPool * newShares) / surplusBase;
        if (surplusClaimedShares + newShares == surplusBase) {
            out = surplusPool - surplusAllocated;
        }
        return out;
    }

    /// @dev cancelOrder/abandonOrder have both finished before this runs, so the campaign owns no live order.
    ///      A caller that cannot receive ERC1155 must not block the refund: skip it and leave the parts here.
    function _returnHeldParts() internal {
        IERC1155 token = IERC1155(transistors);
        for (uint256 id = 0; id < 2; id++) {
            uint256 amount = token.balanceOf(address(this), id);
            if (amount == 0) continue;
            try token.safeTransferFrom(address(this), owner, id, amount, "") {} catch {}
        }
    }

    function _owed() internal view returns (uint256) {
        return market.owed(address(this));
    }

    function _requireExecuting() internal view {
        if (scene != Scene.Executing) revert WrongScene();
    }

    function _requireLegParams(uint256 nandQty_, uint96 nandPrice_, uint256 latchQty_, uint96 latchPrice_) internal pure {
        if (nandQty_ == 0 && latchQty_ == 0) revert ZeroShares();
        if ((nandQty_ > 0 && nandPrice_ == 0) || (latchQty_ > 0 && latchPrice_ == 0)) revert ZeroPrice();
    }

    function _placeBidLeg(uint8 tokenId, uint256 qty, uint96 price, uint256 cost) internal returns (uint256 id) {
        if (qty == 0) return 0;
        id = market.placeBid{value: cost}(transistors, tokenId, price, qty);
        if (id == 0) revert BadBidId();
    }

    /// @dev A zero id would make _askOpen() read remaining 0 and silently unlock a second order.
    function _placeAskLeg(uint8 tokenId, uint256 qty, uint96 price) internal returns (uint256 id) {
        if (qty == 0) return 0;
        id = market.placeAsk(transistors, tokenId, price, qty);
        if (id == 0) revert BadAskId();
    }

    function _legFilled(uint256 id, uint256 qty) internal view returns (bool) {
        return qty == 0 || _remaining(id) == 0;
    }

    /// @dev True when the seller has taken at least one unit, including a leg whose remaining is already 0.
    function _filledSome(uint256 id, uint256 qty) internal view returns (bool) {
        return qty != 0 && _remaining(id) < qty;
    }

    /// @dev Cancel the unfilled remainder. A filled leg (remaining == 0) is left alone; cancelBid would revert.
    function _cancelOpenLeg(uint256 id, uint256 qty) internal {
        if (qty != 0 && id != 0 && _remaining(id) != 0) market.cancelBid(id);
    }

    /// @dev True when raised BNB can no longer repay every outstanding share at the subscription price.
    function _shortfall() internal view returns (bool) {
        // outstandingShares == 0 is the settled state: refund() must still go through to tell the caller it already left.
        return raisedBnb < outstandingShares * sharePriceBnb;
    }

    /// @dev Parts for the live order are in this contract. Token id 0 is NAND, 1 is LATCH.
    function _partsOnHand() internal view returns (bool) {
        IERC1155 token = IERC1155(transistors);
        return (nandQty <= token.balanceOf(address(this), 0)) && (latchQty <= token.balanceOf(address(this), 1));
    }

    function _remaining(uint256 id) internal view returns (uint256 remaining) {
        if (id == 0) return 0;
        (,,,,, remaining) = market.bids(id);
    }

    function _clearOrder() internal {
        // transistors stays: locked at create for this round's processor parts contract.
        // Bid ids and unit prices are only read back through the market; keeping them buys nothing but bytes.
        // The ids are zeroed too: a stale id must not look like a live order (readers gate on id != 0).
        nandBidId = latchBidId = 0;
        nandQty = latchQty = 0;
        priceLock = 0;
    }

    function _askRecorded() internal view returns (bool) {
        return (nandAskQty | latchAskQty) != 0;
    }

    /// @dev Drop ask storage once every leg has filled, so no ghost order shows up in the UI.
    function _purgeFilledAsk() internal {
        if (!_askOpen()) _clearAsk();
    }

    function _askOpen() internal view returns (bool) {
        return (nandAskQty > 0 && _askRemaining(nandAskId) > 0)
            || (latchAskQty > 0 && _askRemaining(latchAskId) > 0);
    }

    function _askRemaining(uint256 id) internal view returns (uint256 remaining) {
        if (id == 0) return 0;
        (,,,, remaining) = market.asks(id);
    }

    /// @dev Cancel both open ask legs and drop the record. Fully filled legs are skipped.
    function _cancelOpenAsk() internal {
        uint256 a = nandAskId;
        uint256 b = latchAskId;
        _clearAsk();
        if (_askRemaining(a) != 0) market.cancelAsk(a);
        if (_askRemaining(b) != 0) market.cancelAsk(b);
    }

    function _clearAsk() internal {
        nandAskId = latchAskId = nandAskQty = latchAskQty = 0;
        nandAskPrice = 0;
        latchAskPrice = 0;
    }

    /// @dev Official fillBid uses ERC1155 safeTransfer. The caller is not checked; the hook only returns the receiver selector.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    /// @notice 批量交割钩子。
    /// @dev 官方市场如果用 safeBatchTransferFrom 一次交付 NAND + LATCH，
    ///      缺这个函数会让整笔交付 revert——而市场侧可能已经先扣掉了 remaining，
    ///      于是 _partsOnHand() 永远为 false，confirmTransistors / depositToPool 永久 revert，
    ///      同时 raisedBnb 已在下单时被扣减，用户的本金和已成交的元件同时被困。
    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    /// @notice ERC165 接口声明。
    /// @dev 缺这个函数，部分标准实现会拒绝与本合约交互（safeTransferFrom 前置检查）。
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC165
            interfaceId == 0xd9b67a26 || // ERC1155
            interfaceId == 0x4e2312e0 || // ERC1155MetadataURI
            interfaceId == 0x780e9d63; // ERC1155Batch
    }

    /// @notice Owner escape while Executing. Rewrites phase so a stuck round can reach refund or recover.
    ///         Does not move tokens and does not cancel a market order.
    ///         Listed is refused: cancel or abandon that bid first, or its escrow stays on the market.
    ///         0 None, 1 Buying, 2 Listed, 3 Ready.
    ///
    ///         ⚠️ 加严说明（主网前）：
    ///         原来这个函数只校验 `next <= Ready` 与「当前不是 Listed」，
    ///         owner 可以不挂任何单直接把 phase 推到 Ready——而 Ready 的语义是
    ///         「元件已到账」。推过去之后 confirmTransistors / depositToPool 的前置检查
    ///         会被绕过（空数量时 orderFilled / _partsOnHand 都恒为 true），
    ///         期次可以零采购进入 Mining，之后退款 / 撤单 / 找回全部永久关闭。
    ///         而且它**不发事件**，事后无法证明期次是被人为推过去的。
    ///
    ///         现在：
    ///           - 进入 Ready 必须真的满足「买单已吃完 + 元件已到账」——
    ///             这是唯一被封锁的方向，因为 Ready 蕴含「元件已到账」这个不变量；
    ///           - 其余方向（Ready → Buying 等）保持可用，那是元件找回 / 退款清算的逃生路径，
    ///             封掉它等于把 owner 密钥丢失变成用户的永久损失；
    ///           - 每次变更都发 PhaseChanged。
    function setPhase(uint8 next) external onlyOwner {
        if (scene != Scene.Executing) revert WrongScene();
        if (phase == Phase.Listed) revert AlreadyListed();
        if (next > uint8(Phase.Ready)) revert WrongScene();
        // Ready = 元件已到账。这个不变量必须由数据说话，不能由 owner 一句话写进去。
        // 其他方向不设限：Ready → Buying 是元件找回与退款清算的逃生路径。
        if (next == uint8(Phase.Ready) && !(orderFilled() && _partsOnHand())) {
            revert TransistorsNotReady();
        }
        uint8 previous = uint8(phase);
        phase = Phase(next);
        if (previous != next) emit PhaseChanged(previous, next);
    }

    /// @notice Owner escape hatch: sweep BNB that no share is entitled to. Not for normal flow —
    ///         it exists so dust is not stranded in the contract. Recipient is always `owner`.
    ///         No amount argument: one call moves everything that is safe to move.
    ///         While shares are still outstanding (Funding / Executing) only the excess over raisedBnb leaves,
    ///         so subscription escrow stays put. Once every share has left (outstandingShares == 0), the whole
    ///         balance leaves and raisedBnb is zeroed.
    function recoverBnb() external onlyOwner nonReentrant {
        uint256 amount = address(this).balance;
        // 三笔钱永远不是 owner 的：
        //   - raisedBnb：认购托管池（还有份没结清时）
        //   - 未领取的余款（totalPendingSurplus）
        //   - 未领取的服务费（totalPendingFee）与挖矿收益池（revenuePool）
        // 少了任何一条，owner 就能把持份人/收款方的钱扫走。
        uint256 reserved = totalPendingFee + revenuePool;
        // 未发放的余款：surplusPool 减去已经真正转出去的部分。
        // 注意 totalPendingSurplus 是 surplusPool 的子集（已计提未转账），不能再加一次，否则重复预留。
        if (surplusPool > surplusPaid) reserved += surplusPool - surplusPaid;
        if (outstandingShares == 0) {
            // 所有份额已结清 → 托管池释放，全部余额归 owner（但上面 reserved 的钱要留下）。
            if (amount <= reserved) revert ZeroShares();
            amount -= reserved;
            raisedBnb = 0;
        } else {
            // 仍有未结清的份额 → 只有超出托管池（raisedBnb，已包含待领取余款）的部分可扫。
            uint256 keep = raisedBnb + reserved;
            if (amount <= keep) revert ZeroShares();
            amount -= keep;
        }
        if (amount == 0) revert ZeroShares();
        _send(owner, amount);
        emit BnbRecovered(amount, owner);
    }

    function _trySend(address to, uint256 amount) internal returns (bool ok) {
        (ok, ) = to.call{value: amount}("");
    }

    function _send(address to, uint256 amount) internal {
        if (!_trySend(to, amount)) revert TransferFailed();
    }
}
