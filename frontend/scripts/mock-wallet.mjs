/**
 * 探针用：给页面注入一个假的 EIP-1193 钱包。
 *
 * 为什么需要：T-64 起「Owner 工作台」只对 Owner 展示，判定依据是
 * **已连接钱包地址**（与 factory owner / 本期 Campaign owner 比对）。
 * 探针跑在没有真实钱包的浏览器里，不注入就永远拿不到 Owner 身份，
 * 也就点不到 Owner 工作台。
 *
 * 用法：
 *   const page = await browser.newPage();
 *   await installWallet(page, OWNER_ADDRESS);   // 或任意地址
 *   await page.goto(BASE);
 *
 * 注意：必须在 goto 之前调用（addInitScript 在页面脚本前执行）。
 * 应用读链走公共节点，不经过钱包，所以这里的 provider 只需覆盖
 * 账户/链 ID 查询；签名类方法故意抛错，避免误以为能发交易。
 */

/** 部署者地址 = 链上工厂 owner（deployments.json 的 deployer） */
export const OWNER_ADDRESS = "0xebA1B24d36487a75C533233A07D6899a268Bb9AA";
/** 任意非 Owner 地址（未持份） */
export const STRANGER_ADDRESS = "0x00000000000000000000000000000000DEAD01";

/**
 * 注入假钱包。
 * @param {import("playwright").Page} page
 * @param {string} address 钱包地址
 * @param {number} chainId 链 ID（默认 BSC 主网 56）
 */
export async function installWallet(page, address = OWNER_ADDRESS, chainId = 56) {
  await page.addInitScript(([addr, cid]) => {
    const hex = "0x" + Number(cid).toString(16);
    const provider = {
      isMetaMask: true,
      request: async ({ method }) => {
        switch (method) {
          case "eth_accounts":
          case "eth_requestAccounts":
            return [addr];
          case "eth_chainId":
            return hex;
          case "net_version":
            return String(cid);
          case "wallet_getPermissions":
            return [{ parentCapability: "eth_accounts" }];
          default:
            // 读链一律走公共节点；这里只处理账户相关请求。
            return null;
        }
      },
      on() {},
      removeListener() {},
    };
    window.ethereum = provider;
    window.ethereum.providers = [provider];
  }, [address, chainId]);
}
