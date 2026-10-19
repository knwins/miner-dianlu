import fs from "fs";
const s = fs.readFileSync(process.env.TEMP + "/tapeout-index.js", "utf8");
for (const k of ["function Wm", "Wm=", "const Wm", "function y0", "function cN", "function el("]) {
  const i = s.indexOf(k);
  console.log("\n====", k, i);
  if (i >= 0) console.log(s.slice(i, i + 700));
}
