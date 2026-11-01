// 目視確認用 preview.html（答え入り）。カギのレベル ①②③、難語、片方向マス（網掛け）を表示する。
//   公平性の確認: ③ が網掛けマスを持つ語に付いていないこと、難語同士・③同士が交差していないこと。
import { cellIndex, cellSlotMap, deriveSlots, SIZE } from "../../src/lib/grid";
import type { GeneratedPuzzle } from "./generate";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const LV_MARK = ["", "①", "②", "③"];

export function renderPreview(puzzles: GeneratedPuzzle[]): string {
  const blocks = puzzles.map((p) => {
    const slots = deriveSlots(p.spec.grid);
    const cellMap = cellSlotMap(slots);
    const numAt = new Map<number, number>();
    for (const s of p.spec.slots) numAt.set(cellIndex(s.r, s.c), s.num);
    const hard = new Set(p.hard ?? []);
    let table = "<table class=grid>";
    for (let r = 0; r < SIZE; r++) {
      table += "<tr>";
      for (let c = 0; c < SIZE; c++) {
        const i = cellIndex(r, c);
        const ch = p.solution[i]!;
        if (ch === "#") table += "<td class=b></td>";
        else {
          const cls = (cellMap.get(i)?.length ?? 0) < 2 ? " class=u" : "";
          table += `<td${cls}><span class=n>${numAt.get(i) ?? ""}</span>${esc(ch)}</td>`;
        }
      }
      table += "</tr>";
    }
    table += "</table>";
    const list = (dir: "A" | "D") =>
      p.spec.slots
        .filter((s) => s.dir === dir)
        .map((s) => {
          const lv = p.levels?.[s.id] ?? 1;
          const h = hard.has(s.id) ? " <sup class=h>難</sup>" : "";
          return `<li><b>${s.num}</b> <span class="lv lv${lv}">${LV_MARK[lv]}</span> ${esc(s.clue)} <span class=a>— ${esc(p.answers[s.id]!)}${h}</span></li>`;
        })
        .join("");
    const warn = p.warnings.length ? `<ul class=warn>${p.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "";
    const mix = p.mix ? ` / ①${p.mix[1]} ②${p.mix[2]} ③${p.mix[3]} 難語 ${hard.size}` : "";
    return `<section><h2>${p.date} <small>${esc(p.template)} / algo ${esc(p.algo)} / seed ${p.seed} / nodes ${p.nodes}${mix}</small></h2>
      <div class=row>${table}<div><h3>ヨコのカギ</h3><ol class=clues>${list("A")}</ol><h3>タテのカギ</h3><ol class=clues>${list("D")}</ol></div></div>${warn}</section>`;
  });
  return `<!doctype html><html lang=ja><meta charset=utf-8><title>xword preview</title>
<style>
body{font-family:system-ui,sans-serif;margin:1.5rem;color:#222}section{margin-bottom:2.5rem;border-bottom:1px solid #ddd;padding-bottom:1.5rem}
.row{display:flex;gap:2rem;flex-wrap:wrap}.grid{border-collapse:collapse}.grid td{width:40px;height:40px;border:1px solid #333;text-align:center;font-size:20px;position:relative}
.grid td.b{background:#222}.grid td.u{background:#f1eee6}.grid .n{position:absolute;left:2px;top:0;font-size:10px;color:#666}
.clues{list-style:none;padding:0;margin:0 0 1rem;font-size:14px}.clues li{margin:.15rem 0}.a{color:#888}
.lv{font-size:12px}.lv2{color:#2a6fb8}.lv3{color:#b8322a;font-weight:bold}.h{color:#b8322a;font-size:10px}
h2 small{font-weight:normal;color:#888;font-size:.7em}.warn{color:#b35c00;font-size:13px}
</style><h1>xword preview（${puzzles.length} 問）</h1><p style="color:#666;font-size:13px">① 直接 ② ひとひねり ③ ひねり（完全交差の語のみ）／網掛け = 片方向マス／難 = difficulty 2 以上</p>${blocks.join("")}</html>`;
}
