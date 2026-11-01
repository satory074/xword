// 完答後の共有テキスト（答えを含めない）。
import { fmtDuration } from "./date";

export interface ShareInput {
  date: string;
  durationSec: number;
  checks: number;
  reveals: number;
  streak: number;
  url: string;
}

export function shareText(s: ShareInput): string {
  const lines = [`xword ${s.date} ✅ ${fmtDuration(s.durationSec)}`];
  const extras: string[] = [];
  if (s.checks > 1) extras.push(`答え合わせ ${s.checks} 回`);
  if (s.reveals > 0) extras.push(`ヒント ${s.reveals} 語`);
  if (s.streak > 1) extras.push(`🔥 ${s.streak} 日連続`);
  if (extras.length) lines.push(extras.join(" / "));
  lines.push(s.url);
  return lines.join("\n");
}
