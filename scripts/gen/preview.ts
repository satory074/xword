// 目視確認用 preview.html（答え入り）。
import { cellIndex, SIZE } from "../../src/lib/grid";
import type { GeneratedPuzzle } from "./generate";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderPreview(puzzles: GeneratedPuzzle[]): string {
  const blocks = puzzles.map((p) => {
    const numAt = new Map<number, number>();
    for (const s of p.spec.slots) numAt.set(cellIndex(s.r, s.c), s.num);
    let table = "<table class=grid>";
    for (let r = 0; r < SIZE; r++) {
      table += "<tr>";
      for (let c = 0; c < SIZE; c++) {
        const i = cellIndex(r, c);
        const ch = p.solution[i]!;
        if (ch === "#") table += "<td class=b></td>";
        else table += `<td><span class=n>${numAt.get(i) ?? ""}</span>${esc(ch)}</td>`;
      }
      table += "</tr>";
    }
    table += "</table>";
    const list = (dir: "A" | "D") =>
      p.spec.slots
        .filter((s) => s.dir === dir)
        .map((s) => `<li><b>${s.num}</b> ${esc(s.clue)} <span class=a>— ${esc(p.answers[s.id]!)}</span></li>`)
        .join("");
    const warn = p.warnings.length ? `<ul class=warn>${p.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "";
    return `<section><h2>${p.date} <small>${esc(p.template)} / seed ${p.seed} / nodes ${p.nodes}</small></h2>
      <div class=row>${table}<div><h3>ヨコのカギ</h3><ol class=clues>${list("A")}</ol><h3>タテのカギ</h3><ol class=clues>${list("D")}</ol></div></div>${warn}</section>`;
  });
  return `<!doctype html><html lang=ja><meta charset=utf-8><title>xword preview</title>
<style>
body{font-family:system-ui,sans-serif;margin:1.5rem;color:#222}section{margin-bottom:2.5rem;border-bottom:1px solid #ddd;padding-bottom:1.5rem}
.row{display:flex;gap:2rem;flex-wrap:wrap}.grid{border-collapse:collapse}.grid td{width:40px;height:40px;border:1px solid #333;text-align:center;font-size:20px;position:relative}
.grid td.b{background:#222}.grid .n{position:absolute;left:2px;top:0;font-size:10px;color:#666}
.clues{list-style:none;padding:0;margin:0 0 1rem;font-size:14px}.clues li{margin:.15rem 0}.a{color:#888}
h2 small{font-weight:normal;color:#888;font-size:.7em}.warn{color:#b35c00;font-size:13px}
</style><h1>xword preview（${puzzles.length} 問）</h1>${blocks.join("")}</html>`;
}
