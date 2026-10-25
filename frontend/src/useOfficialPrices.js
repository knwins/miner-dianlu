/**
 * 官方电路市价钩子。
 *
 * 读链上电路市场的活跃挂单，解析成按电路集合 id 归位的市价表，
 * 并把官方价合并进现有 quote 快照（链上 Campaign 的成交单价仍可覆盖它）。
 *
 * 失败不抛错：市价是辅助信息，拉不到就退回静态基准价，页面照常用。
 */
import { useEffect, useState } from "react";
import { fetchOfficialPrices, officialQuote } from "./officialPrices.js";
import { QUOTE } from "./fixtures.js";

/** 轮询间隔：官方站点自己也是分钟级刷新，跟着这个节奏足够 */
const POLL_MS = 60_000;

export function useOfficialPrices(baseQuote = QUOTE) {
  const [official, setOfficial] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async (force) => {
      const data = await fetchOfficialPrices({ force });
      if (cancelled) return;
      setOfficial(data);
      setLoading(false);
    };
    load(false);
    const timer = setInterval(() => load(false), POLL_MS);
    // 页面重新可见时补一次，避免后台标签页停更后回来还是旧价
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") load(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  /** 合并后的报价快照：官方价覆盖静态基准，链上单价可再覆盖官方价 */
  const quote = official?.ok ? officialQuote(baseQuote, official) : baseQuote;

  return {
    quote,
    official,
    loading,
    /** 某个电路集合的官方最低挂单价（BNB/张），没有则 null */
    priceOf(id) {
      const row = official?.prices?.[id];
      if (!row) return null;
      const p = row.ask != null ? row.ask : row.last != null ? row.last : row.bid;
      return p != null && p > 0 ? p : null;
    },
  };
}
