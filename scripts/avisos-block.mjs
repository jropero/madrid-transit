// Inner HTML of the `contAvisosInfo` block of a CRTM "Avisos" page, or null without it. Same
// logic as avisos_block() in public/rt.php (the block is followed by a <style> element).
export const AVISOS_MAX = 65536;

export function avisosBlock(page) {
  const open = page.indexOf('class="contAvisosInfo"');
  const gt = open < 0 ? -1 : page.indexOf('>', open);
  if (gt < 0) return null;
  const end = page.indexOf('<style', gt + 1);
  const inner = page.slice(gt + 1, end < 0 ? undefined : end).trimEnd();
  return inner
    .replace(/<\/div>$/, '')
    .trim()
    .slice(0, AVISOS_MAX);
}

console.assert(
  avisosBlock('<div class="contAvisosInfo">\n <div>a</div>\n</div>\n<style>x</style>') ===
    '<div>a</div>' && avisosBlock('<p>x</p>') === null,
  'avisosBlock cuts the block',
);
