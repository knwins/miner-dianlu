/**
 * 期次切换（上一期 / 下拉 / 下一期）。
 *
 * 单独成模块是因为它同时出现在「挖矿份额转让」「BEM挖矿认筹」的页头
 * 和「合约工作台 · 高级配置」里：同一套交互只能有一份实现，否则三处会慢慢走偏。
 * 入参 `periods` 是链上期次列表（chain.campaigns），`currentId` 是当前期号。
 */
import { useEffect, useRef, useState } from "react";

export default function PeriodNav({ periods, currentId, onSwitch }) {
  const ordered = [...(periods || [])]
    .filter((item) => item && item.address)
    .sort((a, b) => Number(a.id) - Number(b.id));
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!ordered.length || !onSwitch) return null;
  const index = ordered.findIndex((item) => String(item.id) === String(currentId));
  const current = index >= 0 ? ordered[index] : null;
  const prev = index > 0 ? ordered[index - 1] : null;
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;
  const go = (row) => {
    setOpen(false);
    if (row && String(row.id) !== String(currentId)) onSwitch(row.address);
  };
  return (
    <div className={`period-nav${open ? " is-open" : ""}`} ref={rootRef} aria-label="切换期次">
      <button className="period-nav-btn" type="button" aria-label="上一期" disabled={!prev} onClick={() => go(prev)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <path d="M14.5 6.5 9 12l5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        className="period-nav-current"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        第 {current ? current.id : "—"} 期
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button className="period-nav-btn" type="button" aria-label="下一期" disabled={!next} onClick={() => go(next)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <path d="M9.5 6.5 15 12l-5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <ul className="period-menu" role="listbox">
          {ordered.map((item) => {
            const on = String(item.id) === String(currentId);
            /*
             * 下拉里不画认购状态徽标：一是与「第 N 期」同排太挤，
             * 二是「成交」在电路市场另有含义（电路成交），摆在期次旁容易被读成
             * 「本期电路已买到」。要看去期次本身的主状态徽标与资产列表。
             */
            return (
              <li key={item.address}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={on ? "is-on" : ""}
                  onClick={() => go(item)}
                >
                  <span>第 {item.id} 期</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
